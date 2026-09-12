import { PoolClient } from "pg";
import { getPool } from "./db";

export interface MemoryActivityEvent {
  id: string;
  workspaceId: string;
  eventType: string;
  resourceType: string;
  resourceId: string | null;
  payload: Record<string, unknown>;
  occurredAt: string;
}

function eventFromRow(row: any): MemoryActivityEvent {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    eventType: row.event_type,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    payload: row.payload ?? {},
    occurredAt: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : String(row.occurred_at),
  };
}

export class MemoryObserver {
  private listener: PoolClient | null = null;
  private readonly subscribers = new Set<(event: MemoryActivityEvent) => void>();

  async start(): Promise<void> {
    if (this.listener) return;
    this.listener = await getPool().connect();
    await this.listener.query("listen memory_activity");
    this.listener.on("notification", (message) => {
      if (message.channel !== "memory_activity" || !message.payload) return;
      void this.publish(message.payload);
    });
    this.listener.on("error", () => {
      this.listener?.release();
      this.listener = null;
      setTimeout(() => void this.start().catch(() => undefined), 1000).unref();
    });
  }

  async snapshot(workspaceId?: string): Promise<Record<string, unknown>> {
    const filter = workspaceId ? "where n.workspace_id = $1" : "";
    const values = workspaceId ? [workspaceId] : [];
    const [workspaces, nodes, edges, sources, events] = await Promise.all([
      getPool().query(`select id, name from workspaces ${workspaceId ? "where id = $1" : ""} order by name`, values),
      getPool().query(`select n.id, n.workspace_id, n.content, n.summary, n.status, n.confidence, n.importance,
        n.observed_at, n.valid_from, n.valid_until, n.created_by, n.metadata, n.created_at, n.updated_at
        from memory_nodes n ${filter} order by n.updated_at desc`, values),
      getPool().query(`select e.id, e.workspace_id, e.from_memory_id, e.to_memory_id, e.relation_label,
        e.explanation, e.confidence, e.valid_from, e.valid_until, e.metadata, e.created_at
        from memory_edges e ${workspaceId ? "where e.workspace_id = $1" : ""} order by e.created_at desc`, values),
      getPool().query(`select s.*, n.workspace_id from memory_sources s join memory_nodes n on n.id = s.memory_id
        ${workspaceId ? "where n.workspace_id = $1" : ""} order by s.created_at desc`, values),
      getPool().query(`select * from memory_activity_events ${workspaceId ? "where workspace_id = $1" : ""}
        order by occurred_at desc limit 250`, values),
    ]);
    return {
      workspaces: workspaces.rows,
      nodes: nodes.rows,
      edges: edges.rows,
      sources: sources.rows,
      events: events.rows.map(eventFromRow),
    };
  }

  subscribe(callback: (event: MemoryActivityEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  private async publish(id: string): Promise<void> {
    const result = await getPool().query("select * from memory_activity_events where id = $1", [id]);
    const row = result.rows[0];
    if (!row) return;
    const event = eventFromRow(row);
    for (const subscriber of this.subscribers) subscriber(event);
  }
}
