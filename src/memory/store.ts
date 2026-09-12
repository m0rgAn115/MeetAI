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

export interface MemoryJob {
  id: string;
  workspaceId: string;
  meetingId: string | null;
  eventType: string;
  correlationId: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export interface CreateMeetingInput {
  id?: string;
  workspaceId: string;
  userId: string;
  title: string;
  participants: string[];
  metadata?: Record<string, unknown>;
}

export interface AddSegmentInput {
  id?: string;
  meetingId: string;
  sequence: number;
  speakerId: string | null;
  text: string;
  startedAt?: string | null;
  endedAt?: string | null;
  metadata?: Record<string, unknown>;
}

export interface RetrievalInput extends RequestContext {
  query: string;
  queryEmbedding: number[] | null;
  asOf: string;
  limit: number;
}

export interface MutationResult {
  memoryIds: string[];
  edgeIds: string[];
  ignored: number;
}

export const EMPTY_MEETING_STATE: MeetingState = {
  currentTopic: null,
  activeDecisions: [],
  commitments: [],
  openQuestions: [],
  referencedDocuments: [],
  participants: [],
  relevantEntities: [],
  rollingSummary: "",
};

export interface MemoryStore {
  createMeeting(input: CreateMeetingInput): Promise<MeetingRecord>;
  getMeeting(context: RequestContext, meetingId: string): Promise<MeetingRecord | null>;
  endMeeting(context: RequestContext, meetingId: string): Promise<MeetingRecord>;
  saveMeetingState(
    context: RequestContext,
    meetingId: string,
    state: MeetingState,
    incrementIntervention?: boolean,
  ): Promise<void>;
  addFinalSegment(input: AddSegmentInput): Promise<TranscriptSegment>;
  getRecentSegments(meetingId: string, limit: number): Promise<TranscriptSegment[]>;
  saveSignal(
    context: RequestContext,
    signal: MeetingSignal,
    correlationId: string,
  ): Promise<void>;
  recordSignalFeedback(
    context: RequestContext,
    signalId: string,
    reaction: string,
    feedback: Record<string, unknown>,
  ): Promise<void>;
  retrieve(input: RetrievalInput): Promise<RetrievedEvidence[]>;
  persistMutations(
    context: RequestContext,
    correlationId: string,
    idempotencyKey: string,
    proposals: MemoryMutationProposal[],
  ): Promise<MutationResult>;
  setMemoryEmbedding(context: RequestContext, memoryId: string, embedding: number[]): Promise<void>;
  enqueueJob(job: Omit<MemoryJob, "id" | "attempts">): Promise<string>;
  leaseJobs(limit: number): Promise<MemoryJob[]>;
  completeJob(jobId: string): Promise<void>;
  failJob(jobId: string, error: string): Promise<void>;
  proposeAction(
    context: RequestContext,
    meetingId: string,
    memoryId: string | null,
    actionType: "calendar.create" | "calendar.update",
    proposal: Record<string, unknown>,
    preview: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<ProposedActionRecord>;
  getAction(context: RequestContext, actionId: string): Promise<ProposedActionRecord | null>;
  markActionExecuting(context: RequestContext, actionId: string, userId: string): Promise<ProposedActionRecord>;
  completeAction(
    context: RequestContext,
    actionId: string,
    result: Record<string, unknown>,
    evidence: Record<string, unknown>,
  ): Promise<ProposedActionRecord>;
  failAction(context: RequestContext, actionId: string, error: string): Promise<void>;
  listPendingActions(context: RequestContext, meetingId: string): Promise<ProposedActionRecord[]>;
}
