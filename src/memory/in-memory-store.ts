import { randomUUID } from "node:crypto";
import {
  MeetingRecord,
  MeetingSignal,
  MemoryMutationProposal,
  ProposedActionRecord,
  RequestContext,
  RetrievedEvidence,
  TranscriptSegment,
} from "../contracts";
import {
  AddSegmentInput,
  CreateMeetingInput,
  EMPTY_MEETING_STATE,
  MemoryJob,
  MemoryStore,
  MutationResult,
  RetrievalInput,
} from "./store";

interface MemoryRow {
  id: string;
  workspaceId: string;
  projectId: string | null;
  content: string;
  summary: string;
  status: string;
  confidence: number;
  importance: number;
  observedAt: string;
  validFrom: string | null;
  validUntil: string | null;
  metadata: Record<string, unknown>;
  embedding?: number[];
}

interface SourceRow {
  id: string;
  memoryId: string;
  type: string;
  sourceId: string;
  meetingId: string | null;
  transcriptSegmentId: string | null;
  documentUri: string | null;
  quotedText: string;
  observedAt: string;
  permissions: Record<string, unknown>;
}

interface EdgeRow {
  id: string;
  workspaceId: string;
  fromMemoryId: string;
  toMemoryId: string;
  label: string;
}

function hasSourceAccess(source: SourceRow, userId: string): boolean {
  if ((source.permissions.visibility ?? "workspace") === "workspace") {
    return true;
  }
  const allowed = source.permissions.allowedUserIds;
  return Array.isArray(allowed) && allowed.includes(userId);
}

export class InMemoryMemoryStore implements MemoryStore {
  readonly meetings = new Map<string, MeetingRecord>();
  readonly segments = new Map<string, TranscriptSegment[]>();
  readonly signals = new Map<string, MeetingSignal & { reaction?: string }>();
  readonly memories = new Map<string, MemoryRow>();
  readonly sources: SourceRow[] = [];
  readonly edges: EdgeRow[] = [];
  readonly actions = new Map<string, ProposedActionRecord>();
  readonly jobs = new Map<string, MemoryJob & { status: string }>();
  private mutationResults = new Map<string, MutationResult>();

  async createMeeting(input: CreateMeetingInput): Promise<MeetingRecord> {
    const id = input.id ?? randomUUID();
    const existing = this.meetings.get(id);
    if (existing) return existing;
    const meeting: MeetingRecord = {
      id,
      workspaceId: input.workspaceId,
      title: input.title,
      startedAt: new Date().toISOString(),
      endedAt: null,
      participants: [...input.participants],
      status: "active",
      rollingSummary: "",
      state: { ...EMPTY_MEETING_STATE, participants: [...input.participants] },
      interventionCount: 0,
    };
    this.meetings.set(id, meeting);
    return meeting;
  }

  async getMeeting(context: RequestContext, meetingId: string): Promise<MeetingRecord | null> {
    const meeting = this.meetings.get(meetingId);
    return meeting?.workspaceId === context.workspaceId ? meeting : null;
  }

  async endMeeting(context: RequestContext, meetingId: string): Promise<MeetingRecord> {
    const meeting = await this.requireMeeting(context, meetingId);
    meeting.status = "ended";
    meeting.endedAt = new Date().toISOString();
    return meeting;
  }

  async saveMeetingState(context: RequestContext, meetingId: string, state: MeetingRecord["state"], increment = false): Promise<void> {
    const meeting = await this.requireMeeting(context, meetingId);
    meeting.state = structuredClone(state);
    meeting.rollingSummary = state.rollingSummary;
    if (increment) meeting.interventionCount += 1;
  }

  async addFinalSegment(input: AddSegmentInput): Promise<TranscriptSegment> {
    const list = this.segments.get(input.meetingId) ?? [];
    const existing = list.find((item) => item.sequence === input.sequence);
    if (existing) return existing;
    const segment: TranscriptSegment = {
      id: input.id ?? randomUUID(),
      meetingId: input.meetingId,
      sequence: input.sequence,
      speakerId: input.speakerId,
      text: input.text,
      startedAt: input.startedAt ?? null,
      endedAt: input.endedAt ?? null,
      isFinal: true,
      metadata: input.metadata ?? {},
    };
    list.push(segment);
    list.sort((a, b) => a.sequence - b.sequence);
    this.segments.set(input.meetingId, list);
    return segment;
  }

  async getRecentSegments(meetingId: string, limit: number): Promise<TranscriptSegment[]> {
    return (this.segments.get(meetingId) ?? []).slice(-limit);
  }

  async saveSignal(_context: RequestContext, signal: MeetingSignal): Promise<void> {
    if (!this.signals.has(signal.id)) this.signals.set(signal.id, structuredClone(signal));
  }

  async recordSignalFeedback(_context: RequestContext, signalId: string, reaction: string): Promise<void> {
    const signal = this.signals.get(signalId);
    if (!signal) throw new Error("SIGNAL_NOT_FOUND");
    signal.reaction = reaction;
  }

