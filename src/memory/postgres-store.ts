import { randomUUID } from "node:crypto";
import { PoolClient } from "pg";
import {
  MeetingRecord,
  MeetingSignal,
  MeetingState,
  MemoryMutationProposal,
  ProposedActionRecord,
  RequestContext,
  RetrievedEvidence,
  TranscriptSegment,
} from "../contracts";
import { getPool, withTransaction } from "../db";
import {
  AddSegmentInput,
  CreateMeetingInput,
  EMPTY_MEETING_STATE,
  MemoryJob,
  MemoryStore,
  MutationResult,
  RetrievalInput,
} from "./store";

function json<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }
  return value as T;
}

function iso(value: unknown): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function mapMeeting(row: any): MeetingRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    startedAt: iso(row.started_at)!,
    endedAt: iso(row.ended_at),
    participants: json(row.participants, []),
    status: row.status,
    rollingSummary: row.rolling_summary,
    state: json(row.live_state, EMPTY_MEETING_STATE),
    interventionCount: row.intervention_count,
  };
}

function mapAction(row: any): ProposedActionRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    meetingId: row.meeting_id,
    memoryId: row.memory_id,
    actionType: row.action_type,
    proposal: json(row.proposal, {}),
    preview: json(row.preview, {}),
    status: row.status,
    idempotencyKey: row.idempotency_key,
    result: row.result ? json(row.result, {}) : null,
    error: row.error,
  };
}

export class PostgresMemoryStore implements MemoryStore {
  async createMeeting(input: CreateMeetingInput): Promise<MeetingRecord> {
    const id = input.id ?? randomUUID();
    const state: MeetingState = { ...EMPTY_MEETING_STATE, participants: input.participants };
    const result = await getPool().query(
      `insert into meetings
        (id, workspace_id, title, participants, created_by, metadata, live_state)
       values ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7::jsonb)
       on conflict (id) do update set id = excluded.id
       returning *`,
      [id, input.workspaceId, input.title, JSON.stringify(input.participants), input.userId,
        JSON.stringify(input.metadata ?? {}), JSON.stringify(state)],
    );
    return mapMeeting(result.rows[0]);
  }

  async getMeeting(context: RequestContext, meetingId: string): Promise<MeetingRecord | null> {
    const result = await getPool().query(
      `select m.* from meetings m
       join workspace_members wm on wm.workspace_id = m.workspace_id and wm.user_id = $3
       where m.id = $1 and m.workspace_id = $2`,
      [meetingId, context.workspaceId, context.userId],
    );
    return result.rows[0] ? mapMeeting(result.rows[0]) : null;
  }

  async endMeeting(context: RequestContext, meetingId: string): Promise<MeetingRecord> {
    const result = await getPool().query(
      `update meetings m set status = 'ended', ended_at = coalesce(ended_at, now())
       from workspace_members wm
       where m.id = $1 and m.workspace_id = $2 and wm.workspace_id = m.workspace_id and wm.user_id = $3
       returning m.*`,
      [meetingId, context.workspaceId, context.userId],
    );
    if (!result.rows[0]) throw new Error("MEETING_NOT_FOUND_OR_FORBIDDEN");
    return mapMeeting(result.rows[0]);
  }

  async saveMeetingState(context: RequestContext, meetingId: string, state: MeetingState, increment = false): Promise<void> {
    const result = await getPool().query(
      `update meetings m set live_state = $4::jsonb, rolling_summary = $5,
          intervention_count = intervention_count + case when $6 then 1 else 0 end
       from workspace_members wm
       where m.id = $1 and m.workspace_id = $2 and wm.workspace_id = m.workspace_id and wm.user_id = $3`,
      [meetingId, context.workspaceId, context.userId, JSON.stringify(state), state.rollingSummary, increment],
    );
    if (!result.rowCount) throw new Error("MEETING_NOT_FOUND_OR_FORBIDDEN");
  }

  async addFinalSegment(input: AddSegmentInput): Promise<TranscriptSegment> {
    const result = await getPool().query(
      `insert into transcript_segments
        (id, meeting_id, sequence, speaker_id, text, started_at, ended_at, is_final, metadata)
       values ($1, $2, $3, $4, $5, $6, $7, true, $8::jsonb)
       on conflict (meeting_id, sequence) do update set meeting_id = excluded.meeting_id
       returning *`,
      [input.id ?? randomUUID(), input.meetingId, input.sequence, input.speakerId, input.text,
        input.startedAt ?? null, input.endedAt ?? null, JSON.stringify(input.metadata ?? {})],
    );
    const row = result.rows[0];
    return {
      id: row.id, meetingId: row.meeting_id, sequence: Number(row.sequence), speakerId: row.speaker_id,
      text: row.text, startedAt: iso(row.started_at), endedAt: iso(row.ended_at), isFinal: row.is_final,
      metadata: json(row.metadata, {}),
    };
  }

