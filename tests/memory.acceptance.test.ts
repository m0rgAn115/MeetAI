import assert from "node:assert/strict";
import test from "node:test";
import { ActionExecutor, CalendarAction, CalendarGateway } from "../src/action-executor";
import { InterventionOrchestrator, HeuristicObserver, HeuristicOrchestrator, LiveCopilot } from "../src/live-copilot";
import { InMemoryMemoryStore } from "../src/memory/in-memory-store";
import { MemoryMutationProposal, MeetingSignal, RequestContext, TranscriptSegment } from "../src/contracts";
import { EMPTY_MEETING_STATE } from "../src/memory/store";
import { NullEmbeddingProvider } from "../src/services/embeddings";
import { KnowledgeRetrievalService } from "../src/services/retrieval";

const context: RequestContext = { workspaceId: "workspace-a", userId: "ana", projectId: "meet-ai" };

function segment(text: string, sequence = 1, speakerId = "Ana"): TranscriptSegment {
  return {
    id: `segment-${sequence}`, meetingId: "meeting-current", sequence, speakerId, text,
    startedAt: null, endedAt: `2026-09-${String(10 + sequence).padStart(2, "0")}T15:00:00.000Z`,
    isFinal: true, metadata: {},
  };
}

function addMemory(id: string, text: string, validFrom: string, permissions: Record<string, unknown> = { visibility: "workspace" }): MemoryMutationProposal {
  return {
    operation: "ADD", targetMemoryId: null,
    node: {
      clientId: id, projectId: "meet-ai", content: text, summary: text, status: "confirmed",
      confidence: 0.9, importance: 0.8, observedAt: validFrom, validFrom, validUntil: null,
      createdBy: "test", metadata: { semanticHint: "commitment", relatedEntities: ["Ana"] },
    },
    edges: [],
    evidence: [{
      memoryClientId: "$new", memoryId: null, sourceType: "transcript_segment", sourceId: `source-${id}`,
      meetingId: null, transcriptSegmentId: null, documentUri: null, quotedText: text,
      observedAt: validFrom, permissionsSnapshot: permissions, metadata: {},
    }],
    confidence: 0.9, explanation: "seed", requiresHumanReview: false,
  };
}

test("detecta un compromiso provisional y conserva la frase original", async () => {
  const observer = new HeuristicObserver();
  const current = segment("Ana entregará el informe el viernes.");
  const observed = await observer.observe({
    meetingId: current.meetingId, segment: current, recentSegments: [current],
    state: EMPTY_MEETING_STATE,
  });
  assert.equal(observed.signal.type, "commitment");
  assert.equal(observed.signal.payload.stage, "proposed");
  assert.deepEqual(observed.signal.evidenceSegmentIds, [current.id]);
  assert.equal(observed.signal.payload.text, current.text);
});

test("una revisión el lunes solicita aclaración y no afirma una contradicción", async () => {
  const observer = new HeuristicObserver();
  const orchestrator = new HeuristicOrchestrator();
  const current = segment("Lo revisamos el lunes.", 2);
  const observed = await observer.observe({ meetingId: current.meetingId, segment: current,
    recentSegments: [current], state: EMPTY_MEETING_STATE });
  assert.equal(observed.signal.type, "possible_contradiction");
  const intervention = await orchestrator.decide({ segment: current, state: observed.state,
    signal: observed.signal, evidence: [] });
  assert.equal(intervention.kind, "neutral_question");
  assert.match(intervention.message ?? "", /viernes.*entrega.*lunes.*revisi/i);
});

test("una mención recupera el documento correcto con enlace y evidencia", async () => {
  const store = new InMemoryMemoryStore();
  await store.createMeeting({ id: "meeting-current", workspaceId: context.workspaceId,
    userId: context.userId, title: "Seguimiento", participants: ["Ana"] });
  const documentMemory = addMemory("requirements-doc", "Documento de requisitos de Meet AI",
    "2026-09-01T10:00:00.000Z", { visibility: "restricted", allowedUserIds: ["ana"] });
  documentMemory.node!.metadata = { semanticHint: "document", relatedEntities: ["Ana"] };
  documentMemory.evidence[0].sourceType = "google_drive_document";
  documentMemory.evidence[0].documentUri = "https://drive.google.com/open?id=requirements";
  await store.persistMutations(context, "seed", "requirements-document", [documentMemory]);
  const retrieval = new KnowledgeRetrievalService(store, new NullEmbeddingProvider());
  const copilot = new LiveCopilot(store, retrieval, new HeuristicObserver(), new HeuristicOrchestrator(), 10);
  const current = await store.addFinalSegment({ meetingId: "meeting-current", sequence: 1,
    speakerId: "Ana", text: "Revisemos el documento de requisitos." });
  const result = await copilot.processFinalSegment(context, current);
  assert.equal(result.signal.type, "document_reference");
  assert.equal(result.intervention.kind, "prior_evidence");
  assert.equal(result.evidence[0]?.source.documentUri, "https://drive.google.com/open?id=requirements");
  assert.match(result.evidence[0]?.quotedText ?? "", /requisitos/i);
});

