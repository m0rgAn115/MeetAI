import { Agent, run } from "@openai/agents";
import { z } from "zod";
import {
  CuratorOutput,
  CuratorOutputSchema,
  MeetingSignalSchema,
  MemoryMutationProposal,
  MemoryMutationProposalSchema,
  RequestContext,
  RetrievedEvidence,
  TranscriptSegment,
} from "./contracts";
import { MemoryJob, MemoryStore } from "./memory/store";
import {
  MEMORY_CURATOR_PROMPT,
  MEMORY_CURATOR_PROMPT_VERSION,
} from "./prompts/memory-curator.v1";
import { KnowledgeRetrievalService } from "./services/retrieval";
import { EmbeddingProvider, NullEmbeddingProvider } from "./services/embeddings";

export interface CuratorModel {
  propose(input: {
    job: MemoryJob;
    context: RequestContext;
    existing: RetrievedEvidence[];
  }): Promise<CuratorOutput>;
}

// The database contracts intentionally allow open-ended JSON metadata. OpenAI
// Structured Outputs requires closed JSON Schemas, so the model boundary uses
// key/value lists and converts them back to flexible records afterwards.
const ModelAttributeSchema = z.object({
  key: z.string(),
  value: z.string(),
}).strict();

const ModelMemoryNodeSchema = z.object({
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
  attributes: z.array(ModelAttributeSchema),
}).strict();

const ModelMemoryEdgeSchema = z.object({
  fromMemoryId: z.string(),
  toMemoryId: z.string(),
  relationLabel: z.string(),
  explanation: z.string(),
  confidence: z.number().min(0).max(1),
  validFrom: z.string().nullable(),
  validUntil: z.string().nullable(),
  attributes: z.array(ModelAttributeSchema),
}).strict();

const ModelMemoryEvidenceSchema = z.object({
  memoryClientId: z.string().nullable(),
  memoryId: z.string().nullable(),
  sourceType: z.string(),
  sourceId: z.string(),
  meetingId: z.string().nullable(),
  transcriptSegmentId: z.string().nullable(),
  documentUri: z.string().nullable(),
  quotedText: z.string(),
  observedAt: z.string(),
  visibility: z.string(),
  allowedUserIds: z.array(z.string()),
  attributes: z.array(ModelAttributeSchema),
}).strict();

const ModelMutationProposalSchema = z.object({
  operation: z.enum(["ADD", "LINK", "CONFIRM", "SUPERSEDE", "CONTRADICT", "IGNORE"]),
  targetMemoryId: z.string().nullable(),
  node: ModelMemoryNodeSchema.nullable(),
  edges: z.array(ModelMemoryEdgeSchema),
  evidence: z.array(ModelMemoryEvidenceSchema),
  confidence: z.number().min(0).max(1),
  explanation: z.string(),
  requiresHumanReview: z.boolean(),
}).strict();

const ModelCuratorOutputSchema = z.object({
  proposals: z.array(ModelMutationProposalSchema),
}).strict();

function attributesToRecord(attributes: Array<{ key: string; value: string }>): Record<string, string> {
  return Object.fromEntries(attributes.map(({ key, value }) => [key, value]));
}