  async getRecentSegments(meetingId: string, limit: number): Promise<TranscriptSegment[]> {
    const result = await getPool().query(
      `select * from transcript_segments where meeting_id = $1 and is_final = true
       order by sequence desc limit $2`, [meetingId, limit],
    );
    return result.rows.reverse().map((row) => ({
      id: row.id, meetingId: row.meeting_id, sequence: Number(row.sequence), speakerId: row.speaker_id,
      text: row.text, startedAt: iso(row.started_at), endedAt: iso(row.ended_at), isFinal: row.is_final,
      metadata: json(row.metadata, {}),
    }));
  }

  async saveSignal(context: RequestContext, signal: MeetingSignal, correlationId: string): Promise<void> {
    await getPool().query(
      `insert into meeting_signals
       (id, workspace_id, meeting_id, segment_sequence, signal_type, payload, confidence,
        urgency, novelty, evidence_segment_ids, related_entities, should_retrieve_context,
        retrieval_query, correlation_id)
       values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14)
       on conflict (id) do nothing`,
      [signal.id, context.workspaceId, signal.meetingId, signal.segmentSequence, signal.type,
        JSON.stringify(signal.payload), signal.confidence, signal.urgency, signal.novelty,
        JSON.stringify(signal.evidenceSegmentIds), JSON.stringify(signal.relatedEntities),
        signal.shouldRetrieveContext, signal.retrievalQuery, correlationId],
    );
  }

  async recordSignalFeedback(context: RequestContext, signalId: string, reaction: string, feedback: Record<string, unknown>): Promise<void> {
    const result = await getPool().query(
      `update meeting_signals s set reaction = $3, feedback = $4::jsonb
       from workspace_members wm where s.id = $1 and s.workspace_id = $2
       and wm.workspace_id = s.workspace_id and wm.user_id = $5`,
      [signalId, context.workspaceId, reaction, JSON.stringify(feedback), context.userId],
    );
    if (!result.rowCount) throw new Error("SIGNAL_NOT_FOUND_OR_FORBIDDEN");
  }

