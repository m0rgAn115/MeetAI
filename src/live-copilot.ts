import { randomUUID } from "node:crypto";
import { Agent, run } from "@openai/agents";
import { z } from "zod";
import {
  Intervention,
  MeetingSignal,
  MeetingSignalSchema,
  MeetingState,
  MeetingStateSchema,
  OrchestratorOutputSchema,
  RequestContext,
  RetrievedEvidence,
  TranscriptSegment,
} from "./contracts";
import { MemoryStore } from "./memory/store";
import {
  LIVE_COPILOT_OBSERVER_PROMPT,
  LIVE_COPILOT_ORCHESTRATOR_PROMPT,
  LIVE_COPILOT_PROMPT_VERSION,
} from "./prompts/live-copilot.v1";
import { KnowledgeRetrievalService } from "./services/retrieval";

const ModelSignalPayloadSchema = z.object({
  stage: z.enum(["mentioned", "proposed", "decided", "confirmed", "executed", "unknown"]),
  text: z.string().nullable(),
  owner: z.string().nullable(),
  action: z.string().nullable(),
  deadline: z.string().nullable(),
  currentValue: z.string().nullable(),
  priorValue: z.string().nullable(),
  uncertainty: z.string().nullable(),
  documentQuery: z.string().nullable(),
  risk: z.string().nullable(),
  attributes: z.array(z.object({ key: z.string(), value: z.string() }).strict()),
}).strict();

const ModelObserverOutputSchema = z.object({
  signal: z.object({
    id: z.string(),
    meetingId: z.string(),
    segmentSequence: z.number().int().nonnegative(),
    type: z.enum(["commitment", "decision", "change", "possible_contradiction", "question", "document_reference", "risk", "topic_boundary", "noop"]),
    payload: ModelSignalPayloadSchema,
    confidence: z.number().min(0).max(1),
    urgency: z.number().min(0).max(1),
    novelty: z.number().min(0).max(1),
    evidenceSegmentIds: z.array(z.string()),
    relatedEntities: z.array(z.string()),
    shouldRetrieveContext: z.boolean(),
    retrievalQuery: z.string().nullable(),
  }).strict(),
  state: MeetingStateSchema,
}).strict();

export interface Observer {
  observe(input: {
    meetingId: string;
    segment: TranscriptSegment;
    recentSegments: TranscriptSegment[];
    state: MeetingState;
    currentDateTime?: string;
    timeZone?: string;
  }): Promise<{ signal: MeetingSignal; state: MeetingState }>;
}

export interface InterventionOrchestrator {
  decide(input: {
    segment: TranscriptSegment;
    state: MeetingState;
    signal: MeetingSignal;
    evidence: RetrievedEvidence[];
  }): Promise<Intervention>;
}

const model = process.env.OPENAI_MODEL ?? "gpt-5.6-luna";

const observerAgent = new Agent({
  name: "Live Copilot Observer",
  model,
  instructions: LIVE_COPILOT_OBSERVER_PROMPT,
  outputType: ModelObserverOutputSchema,
});

const orchestratorAgent = new Agent({
  name: "Live Copilot Intervention Orchestrator",
  model,
  instructions: LIVE_COPILOT_ORCHESTRATOR_PROMPT,
  outputType: OrchestratorOutputSchema,
});

export class OpenAIObserver implements Observer {
  async observe(input: Parameters<Observer["observe"]>[0]): Promise<{ signal: MeetingSignal; state: MeetingState }> {
    const result = await run(observerAgent, JSON.stringify({
      promptVersion: LIVE_COPILOT_PROMPT_VERSION,
      meetingId: input.meetingId,
      currentDateTime: input.currentDateTime ?? null,
      timeZone: input.timeZone ?? null,
      state: input.state,
      recentFinalSegments: input.recentSegments,
      newestFinalSegment: input.segment,
      invariantFields: {
        signalId: `signal:${input.segment.id}`,
        segmentSequence: input.segment.sequence,
        evidenceSegmentIds: [input.segment.id],
      },
    }));
    if (!result.finalOutput) throw new Error("Observer returned no structured output");
    const modelPayload = result.finalOutput.signal.payload;
    const payload: Record<string, unknown> = {
      ...Object.fromEntries(
        Object.entries(modelPayload).filter(([key, value]) => key !== "attributes" && value !== null),
      ),
      ...Object.fromEntries(modelPayload.attributes.map(({ key, value }) => [key, value])),
    };
    const signal = MeetingSignalSchema.parse({
      ...result.finalOutput.signal,
      payload,
      id: `signal:${input.segment.id}`,
      meetingId: input.meetingId,
      segmentSequence: input.segment.sequence,
      evidenceSegmentIds: Array.from(new Set([
        input.segment.id,
        ...result.finalOutput.signal.evidenceSegmentIds,
      ])),
    });
    return { signal, state: result.finalOutput.state };
  }
}