  async retrieve(input: RetrievalInput): Promise<RetrievedEvidence[]> {
    const terms = input.query.toLocaleLowerCase().split(/\s+/).filter((term) => term.length > 2);
    const asOf = new Date(input.asOf).getTime();
    const rows = [...this.memories.values()]
      .filter((memory) => memory.workspaceId === input.workspaceId)
      .filter((memory) => !input.projectId || memory.projectId === input.projectId)
      .filter((memory) => !memory.validFrom || new Date(memory.validFrom).getTime() <= asOf)
      .filter((memory) => !memory.validUntil || new Date(memory.validUntil).getTime() > asOf)
      .map((memory) => {
        const source = this.sources.find((item) => item.memoryId === memory.id && hasSourceAccess(item, input.userId));
        if (!source) return null;
        const haystack = `${memory.content} ${memory.summary}`.toLocaleLowerCase();
        const textScore = terms.length ? terms.filter((term) => haystack.includes(term)).length / terms.length : 0;
        const score = textScore * 0.55 + memory.confidence * 0.2 + memory.importance * 0.15 + 0.1;
        const relatedEdges = this.edges.filter((edge) => edge.fromMemoryId === memory.id || edge.toMemoryId === memory.id);
        return {
          memory: {
            id: memory.id,
            content: memory.content,
            summary: memory.summary,
            status: memory.status,
            confidence: memory.confidence,
            importance: memory.importance,
            validFrom: memory.validFrom,
            validUntil: memory.validUntil,
          },
          source: {
            id: source.id,
            type: source.type,
            sourceId: source.sourceId,
            meetingId: source.meetingId,
            transcriptSegmentId: source.transcriptSegmentId,
            documentUri: source.documentUri,
          },
          observedAt: source.observedAt,
          quotedText: source.quotedText,
          relationsUsed: relatedEdges.map((edge) => ({
            edgeId: edge.id,
            label: edge.label,
            fromMemoryId: edge.fromMemoryId,
            toMemoryId: edge.toMemoryId,
          })),
          score,
        } satisfies RetrievedEvidence;
      })
      .filter((item): item is RetrievedEvidence => item !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, input.limit);
    return rows;
  }

  async persistMutations(context: RequestContext, _correlationId: string, key: string, proposals: MemoryMutationProposal[]): Promise<MutationResult> {
    const batchKey = `${context.workspaceId}:${key}`;
    const previous = this.mutationResults.get(batchKey);
    if (previous) return structuredClone(previous);
    const result: MutationResult = { memoryIds: [], edgeIds: [], ignored: 0 };

    for (const proposal of proposals) {
      if (proposal.operation === "IGNORE") {
        result.ignored += 1;
        continue;
      }
      if (proposal.operation === "CONTRADICT" && !proposal.requiresHumanReview) {
        throw new Error("INVALID_PROPOSAL: contradictions require human review");
      }

      let newMemoryId: string | null = null;
      if (proposal.node) {
        newMemoryId = proposal.node.clientId ?? randomUUID();
        if (!this.memories.has(newMemoryId)) {
          this.memories.set(newMemoryId, {
            id: newMemoryId,
            workspaceId: context.workspaceId,
            projectId: proposal.node.projectId,
            content: proposal.node.content,
            summary: proposal.node.summary,
            status: proposal.node.status,
            confidence: proposal.node.confidence,
            importance: proposal.node.importance,
            observedAt: proposal.node.observedAt,
            validFrom: proposal.node.validFrom,
            validUntil: proposal.node.validUntil,
            metadata: structuredClone(proposal.node.metadata),
          });
          result.memoryIds.push(newMemoryId);
        }
      }

      if (proposal.operation === "SUPERSEDE") {
        if (!proposal.targetMemoryId || !newMemoryId) throw new Error("INVALID_PROPOSAL: SUPERSEDE requires target and node");
        const target = this.memories.get(proposal.targetMemoryId);
        if (!target || target.workspaceId !== context.workspaceId) throw new Error("STALE_TARGET");
        target.validUntil = proposal.node?.validFrom ?? proposal.node?.observedAt ?? new Date().toISOString();
        target.status = "superseded";
        const edgeId = randomUUID();
        this.edges.push({ id: edgeId, workspaceId: context.workspaceId, fromMemoryId: newMemoryId, toMemoryId: target.id, label: "reemplaza" });
        result.edgeIds.push(edgeId);
      }

      if (proposal.operation === "CONFIRM" && proposal.targetMemoryId) {
        const target = this.memories.get(proposal.targetMemoryId);
        if (!target) throw new Error("STALE_TARGET");
        target.confidence = Math.max(target.confidence, proposal.confidence);
      }

      for (const edge of proposal.edges) {
        const edgeId = randomUUID();
        this.edges.push({
          id: edgeId,
          workspaceId: context.workspaceId,
          fromMemoryId: edge.fromMemoryId === "$new" ? newMemoryId ?? edge.fromMemoryId : edge.fromMemoryId,
          toMemoryId: edge.toMemoryId === "$new" ? newMemoryId ?? edge.toMemoryId : edge.toMemoryId,
          label: edge.relationLabel,
        });
        result.edgeIds.push(edgeId);
      }

      const evidenceMemoryId = newMemoryId ?? proposal.targetMemoryId;
      for (const evidence of proposal.evidence) {
        const memoryId = evidence.memoryId ?? (evidence.memoryClientId === "$new" ? newMemoryId : evidence.memoryClientId) ?? evidenceMemoryId;
        if (!memoryId) throw new Error("INVALID_PROPOSAL: evidence has no memory target");
        if (!this.sources.some((source) => source.memoryId === memoryId && source.type === evidence.sourceType && source.sourceId === evidence.sourceId)) {
          this.sources.push({
            id: randomUUID(), memoryId, type: evidence.sourceType, sourceId: evidence.sourceId,
            meetingId: evidence.meetingId, transcriptSegmentId: evidence.transcriptSegmentId,
            documentUri: evidence.documentUri, quotedText: evidence.quotedText,
            observedAt: evidence.observedAt, permissions: structuredClone(evidence.permissionsSnapshot),
          });
        }
      }
    }

    this.mutationResults.set(batchKey, structuredClone(result));
    return result;
  }