  async retrieve(input: RetrievalInput): Promise<RetrievedEvidence[]> {
    const vector = input.queryEmbedding ? `[${input.queryEmbedding.join(",")}]` : null;
    const result = await getPool().query(
      `with ranked as (
         select n.*,
           case when $3::text is null or n.embedding is null then 0
                else 1 - (n.embedding <=> $3::vector) end as semantic_score,
           ts_rank_cd(to_tsvector('simple', n.content || ' ' || n.summary),
                      plainto_tsquery('simple', $4)) as text_score,
           extract(epoch from ($5::timestamptz - n.observed_at)) / 86400 as age_days
         from memory_nodes n
         where n.workspace_id = $1
           and exists (select 1 from workspace_members wm where wm.workspace_id = n.workspace_id and wm.user_id::text = $2)
           and n.status in ('active', 'confirmed')
           and (n.valid_from is null or n.valid_from <= $5::timestamptz)
           and (n.valid_until is null or n.valid_until > $5::timestamptz)
           and ($6::text is null or n.project_id = $6)
           and (coalesce(array_length($7::text[], 1), 0) = 0 or exists (
             select 1 from jsonb_array_elements_text(coalesce(n.metadata->'relatedEntities','[]'::jsonb)) e
             where e = any($7::text[])
           ))
       ), accessible as (
         select distinct on (r.id) r.*, s.id source_pk, s.source_type, s.source_id,
           s.meeting_id source_meeting_id, s.transcript_segment_id, s.document_uri,
           s.quoted_text, s.observed_at source_observed_at
         from ranked r join memory_sources s on s.memory_id = r.id
         where coalesce(s.permissions_snapshot->>'visibility','workspace') = 'workspace'
            or coalesce(s.permissions_snapshot->'allowedUserIds','[]'::jsonb) ? $2
         order by r.id, s.observed_at desc
       ), top_memories as (
         select *, (semantic_score * .45 + text_score * .30 + confidence * .10 +
                    importance * .10 + greatest(0, 1 - age_days / 365.0) * .05) score
         from accessible order by score desc limit $8
       )
       select t.*,
         coalesce((select jsonb_agg(jsonb_build_object(
           'edgeId', e.id, 'label', e.relation_label,
           'fromMemoryId', e.from_memory_id, 'toMemoryId', e.to_memory_id))
           from memory_edges e where e.workspace_id = $1
             and (e.from_memory_id = t.id or e.to_memory_id = t.id)
             and (e.valid_until is null or e.valid_until > $5::timestamptz)), '[]'::jsonb) relations
       from top_memories t order by score desc`,
      [input.workspaceId, input.userId, vector, input.query, input.asOf,
        input.projectId ?? null, input.participantIds ?? [], input.limit],
    );
    const evidence = result.rows.map((row) => ({
      memory: {
        id: row.id, content: row.content, summary: row.summary, status: row.status,
        confidence: row.confidence, importance: row.importance,
        validFrom: iso(row.valid_from), validUntil: iso(row.valid_until),
      },
      source: {
        id: row.source_pk, type: row.source_type, sourceId: row.source_id,
        meetingId: row.source_meeting_id, transcriptSegmentId: row.transcript_segment_id,
        documentUri: row.document_uri,
      },
      observedAt: iso(row.source_observed_at)!, quotedText: row.quoted_text,
      relationsUsed: json(row.relations, []), score: Number(row.score),
    }));
    await getPool().query(
      `insert into memory_activity_events(workspace_id,event_type,resource_type,resource_id,payload)
       values($1,'memory.retrieved','retrieval',null,$2::jsonb)`,
      [input.workspaceId, JSON.stringify({
        query: input.query, asOf: input.asOf, projectId: input.projectId ?? null,
        participantIds: input.participantIds ?? [], userId: input.userId,
        resultCount: evidence.length,
        results: evidence.map((item) => ({
          memoryId: item.memory.id, content: item.memory.content, summary: item.memory.summary,
          score: item.score, source: item.source, quotedText: item.quotedText,
          observedAt: item.observedAt, relationsUsed: item.relationsUsed,
        })),
      })],
    );
    return evidence;
  }

  async persistMutations(context: RequestContext, correlationId: string, key: string, proposals: MemoryMutationProposal[]): Promise<MutationResult> {
    return withTransaction(async (client) => {
      const prior = await client.query(
        `select result from mutation_batches where workspace_id = $1 and idempotency_key = $2 for update`,
        [context.workspaceId, key],
      );
      if (prior.rows[0]) return json(prior.rows[0].result, { memoryIds: [], edgeIds: [], ignored: 0 });
      const result: MutationResult = { memoryIds: [], edgeIds: [], ignored: 0 };
      for (const proposal of proposals) await this.applyProposal(client, context, proposal, result);
      await client.query(
        `insert into mutation_batches(workspace_id, correlation_id, idempotency_key, result)
         values ($1,$2,$3,$4::jsonb)`,
        [context.workspaceId, correlationId, key, JSON.stringify(result)],
      );
      return result;
    });
  }