export class OpenAIInterventionOrchestrator implements InterventionOrchestrator {
  async decide(input: Parameters<InterventionOrchestrator["decide"]>[0]): Promise<Intervention> {
    const result = await run(orchestratorAgent, JSON.stringify({
      promptVersion: LIVE_COPILOT_PROMPT_VERSION,
      segment: input.segment,
      state: input.state,
      signal: input.signal,
      retrievedEvidence: input.evidence,
    }));
    if (!result.finalOutput) throw new Error("Orchestrator returned no structured output");
    return result.finalOutput.intervention;
  }
}

export class HeuristicObserver implements Observer {
  async observe(input: Parameters<Observer["observe"]>[0]): Promise<{ signal: MeetingSignal; state: MeetingState }> {
    const text = input.segment.text;
    const lower = text.toLocaleLowerCase();
    let type: MeetingSignal["type"] = "noop";
    const payload: Record<string, unknown> = { stage: "mentioned", text };
    let shouldRetrieveContext = false;
    let retrievalQuery: string | null = null;

    if (/(entregar[aá]|entregaré|entregará|voy a entregar|me comprometo|i(?:'|’)ll deliver)/i.test(text)) {
      type = "commitment";
      payload.stage = /confirm|acordado|definitiv/i.test(lower) ? "confirmed" : "proposed";
      payload.owner = input.segment.speakerId;
    }
    if (/documento|requisitos|informe|presentaci[oó]n|archivo|drive|pdf/i.test(lower)) {
      type = type === "noop" ? "document_reference" : type;
      shouldRetrieveContext = true;
      retrievalQuery = text.replace(/\b(el|la|los|las|un|una|documento|archivo|de)\b/gi, " ").replace(/\s+/g, " ").trim();
    }
    if (/cambia|cambiar|se mueve|move.+from|instead/i.test(lower)) {
      type = "change";
      payload.stage = /cambia|se mueve/i.test(lower) ? "confirmed" : "proposed";
      shouldRetrieveContext = true;
      retrievalQuery = text;
    } else if (/revisamos?.+lunes|review.+monday/i.test(lower)) {
      type = "possible_contradiction";
      payload.stage = "mentioned";
      payload.uncertainty = "La revisión y la entrega pueden ser hitos distintos";
      shouldRetrieveContext = true;
      retrievalQuery = "fecha entrega informe";
    } else if (/cu[aá]l.+fecha|qu[eé].+fecha|when is|what.+date/i.test(lower)) {
      type = "question";
      shouldRetrieveContext = true;
      retrievalQuery = text;
    }

    const state = updateState(input.state, input.segment, type, payload);
    return {
      signal: {
        id: `signal:${input.segment.id}`,
        meetingId: input.meetingId,
        segmentSequence: input.segment.sequence,
        type,
        payload,
        confidence: type === "noop" ? 0.95 : type === "possible_contradiction" ? 0.58 : 0.82,
        urgency: /hoy|today|urgente/i.test(lower) ? 0.85 : 0.35,
        novelty: type === "noop" ? 0 : 0.75,
        evidenceSegmentIds: [input.segment.id],
        relatedEntities: input.segment.speakerId ? [input.segment.speakerId] : [],
        shouldRetrieveContext,
        retrievalQuery,
      },
      state,
    };
  }
}

export class HeuristicOrchestrator implements InterventionOrchestrator {
  async decide(input: Parameters<InterventionOrchestrator["decide"]>[0]): Promise<Intervention> {
    const evidenceIds = input.evidence.map((item) => item.source.id);
    if (input.signal.type === "noop") return silent();
    if (input.signal.type === "possible_contradiction") {
      return {
        kind: "neutral_question",
        title: "Conviene aclarar la fecha",
        message: "¿Viernes sigue siendo la entrega y lunes corresponde a la revisión?",
        currentEvidence: input.segment.text,
        historicalEvidenceIds: evidenceIds,
        includeInClosing: true,
        proposedAction: null,
      };
    }
    if (input.signal.type === "question" && input.evidence.length) {
      return {
        kind: "prior_evidence",
        title: "Contexto de reuniones anteriores",
        message: input.evidence[0].memory.summary,
        currentEvidence: input.segment.text,
        historicalEvidenceIds: evidenceIds,
        includeInClosing: false,
        proposedAction: null,
      };
    }
    if (input.signal.type === "document_reference" && input.evidence.length) {
      return {
        kind: "prior_evidence",
        title: "Documento relacionado",
        message: input.evidence[0].memory.summary,
        currentEvidence: input.segment.text,
        historicalEvidenceIds: evidenceIds,
        includeInClosing: false,
        proposedAction: null,
      };
    }
    if (input.signal.confidence < 0.65) return silent();
    return {
      kind: "informative",
      title: input.signal.type === "change" ? "Posible cambio" : "Compromiso mencionado",
      message: input.segment.text,
      currentEvidence: input.segment.text,
      historicalEvidenceIds: evidenceIds,
      includeInClosing: true,
      proposedAction: null,
    };
  }
}

function silent(): Intervention {
  return { kind: "silent", title: null, message: null, currentEvidence: null,
    historicalEvidenceIds: [], includeInClosing: false, proposedAction: null };
}

function updateState(state: MeetingState, segment: TranscriptSegment, type: MeetingSignal["type"], payload: Record<string, unknown>): MeetingState {
  const next: MeetingState = structuredClone(state);
  if (segment.speakerId && !next.participants.includes(segment.speakerId)) next.participants.push(segment.speakerId);
  if (type === "commitment") next.commitments = [...next.commitments, segment.text].slice(-8);
  if (type === "decision" || (type === "change" && payload.stage === "confirmed")) next.activeDecisions = [...next.activeDecisions, segment.text].slice(-8);
  if (type === "question" || type === "possible_contradiction") next.openQuestions = [...next.openQuestions, segment.text].slice(-8);
  if (type === "document_reference") next.referencedDocuments = [...next.referencedDocuments, segment.text].slice(-8);
  next.rollingSummary = [next.rollingSummary, type === "noop" ? "" : segment.text].filter(Boolean).slice(-6).join(" | ").slice(-1500);
  return next;
}

export interface LiveCopilotResult {
  correlationId: string;
  signal: MeetingSignal;
  intervention: Intervention;
  evidence: RetrievedEvidence[];
}

export class LiveCopilot {
  constructor(
    private readonly store: MemoryStore,
    private readonly retrieval: KnowledgeRetrievalService,
    private readonly observer: Observer,
    private readonly orchestrator: InterventionOrchestrator,
    private readonly interventionBudget = Number(process.env.MEETING_INTERVENTION_BUDGET ?? 4),
  ) {}

  async processFinalSegment(
    context: RequestContext,
    segment: TranscriptSegment,
    timing?: { currentDateTime?: string; timeZone?: string },
  ): Promise<LiveCopilotResult> {
    const meeting = await this.store.getMeeting(context, segment.meetingId);
    if (!meeting || meeting.status !== "active") throw new Error("MEETING_NOT_ACTIVE_OR_FORBIDDEN");
    const recentSegments = await this.store.getRecentSegments(segment.meetingId, 8);
    const observed = await this.observer.observe({
      meetingId: segment.meetingId,
      segment,
      recentSegments,
      state: meeting.state,
      ...timing,
    });
    const correlationId = randomUUID();
    await this.store.saveSignal(context, observed.signal, correlationId);
    const evidence = observed.signal.shouldRetrieveContext && observed.signal.retrievalQuery
      ? await this.retrieval.retrieveContext({
          ...context,
          query: observed.signal.retrievalQuery,
          participantIds: observed.signal.relatedEntities,
          includeDrive: observed.signal.type === "document_reference",
          limit: 5,
        })
      : [];
    let intervention = await this.orchestrator.decide({
      segment,
      state: observed.state,
      signal: observed.signal,
      evidence,
    });
    if (meeting.interventionCount >= this.interventionBudget) intervention = silent();
    await this.store.saveMeetingState(context, segment.meetingId, observed.state, intervention.kind !== "silent");
    if (observed.signal.type !== "noop") {
      await this.store.enqueueJob({
        workspaceId: context.workspaceId,
        meetingId: segment.meetingId,
        eventType: observed.signal.type === "topic_boundary" ? "topic.boundary" : "meeting.signal",
        correlationId,
        idempotencyKey: `curate:${observed.signal.id}`,
        payload: {
          userId: context.userId,
          projectId: context.projectId ?? null,
          signal: observed.signal,
          segment,
          retrievedEvidence: evidence,
        },
      });
    }
    return { correlationId, signal: observed.signal, intervention, evidence };
  }
}