function normalizeModelProposal(
  proposal: z.infer<typeof ModelMutationProposalSchema>,
  job: MemoryJob,
  context: RequestContext,
): MemoryMutationProposal {
  const segment = job.payload.segment as TranscriptSegment | undefined;
  const node = proposal.node ? {
    // Database IDs and authorship are assigned by the deterministic layer.
    clientId: null,
    projectId: context.projectId ?? proposal.node.projectId,
    content: proposal.node.content,
    summary: proposal.node.summary,
    status: proposal.node.status,
    confidence: proposal.node.confidence,
    importance: proposal.node.importance,
    observedAt: proposal.node.observedAt,
    validFrom: proposal.node.validFrom ?? proposal.node.observedAt,
    // A due date belongs in content/metadata. It is not the end of validity.
    validUntil: null,
    createdBy: "memory-curator",
    metadata: attributesToRecord(proposal.node.attributes),
  } : null;
  const evidence = proposal.evidence.map((item) => ({
    memoryClientId: proposal.node ? "$new" : null,
    memoryId: proposal.node ? null : (item.memoryId ?? proposal.targetMemoryId),
    sourceType: segment ? "transcript_segment" : item.sourceType,
    sourceId: segment?.id ?? item.sourceId,
    meetingId: segment?.meetingId ?? item.meetingId,
    transcriptSegmentId: segment?.id ?? item.transcriptSegmentId,
    documentUri: item.documentUri,
    quotedText: segment?.text ?? item.quotedText,
    observedAt: segment?.endedAt ?? item.observedAt,
    permissionsSnapshot: {
      visibility: "workspace",
      allowedUserIds: [context.userId],
    },
    metadata: attributesToRecord(item.attributes),
  }));
  if (segment && proposal.node && evidence.length === 0) {
    evidence.push({
      memoryClientId: "$new",
      memoryId: null,
      sourceType: "transcript_segment",
      sourceId: segment.id,
      meetingId: segment.meetingId,
      transcriptSegmentId: segment.id,
      documentUri: null,
      quotedText: segment.text,
      observedAt: segment.endedAt ?? new Date().toISOString(),
      permissionsSnapshot: { visibility: "workspace", allowedUserIds: [context.userId] },
      metadata: {},
    });
  }
  return MemoryMutationProposalSchema.parse({
    operation: proposal.operation,
    targetMemoryId: proposal.targetMemoryId,
    node,
    edges: proposal.edges.map((edge) => ({
      fromMemoryId: edge.fromMemoryId,
      toMemoryId: edge.toMemoryId,
      relationLabel: edge.relationLabel,
      explanation: edge.explanation,
      confidence: edge.confidence,
      validFrom: edge.validFrom,
      validUntil: edge.validUntil,
      metadata: attributesToRecord(edge.attributes),
    })),
    evidence,
    confidence: proposal.confidence,
    explanation: proposal.explanation,
    requiresHumanReview: proposal.requiresHumanReview,
  });
}

const curatorAgent = new Agent({
  name: "Memory Curator",
  model: process.env.OPENAI_CURATOR_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-5.6-luna",
  instructions: MEMORY_CURATOR_PROMPT,
  outputType: ModelCuratorOutputSchema,
});

export class OpenAICuratorModel implements CuratorModel {
  async propose(input: Parameters<CuratorModel["propose"]>[0]): Promise<CuratorOutput> {
    const result = await run(curatorAgent, JSON.stringify({
      promptVersion: MEMORY_CURATOR_PROMPT_VERSION,
      event: input.job,
      existingAccessibleMemories: input.existing,
      invariants: {
        workspaceId: input.context.workspaceId,
        permissionsMustComeFromEvidence: true,
        possibleContradictionsRequireHumanReview: true,
      },
    }));
    if (!result.finalOutput) throw new Error("Memory Curator returned no structured output");
    const modelOutput = ModelCuratorOutputSchema.parse(result.finalOutput);
    return CuratorOutputSchema.parse({
      proposals: modelOutput.proposals.map((proposal) => normalizeModelProposal(proposal, input.job, input.context)),
    });
  }
}

export class HeuristicCuratorModel implements CuratorModel {
  async propose(input: Parameters<CuratorModel["propose"]>[0]): Promise<CuratorOutput> {
    const rawSignal = input.job.payload.signal;
    const rawSegment = input.job.payload.segment;
    if (!rawSignal || !rawSegment) return { proposals: [ignore("No signal evidence in job")] };
    const signal = MeetingSignalSchema.parse(rawSignal);
    const segment = rawSegment as TranscriptSegment;
    if (signal.type === "noop" || signal.type === "possible_contradiction" || signal.type === "question") {
      return { proposals: [ignore("Ambiguous or irrelevant evidence stays in the signal log")] };
    }
    const observedAt = segment.endedAt ?? new Date().toISOString();
    const permissions = { visibility: "workspace" };
    const evidence = [{
      memoryClientId: "$new",
      memoryId: null,
      sourceType: "transcript_segment",
      sourceId: segment.id,
      meetingId: segment.meetingId,
      transcriptSegmentId: segment.id,
      documentUri: null,
      quotedText: segment.text,
      observedAt,
      permissionsSnapshot: permissions,
      metadata: { speakerId: segment.speakerId, sequence: segment.sequence },
    }];
    const node = {
      clientId: null,
      projectId: input.context.projectId ?? null,
      content: segment.text,
      summary: segment.text,
      status: signal.payload.stage === "confirmed" ? "confirmed" : "active",
      confidence: signal.confidence,
      importance: Math.max(0.5, signal.urgency, signal.novelty),
      observedAt,
      validFrom: observedAt,
      validUntil: null,
      createdBy: "memory-curator",
      metadata: {
        semanticHint: signal.type,
        stage: signal.payload.stage ?? "mentioned",
        relatedEntities: signal.relatedEntities,
      },
    };
    if (signal.type === "change" && input.existing.length && signal.payload.stage === "confirmed") {
      return { proposals: [{
        operation: "SUPERSEDE",
        targetMemoryId: input.existing[0].memory.id,
        node,
        edges: [],
        evidence,
        confidence: signal.confidence,
        explanation: "La evidencia explícita indica un cambio y conserva la versión anterior.",
        requiresHumanReview: false,
      }] };
    }
    return { proposals: [{
      operation: "ADD",
      targetMemoryId: null,
      node,
      edges: [],
      evidence,
      confidence: signal.confidence,
      explanation: "Nueva evidencia atómica con utilidad futura.",
      requiresHumanReview: false,
    }] };
  }
}

