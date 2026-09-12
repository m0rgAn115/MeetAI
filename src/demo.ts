import { ActionExecutor, CalendarAction, CalendarGateway } from "./action-executor";
import { RequestContext } from "./contracts";
import { HeuristicObserver, HeuristicOrchestrator, LiveCopilot } from "./live-copilot";
import { HeuristicCuratorModel, MemoryCuratorWorker } from "./memory-curator";
import { InMemoryMemoryStore } from "./memory/in-memory-store";
import { NullEmbeddingProvider } from "./services/embeddings";
import { KnowledgeRetrievalService } from "./services/retrieval";

const context: RequestContext = { workspaceId: "demo-workspace", userId: "ana", projectId: "meet-ai" };
const store = new InMemoryMemoryStore();
const retrieval = new KnowledgeRetrievalService(store, new NullEmbeddingProvider());
const copilot = new LiveCopilot(store, retrieval, new HeuristicObserver(), new HeuristicOrchestrator(), 10);
const curator = new MemoryCuratorWorker(store, retrieval, new HeuristicCuratorModel());

async function say(meetingId: string, sequence: number, text: string) {
  const item = await store.addFinalSegment({
    meetingId, sequence, speakerId: "Ana", text,
    endedAt: new Date(Date.UTC(2026, 8, 12, 15, sequence)).toISOString(),
  });
  const result = await copilot.processFinalSegment(context, item);
  console.log(`\n${sequence}. “${text}”`);
  console.log(`   señal: ${result.signal.type}`);
  console.log(`   intervención: ${result.intervention.kind} — ${result.intervention.message ?? "silencio"}`);
  if (result.evidence[0]) console.log(`   evidencia: “${result.evidence[0].quotedText}”`);
  return result;
}

async function main() {
  await store.createMeeting({ id: "previous-meeting", workspaceId: context.workspaceId,
    userId: context.userId, title: "Planeación anterior", participants: ["Ana"] });
  await store.persistMutations(context, "seed", "seed-friday", [{
    operation: "ADD", targetMemoryId: null,
    node: {
      clientId: "delivery-friday", projectId: "meet-ai",
      content: "Ana entregará el informe el viernes.",
      summary: "La entrega del informe está prevista para el viernes.",
      status: "confirmed", confidence: 0.94, importance: 0.9,
      observedAt: "2026-09-05T15:15:00.000Z", validFrom: "2026-09-05T15:15:00.000Z",
      validUntil: null, createdBy: "memory-curator",
      metadata: { semanticHint: "commitment", stage: "confirmed", relatedEntities: ["Ana", "informe"] },
    },
    edges: [],
    evidence: [{
      memoryClientId: "$new", memoryId: null, sourceType: "transcript_segment", sourceId: "prior-segment",
      meetingId: null, transcriptSegmentId: null, documentUri: null,
      quotedText: "Ana entregará el informe el viernes.", observedAt: "2026-09-05T15:15:00.000Z",
      permissionsSnapshot: { visibility: "workspace" }, metadata: {},
    }],
    confidence: 0.94, explanation: "Decisión de la reunión anterior", requiresHumanReview: false,
  }]);

  await store.createMeeting({ id: "current-meeting", workspaceId: context.workspaceId,
    userId: context.userId, title: "Seguimiento", participants: ["Ana"] });

  await say("current-meeting", 1, "¿Cuál es la fecha de entrega del informe?");
  await say("current-meeting", 2, "Lo revisamos el lunes.");
  await say("current-meeting", 3, "Confirmo que la entrega cambia del viernes al lunes.");
  await curator.tick();

  const current = await retrieval.retrieveContext({ ...context, query: "fecha entrega informe", limit: 5 });
  console.log("\n4. Grafo después de confirmar el cambio");
  console.log(`   vigente: ${current[0]?.memory.summary}`);
  console.log(`   relación: ${current[0]?.relationsUsed[0]?.label}`);
  console.log(`   versión anterior: ${store.memories.get("delivery-friday")?.content}`);

  let calendarExecutions = 0;
  const calendar: CalendarGateway = {
    async create(_payload: CalendarAction) { calendarExecutions += 1; return { id: "calendar-demo" }; },
    async update(_payload: CalendarAction) { calendarExecutions += 1; return { id: "calendar-demo" }; },
  };
  const executor = new ActionExecutor(store, calendar);
  const action = await executor.proposeCalendarEvent(context, "current-meeting", {
    title: "Entrega del informe", startDateTime: "2026-09-14T10:00:00-06:00",
    endDateTime: "2026-09-14T11:00:00-06:00", description: "Fecha confirmada en Meet",
    attendeeEmails: [], eventId: null,
  }, "demo-action", current[0]?.memory.id ?? null);
  console.log(`\n5. Preview Calendar: ${action.status}; ejecuciones=${calendarExecutions}`);
  const completed = await executor.confirmCalendarEvent(context, action.id);
  console.log(`   tras confirmar: ${completed.status}; ejecuciones=${calendarExecutions}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
