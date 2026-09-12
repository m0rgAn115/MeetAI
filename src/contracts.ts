import { z } from "zod";

export const SignalTypeSchema = z.enum([
  "commitment",
  "decision",
  "change",
  "possible_contradiction",
  "question",
  "document_reference",
  "risk",
  "topic_boundary",
  "noop",
]);

export const MeetingSignalSchema = z.object({
  id: z.string(),
  meetingId: z.string(),
  segmentSequence: z.number().int().nonnegative(),
  type: SignalTypeSchema,
  payload: z.record(z.string(), z.unknown()),
  confidence: z.number().min(0).max(1),
  urgency: z.number().min(0).max(1),
  novelty: z.number().min(0).max(1),
  evidenceSegmentIds: z.array(z.string()),
  relatedEntities: z.array(z.string()),
  shouldRetrieveContext: z.boolean(),
  retrievalQuery: z.string().nullable(),
}).strict();

export type MeetingSignal = z.infer<typeof MeetingSignalSchema>;

export const MemoryNodeInputSchema = z.object({
  clientId: z.string().nullable(),
  projectId: z.string().nullable(),
  content: z.string(),
  summary: z.string(),
  status: z.string(),
  confidence: z.number().min(0).max(1),
  importance: z.number().min(0).max(1),
  observedAt: z.string(),
  validFrom: z.string().nullable(),
  validUntil: z.string().nullable(),
  createdBy: z.string(),
  metadata: z.record(z.string(), z.unknown()),
}).strict();

export const MemoryEdgeInputSchema = z.object({
  fromMemoryId: z.string(),
  toMemoryId: z.string(),
  relationLabel: z.string().min(1),
  explanation: z.string(),
  confidence: z.number().min(0).max(1),
  validFrom: z.string().nullable(),
  validUntil: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
}).strict();

export const MemoryEvidenceInputSchema = z.object({
  memoryClientId: z.string().nullable(),
  memoryId: z.string().nullable(),
  sourceType: z.string(),
  sourceId: z.string(),
  meetingId: z.string().nullable(),
  transcriptSegmentId: z.string().nullable(),
  documentUri: z.string().nullable(),
  quotedText: z.string(),
  observedAt: z.string(),
  permissionsSnapshot: z.record(z.string(), z.unknown()),
  metadata: z.record(z.string(), z.unknown()),
}).strict();

export const MemoryMutationProposalSchema = z.object({
  operation: z.enum([
    "ADD",
    "LINK",
    "CONFIRM",
    "SUPERSEDE",
    "CONTRADICT",
    "IGNORE",
  ]),
  targetMemoryId: z.string().nullable(),
  node: MemoryNodeInputSchema.nullable(),
  edges: z.array(MemoryEdgeInputSchema),
  evidence: z.array(MemoryEvidenceInputSchema),
  confidence: z.number().min(0).max(1),
  explanation: z.string(),
  requiresHumanReview: z.boolean(),
}).strict();

export type MemoryMutationProposal = z.infer<
  typeof MemoryMutationProposalSchema
>;

export const MeetingStateSchema = z.object({
  currentTopic: z.string().nullable(),
  activeDecisions: z.array(z.string()),
  commitments: z.array(z.string()),
  openQuestions: z.array(z.string()),
  referencedDocuments: z.array(z.string()),
  participants: z.array(z.string()),
  relevantEntities: z.array(z.string()),
  rollingSummary: z.string(),
}).strict();

export type MeetingState = z.infer<typeof MeetingStateSchema>;

export const InterventionSchema = z.object({
  kind: z.enum([
    "silent",
    "informative",
    "neutral_question",
    "prior_evidence",
    "propose_action",
    "meeting_close",
  ]),
  title: z.string().nullable(),
  message: z.string().nullable(),
  currentEvidence: z.string().nullable(),
  historicalEvidenceIds: z.array(z.string()),
  includeInClosing: z.boolean(),
  proposedAction: z.object({
    type: z.enum(["calendar.create", "calendar.update"]),
    title: z.string(),
    startDateTime: z.string(),
    endDateTime: z.string(),
    description: z.string(),
    attendeeEmails: z.array(z.string()),
  }).strict().nullable(),
}).strict();

export type Intervention = z.infer<typeof InterventionSchema>;

export const ObserverOutputSchema = z.object({
  signal: MeetingSignalSchema,
  state: MeetingStateSchema,
}).strict();

export const RetrievedEvidenceSchema = z.object({
  memory: z.object({
    id: z.string(),
    content: z.string(),
    summary: z.string(),
    status: z.string(),
    confidence: z.number(),
    importance: z.number(),
    validFrom: z.string().nullable(),
    validUntil: z.string().nullable(),
  }).strict(),
  source: z.object({
    id: z.string(),
    type: z.string(),
    sourceId: z.string(),
    meetingId: z.string().nullable(),
    transcriptSegmentId: z.string().nullable(),
    documentUri: z.string().nullable(),
  }).strict(),
  observedAt: z.string(),
  quotedText: z.string(),
  relationsUsed: z.array(z.object({
    edgeId: z.string(),
    label: z.string(),
    fromMemoryId: z.string(),
    toMemoryId: z.string(),
  }).strict()),
  score: z.number(),
}).strict();

export type RetrievedEvidence = z.infer<typeof RetrievedEvidenceSchema>;

export const OrchestratorOutputSchema = z.object({
  intervention: InterventionSchema,
}).strict();

export const CuratorOutputSchema = z.object({
  proposals: z.array(MemoryMutationProposalSchema),
}).strict();

export type CuratorOutput = z.infer<typeof CuratorOutputSchema>;

export interface TranscriptSegment {
  id: string;
  meetingId: string;
  sequence: number;
  speakerId: string | null;
  text: string;
  startedAt: string | null;
  endedAt: string | null;
  isFinal: boolean;
  metadata: Record<string, unknown>;
}

export interface RequestContext {
  workspaceId: string;
  userId: string;
  projectId?: string | null;
  participantIds?: string[];
}

export interface MeetingRecord {
  id: string;
  workspaceId: string;
  title: string;
  startedAt: string;
  endedAt: string | null;
  participants: string[];
  status: string;
  rollingSummary: string;
  state: MeetingState;
  interventionCount: number;
}

export interface ProposedActionRecord {
  id: string;
  workspaceId: string;
  meetingId: string;
  memoryId: string | null;
  actionType: "calendar.create" | "calendar.update";
  proposal: Record<string, unknown>;
  preview: Record<string, unknown>;
  status: string;
  idempotencyKey: string;
  result: Record<string, unknown> | null;
  error: string | null;
}