  async enqueueJob(job: Omit<MemoryJob, "id" | "attempts">): Promise<string> {
    const existing = [...this.jobs.values()].find((item) => item.workspaceId === job.workspaceId && item.idempotencyKey === job.idempotencyKey);
    if (existing) return existing.id;
    const id = randomUUID();
    this.jobs.set(id, { ...structuredClone(job), id, attempts: 0, status: "pending" });
    return id;
  }

  async setMemoryEmbedding(context: RequestContext, memoryId: string, embedding: number[]): Promise<void> {
    const memory = this.memories.get(memoryId);
    if (!memory || memory.workspaceId !== context.workspaceId) throw new Error("MEMORY_NOT_FOUND_OR_FORBIDDEN");
    memory.embedding = [...embedding];
  }

  async leaseJobs(limit: number): Promise<MemoryJob[]> {
    const pending = [...this.jobs.values()].filter((job) => job.status === "pending").slice(0, limit);
    pending.forEach((job) => { job.status = "processing"; job.attempts += 1; });
    return structuredClone(pending);
  }

  async completeJob(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId); if (job) job.status = "completed";
  }

  async failJob(jobId: string, _error: string): Promise<void> {
    const job = this.jobs.get(jobId); if (job) job.status = "pending";
  }

  async proposeAction(context: RequestContext, meetingId: string, memoryId: string | null, actionType: ProposedActionRecord["actionType"], proposal: Record<string, unknown>, preview: Record<string, unknown>, key: string): Promise<ProposedActionRecord> {
    const existing = [...this.actions.values()].find((item) => item.workspaceId === context.workspaceId && item.idempotencyKey === key);
    if (existing) return existing;
    const action: ProposedActionRecord = {
      id: randomUUID(), workspaceId: context.workspaceId, meetingId, memoryId, actionType,
      proposal: structuredClone(proposal), preview: structuredClone(preview), status: "awaiting_confirmation",
      idempotencyKey: key, result: null, error: null,
    };
    this.actions.set(action.id, action);
    return action;
  }

  async getAction(context: RequestContext, actionId: string): Promise<ProposedActionRecord | null> {
    const action = this.actions.get(actionId);
    return action?.workspaceId === context.workspaceId ? action : null;
  }

  async markActionExecuting(context: RequestContext, actionId: string): Promise<ProposedActionRecord> {
    const action = await this.requireAction(context, actionId);
    if (action.status === "awaiting_confirmation" || action.status === "failed") action.status = "executing";
    return action;
  }

  async completeAction(context: RequestContext, actionId: string, result: Record<string, unknown>): Promise<ProposedActionRecord> {
    const action = await this.requireAction(context, actionId);
    action.status = "completed";
    action.result = structuredClone(result);
    action.error = null;
    return action;
  }

  async failAction(context: RequestContext, actionId: string, error: string): Promise<void> {
    const action = await this.requireAction(context, actionId);
    action.status = "failed";
    action.error = error;
  }

  async listPendingActions(context: RequestContext, meetingId: string): Promise<ProposedActionRecord[]> {
    return [...this.actions.values()].filter((action) => action.workspaceId === context.workspaceId &&
      action.meetingId === meetingId && action.status === "awaiting_confirmation");
  }

  private async requireMeeting(context: RequestContext, meetingId: string): Promise<MeetingRecord> {
    const meeting = await this.getMeeting(context, meetingId);
    if (!meeting) throw new Error("MEETING_NOT_FOUND_OR_FORBIDDEN");
    return meeting;
  }

  private async requireAction(context: RequestContext, actionId: string): Promise<ProposedActionRecord> {
    const action = await this.getAction(context, actionId);
    if (!action) throw new Error("ACTION_NOT_FOUND_OR_FORBIDDEN");
    return action;
  }
}