  private async applyProposal(client: PoolClient, context: RequestContext, proposal: MemoryMutationProposal, result: MutationResult): Promise<void> {
    if (proposal.operation === "IGNORE") { result.ignored += 1; return; }
    if (proposal.operation === "CONTRADICT" && !proposal.requiresHumanReview) {
      throw new Error("INVALID_PROPOSAL: contradictions require human review");
    }
    let newId: string | null = null;
    if (proposal.node) {
      newId = proposal.node.clientId ?? randomUUID();
      await client.query(
        `insert into memory_nodes
         (id,workspace_id,project_id,content,summary,status,confidence,importance,observed_at,
          valid_from,valid_until,created_by,metadata)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
         on conflict (id) do nothing`,
        [newId, context.workspaceId, proposal.node.projectId, proposal.node.content,
          proposal.node.summary, proposal.node.status, proposal.node.confidence,
          proposal.node.importance, proposal.node.observedAt, proposal.node.validFrom,
          proposal.node.validUntil, proposal.node.createdBy, JSON.stringify(proposal.node.metadata)],
      );
      result.memoryIds.push(newId);
    }
    if (proposal.operation === "SUPERSEDE") {
      if (!proposal.targetMemoryId || !newId || !proposal.node) throw new Error("INVALID_PROPOSAL: SUPERSEDE requires target and node");
      const updated = await client.query(
        `update memory_nodes set status='superseded', valid_until=$3, updated_at=now()
         where id=$1 and workspace_id=$2 and valid_until is null`,
        [proposal.targetMemoryId, context.workspaceId, proposal.node.validFrom ?? proposal.node.observedAt],
      );
      if (!updated.rowCount) throw new Error("STALE_TARGET");
      const edgeId = await this.insertEdge(client, context.workspaceId, newId, proposal.targetMemoryId,
        "reemplaza", proposal.explanation, proposal.confidence, proposal.node.validFrom, null, {});
      if (edgeId) result.edgeIds.push(edgeId);
    }
    if (proposal.operation === "CONFIRM" && proposal.targetMemoryId) {
      const updated = await client.query(
        `update memory_nodes set confidence=greatest(confidence,$3), status='confirmed', updated_at=now()
         where id=$1 and workspace_id=$2`,
        [proposal.targetMemoryId, context.workspaceId, proposal.confidence],
      );
      if (!updated.rowCount) throw new Error("STALE_TARGET");
    }
    for (const edge of proposal.edges) {
      const fromId = edge.fromMemoryId === "$new" ? newId : edge.fromMemoryId;
      const toId = edge.toMemoryId === "$new" ? newId : edge.toMemoryId;
      if (!fromId || !toId) throw new Error("INVALID_PROPOSAL: unresolved $new edge");
      const edgeId = await this.insertEdge(client, context.workspaceId, fromId, toId,
        edge.relationLabel, edge.explanation, edge.confidence, edge.validFrom, edge.validUntil, edge.metadata);
      if (edgeId) result.edgeIds.push(edgeId);
    }
    const defaultMemoryId = newId ?? proposal.targetMemoryId;
    for (const evidence of proposal.evidence) {
      const memoryId = evidence.memoryId ??
        (evidence.memoryClientId === "$new" ? newId : evidence.memoryClientId) ?? defaultMemoryId;
      if (!memoryId) throw new Error("INVALID_PROPOSAL: evidence has no target");
      await client.query(
        `insert into memory_sources
         (memory_id,source_type,source_id,meeting_id,transcript_segment_id,document_uri,
          quoted_text,observed_at,permissions_snapshot,metadata)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)
         on conflict (memory_id,source_type,source_id) do nothing`,
        [memoryId, evidence.sourceType, evidence.sourceId, evidence.meetingId,
          evidence.transcriptSegmentId, evidence.documentUri, evidence.quotedText,
          evidence.observedAt, JSON.stringify(evidence.permissionsSnapshot), JSON.stringify(evidence.metadata)],
      );
    }
  }

  private async insertEdge(client: PoolClient, workspaceId: string, fromId: string, toId: string,
    label: string, explanation: string, confidence: number, validFrom: string | null,
    validUntil: string | null, metadata: Record<string, unknown>): Promise<string | null> {
    const id = randomUUID();
    const inserted = await client.query(
      `insert into memory_edges
       (id,workspace_id,from_memory_id,to_memory_id,relation_label,explanation,confidence,valid_from,valid_until,metadata)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
       on conflict (workspace_id,from_memory_id,to_memory_id,relation_label) do nothing returning id`,
      [id, workspaceId, fromId, toId, label, explanation, confidence, validFrom, validUntil, JSON.stringify(metadata)],
    );
    return inserted.rows[0]?.id ?? null;
  }

  async setMemoryEmbedding(context: RequestContext, memoryId: string, embedding: number[]): Promise<void> {
    const vector = `[${embedding.join(",")}]`;
    const result = await getPool().query(
      `update memory_nodes set embedding=$3::vector,updated_at=now() where id=$1 and workspace_id=$2`,
      [memoryId, context.workspaceId, vector],
    );
    if (!result.rowCount) throw new Error("MEMORY_NOT_FOUND_OR_FORBIDDEN");
  }

  async enqueueJob(job: Omit<MemoryJob, "id" | "attempts">): Promise<string> {
    const result = await getPool().query(
      `insert into memory_jobs(workspace_id,meeting_id,event_type,correlation_id,idempotency_key,payload)
       values($1,$2,$3,$4,$5,$6::jsonb)
       on conflict (workspace_id,idempotency_key) do update set idempotency_key=excluded.idempotency_key
       returning id`,
      [job.workspaceId, job.meetingId, job.eventType, job.correlationId, job.idempotencyKey, JSON.stringify(job.payload)],
    );
    return result.rows[0].id;
  }