test("SUPERSEDE conserva viernes, activa lunes y crea la relación reemplaza", async () => {
  const store = new InMemoryMemoryStore();
  await store.persistMutations(context, "seed", "seed-friday", [
    addMemory("memory-friday", "Ana entregará el informe el viernes", "2026-09-01T10:00:00.000Z"),
  ]);
  const replacement = addMemory("memory-monday", "La entrega cambia del viernes al lunes", "2026-09-12T10:00:00.000Z");
  replacement.operation = "SUPERSEDE";
  replacement.targetMemoryId = "memory-friday";
  await store.persistMutations(context, "change", "change-monday", [replacement]);
  assert.equal(store.memories.get("memory-friday")?.status, "superseded");
  assert.equal(store.memories.get("memory-friday")?.validUntil, "2026-09-12T10:00:00.000Z");
  assert.equal(store.memories.get("memory-monday")?.validUntil, null);
  assert.equal(store.edges[0]?.label, "reemplaza");
  assert.equal(store.edges[0]?.fromMemoryId, "memory-monday");
  assert.equal(store.edges[0]?.toMemoryId, "memory-friday");
});

test("la recuperación actual devuelve lunes y mantiene navegable el historial", async () => {
  const store = new InMemoryMemoryStore();
  await store.persistMutations(context, "seed", "seed", [
    addMemory("old", "La entrega del informe es el viernes", "2026-09-01T10:00:00.000Z"),
  ]);
  const next = addMemory("current", "La entrega del informe es el lunes", "2026-09-12T10:00:00.000Z");
  next.operation = "SUPERSEDE"; next.targetMemoryId = "old";
  await store.persistMutations(context, "change", "change", [next]);
  const retrieval = new KnowledgeRetrievalService(store, new NullEmbeddingProvider());
  const results = await retrieval.retrieveContext({ ...context, query: "fecha entrega informe",
    asOf: "2026-09-13T10:00:00.000Z" });
  assert.equal(results[0]?.memory.id, "current");
  assert.equal(results[0]?.relationsUsed[0]?.label, "reemplaza");
  assert.equal(store.memories.get("old")?.content, "La entrega del informe es el viernes");
});

test("los reintentos no duplican nodos, relaciones ni propuestas", async () => {
  const store = new InMemoryMemoryStore();
  const proposal = addMemory("same-node", "Decisión idempotente", "2026-09-12T10:00:00.000Z");
  const first = await store.persistMutations(context, "one", "same-key", [proposal]);
  const second = await store.persistMutations(context, "two", "same-key", [proposal]);
  assert.deepEqual(second, first);
  assert.equal(store.memories.size, 1);
  assert.equal(store.sources.length, 1);
});

test("Drive y memorias derivadas respetan el snapshot de permisos", async () => {
  const store = new InMemoryMemoryStore();
  await store.persistMutations(context, "seed", "private-doc", [
    addMemory("private", "Requisitos secretos del proyecto", "2026-09-01T10:00:00.000Z",
      { visibility: "restricted", allowedUserIds: ["ana"] }),
  ]);
  const retrieval = new KnowledgeRetrievalService(store, new NullEmbeddingProvider());
  const allowed = await retrieval.retrieveContext({ ...context, query: "requisitos secretos" });
  const denied = await retrieval.retrieveContext({ ...context, userId: "bob", query: "requisitos secretos" });
  assert.equal(allowed.length, 1);
  assert.equal(denied.length, 0);
});

test("Calendar no se ejecuta antes de confirmar y el reintento es idempotente", async () => {
  const store = new InMemoryMemoryStore();
  await store.createMeeting({ id: "meeting-current", workspaceId: context.workspaceId,
    userId: context.userId, title: "Demo", participants: ["Ana"] });
  let executions = 0;
  const gateway: CalendarGateway = {
    async create(_payload: CalendarAction) { executions += 1; return { id: "calendar-1" }; },
    async update(_payload: CalendarAction) { executions += 1; return { id: "calendar-1" }; },
  };
  const executor = new ActionExecutor(store, gateway);
  const proposed = await executor.proposeCalendarEvent(context, "meeting-current", {
    title: "Revisar informe", startDateTime: "2026-09-14T10:00:00-06:00",
    endDateTime: "2026-09-14T11:00:00-06:00", description: "", attendeeEmails: [], eventId: null,
  }, "correlation");
  assert.equal(executions, 0);
  assert.equal(proposed.status, "awaiting_confirmation");
  const completed = await executor.confirmCalendarEvent(context, proposed.id);
  assert.equal(executions, 1);
  assert.equal(completed.status, "completed");
  await executor.confirmCalendarEvent(context, proposed.id);
  assert.equal(executions, 1);
});

test("una señal con baja confianza no se presenta como hecho", async () => {
  const orchestrator: InterventionOrchestrator = new HeuristicOrchestrator();
  const lowConfidence: MeetingSignal = {
    id: "low", meetingId: "meeting-current", segmentSequence: 9, type: "risk",
    payload: { stage: "mentioned" }, confidence: 0.4, urgency: 0.2, novelty: 0.2,
    evidenceSegmentIds: ["segment-9"], relatedEntities: [], shouldRetrieveContext: false,
    retrievalQuery: null,
  };
  const result = await orchestrator.decide({ segment: segment("Tal vez haya un riesgo", 9),
    state: EMPTY_MEETING_STATE, signal: lowConfidence, evidence: [] });
  assert.equal(result.kind, "silent");
});