function ignore(explanation: string): MemoryMutationProposal {
  return {
    operation: "IGNORE", targetMemoryId: null, node: null, edges: [], evidence: [],
    confidence: 1, explanation, requiresHumanReview: false,
  };
}

export class MemoryCuratorWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly store: MemoryStore,
    private readonly retrieval: KnowledgeRetrievalService,
    private readonly model: CuratorModel,
    private readonly embeddings: EmbeddingProvider = new NullEmbeddingProvider(),
    private readonly intervalMs = Number(process.env.CURATOR_POLL_INTERVAL_MS ?? 1500),
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const jobs = await this.store.leaseJobs(5);
      for (const job of jobs) {
        try {
          await this.processJob(job);
          await this.store.completeJob(job.id);
        } catch (error) {
          await this.store.failJob(job.id, error instanceof Error ? error.message : String(error));
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async processJob(job: MemoryJob): Promise<void> {
    const context: RequestContext = {
      workspaceId: job.workspaceId,
      userId: String(job.payload.userId ?? process.env.CURATOR_SERVICE_USER_ID ?? "memory-curator"),
      projectId: typeof job.payload.projectId === "string" ? job.payload.projectId : null,
    };
    const signal = job.payload.signal ? MeetingSignalSchema.parse(job.payload.signal) : null;
    const query = signal?.retrievalQuery ?? String((job.payload.segment as any)?.text ?? "meeting context");
    const supplied = Array.isArray(job.payload.retrievedEvidence)
      ? job.payload.retrievedEvidence as RetrievedEvidence[]
      : [];
    const existing = supplied.length
      ? supplied
      : await this.retrieval.retrieveContext({ ...context, query, limit: 6 });
    const output = await this.model.propose({ job, context, existing });
    const proposals = output.proposals.map((proposal) => this.validateProposal(proposal, job));
    const result = await this.store.persistMutations(context, job.correlationId, `mutations:${job.idempotencyKey}`, proposals);
    const nodeTexts = proposals.filter((proposal) => proposal.node).map((proposal) => proposal.node!.content);
    for (let index = 0; index < Math.min(result.memoryIds.length, nodeTexts.length); index += 1) {
      const embedding = await this.embeddings.embed(nodeTexts[index]);
      if (embedding) await this.store.setMemoryEmbedding(context, result.memoryIds[index], embedding);
    }
  }

  private validateProposal(proposal: MemoryMutationProposal, job: MemoryJob): MemoryMutationProposal {
    const parsed = MemoryMutationProposalSchema.parse(proposal);
    if (parsed.operation === "SUPERSEDE" && (!parsed.targetMemoryId || !parsed.node)) {
      throw new Error("INVALID_PROPOSAL: SUPERSEDE requires old and new memory");
    }
    if (parsed.operation === "CONTRADICT" && !parsed.requiresHumanReview) {
      throw new Error("INVALID_PROPOSAL: contradiction requires review");
    }
    const segment = job.payload.segment as TranscriptSegment | undefined;
    for (const evidence of parsed.evidence) {
      if (evidence.sourceType === "transcript_segment" && segment &&
          (evidence.sourceId !== segment.id || evidence.quotedText !== segment.text)) {
        throw new Error("INVALID_PROPOSAL: transcript evidence was altered");
      }
      if (!Object.keys(evidence.permissionsSnapshot).length) {
        throw new Error("INVALID_PROPOSAL: evidence permissions are required");
      }
    }
    return parsed;
  }
}