  async leaseJobs(limit: number): Promise<MemoryJob[]> {
    return withTransaction(async (client) => {
      const result = await client.query(
        `with claimed as (
           select id from memory_jobs where status='pending' and available_at <= now()
           order by created_at for update skip locked limit $1
         ) update memory_jobs j set status='processing', locked_at=now(), attempts=attempts+1
           from claimed where j.id=claimed.id returning j.*`, [limit],
      );
      return result.rows.map((row) => ({
        id: row.id, workspaceId: row.workspace_id, meetingId: row.meeting_id,
        eventType: row.event_type, correlationId: row.correlation_id,
        idempotencyKey: row.idempotency_key, payload: json(row.payload, {}), attempts: row.attempts,
      }));
    });
  }

  async completeJob(jobId: string): Promise<void> {
    await getPool().query(`update memory_jobs set status='completed', completed_at=now() where id=$1`, [jobId]);
  }

  async failJob(jobId: string, error: string): Promise<void> {
    await getPool().query(
      `update memory_jobs set status=case when attempts >= 5 then 'dead' else 'pending' end,
       available_at=now() + make_interval(secs => least(300, power(2, attempts)::int)), last_error=$2
       where id=$1`, [jobId, error.slice(0, 2000)],
    );
  }

  async proposeAction(context: RequestContext, meetingId: string, memoryId: string | null,
    actionType: ProposedActionRecord["actionType"], proposal: Record<string, unknown>,
    preview: Record<string, unknown>, key: string): Promise<ProposedActionRecord> {
    const result = await getPool().query(
      `insert into proposed_actions
       (workspace_id,meeting_id,memory_id,action_type,proposal,preview,idempotency_key)
       values($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)
       on conflict (workspace_id,idempotency_key) do update set idempotency_key=excluded.idempotency_key
       returning *`,
      [context.workspaceId, meetingId, memoryId, actionType, JSON.stringify(proposal), JSON.stringify(preview), key],
    );
    return mapAction(result.rows[0]);
  }

  async getAction(context: RequestContext, actionId: string): Promise<ProposedActionRecord | null> {
    const result = await getPool().query(
      `select a.* from proposed_actions a join workspace_members wm
       on wm.workspace_id=a.workspace_id and wm.user_id=$3 where a.id=$1 and a.workspace_id=$2`,
      [actionId, context.workspaceId, context.userId],
    );
    return result.rows[0] ? mapAction(result.rows[0]) : null;
  }

  async markActionExecuting(context: RequestContext, actionId: string, userId: string): Promise<ProposedActionRecord> {
    const result = await getPool().query(
      `update proposed_actions a set status='executing',confirmed_by=$3,confirmed_at=now(),updated_at=now()
       from workspace_members wm where a.id=$1 and a.workspace_id=$2
       and wm.workspace_id=a.workspace_id and wm.user_id=$3
       and a.status in ('awaiting_confirmation','failed') returning a.*`,
      [actionId, context.workspaceId, userId],
    );
    if (result.rows[0]) return mapAction(result.rows[0]);
    const existing = await this.getAction(context, actionId);
    if (!existing) throw new Error("ACTION_NOT_FOUND_OR_FORBIDDEN");
    return existing;
  }

  async completeAction(context: RequestContext, actionId: string, resultValue: Record<string, unknown>, evidence: Record<string, unknown>): Promise<ProposedActionRecord> {
    const result = await getPool().query(
      `update proposed_actions set status='completed',result=$3::jsonb,execution_evidence=$4::jsonb,error=null,updated_at=now()
       where id=$1 and workspace_id=$2 returning *`,
      [actionId, context.workspaceId, JSON.stringify(resultValue), JSON.stringify(evidence)],
    );
    if (!result.rows[0]) throw new Error("ACTION_NOT_FOUND_OR_FORBIDDEN");
    return mapAction(result.rows[0]);
  }

  async failAction(context: RequestContext, actionId: string, error: string): Promise<void> {
    await getPool().query(
      `update proposed_actions set status='failed',error=$3,updated_at=now() where id=$1 and workspace_id=$2`,
      [actionId, context.workspaceId, error.slice(0, 2000)],
    );
  }

  async listPendingActions(context: RequestContext, meetingId: string): Promise<ProposedActionRecord[]> {
    const result = await getPool().query(
      `select a.* from proposed_actions a join workspace_members wm
       on wm.workspace_id=a.workspace_id and wm.user_id=$3
       where a.workspace_id=$1 and a.meeting_id=$2 and a.status='awaiting_confirmation'
       order by a.created_at`,
      [context.workspaceId, meetingId, context.userId],
    );
    return result.rows.map(mapAction);
  }
}
