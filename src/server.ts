import "dotenv/config";
import { randomUUID } from "node:crypto";
import path from "node:path";
import cors from "cors";
import express, { Request } from "express";
import { ActionExecutor, CalendarActionSchema, DemoCalendarGateway, GoogleCalendarGateway } from "./action-executor";
import { authenticateRequest } from "./auth";
import { getGoogleAuthUrl, initializeGoogleOAuth, isGoogleCalendarConnected, saveGoogleAuthCode } from "./calendar";
import { RequestContext } from "./contracts";
import { isDatabaseConfigured } from "./db";
import { searchDriveFiles } from "./drive";
import {
  HeuristicObserver,
  HeuristicOrchestrator,
  LiveCopilot,
  OpenAIInterventionOrchestrator,
  OpenAIObserver,
} from "./live-copilot";
import { HeuristicCuratorModel, MemoryCuratorWorker, OpenAICuratorModel } from "./memory-curator";
import { InMemoryMemoryStore } from "./memory/in-memory-store";
import { MemoryObserver } from "./memory-observer";
import { PostgresMemoryStore } from "./memory/postgres-store";
import { MemoryStore } from "./memory/store";
import { NullEmbeddingProvider, OpenAIEmbeddingProvider } from "./services/embeddings";
import { KnowledgeRetrievalService } from "./services/retrieval";
import { searchGmailMessages, sendGmailMessage } from "./gmail";

const app = express();
const PORT = Number(process.env.PORT ?? 3000);
const demoMode = process.env.DEMO_MODE === "true";
const useHeuristics = demoMode;

const store: MemoryStore = isDatabaseConfigured() ? new PostgresMemoryStore() : new InMemoryMemoryStore();
const embeddings = process.env.OPENAI_API_KEY ? new OpenAIEmbeddingProvider() : new NullEmbeddingProvider();
const retrieval = new KnowledgeRetrievalService(store, embeddings);
const copilot = new LiveCopilot(
  store,
  retrieval,
  useHeuristics ? new HeuristicObserver() : new OpenAIObserver(),
  useHeuristics ? new HeuristicOrchestrator() : new OpenAIInterventionOrchestrator(),
);
const curator = new MemoryCuratorWorker(
  store,
  retrieval,
  useHeuristics ? new HeuristicCuratorModel() : new OpenAICuratorModel(),
  embeddings,
);
const actionExecutor = new ActionExecutor(
  store,
  demoMode ? new DemoCalendarGateway() : new GoogleCalendarGateway(),
);
const activeMeetings = new Map<string, string>();
const memoryObserver = isDatabaseConfigured() ? new MemoryObserver() : null;

app.use(express.json({ limit: "1mb" }));
app.use(cors());

function localObserverOnly(req: Request, res: express.Response, next: express.NextFunction): void {
  const host = req.hostname.toLowerCase();
  if (["localhost", "127.0.0.1", "::1"].includes(host)) return next();
  res.status(403).json({ error: "MEMORY_OBSERVER_LOCALHOST_ONLY" });
}

app.get("/memory-observer", localObserverOnly, (_req, res) => {
  if (!memoryObserver) return res.status(409).json({ error: "MEMORY_OBSERVER_REQUIRES_POSTGRES" });
  return res.sendFile(path.join(process.cwd(), "public", "memory-observer.html"));
});

app.get("/memory-observer/api/snapshot", localObserverOnly, async (req, res) => {
  if (!memoryObserver) return res.status(409).json({ error: "MEMORY_OBSERVER_REQUIRES_POSTGRES" });
  try {
    const workspaceId = typeof req.query.workspaceId === "string" && req.query.workspaceId ? req.query.workspaceId : undefined;
    return res.json(await memoryObserver.snapshot(workspaceId));
  } catch (error) { return sendError(res, error); }
});

app.get("/memory-observer/api/events", localObserverOnly, (req, res) => {
  if (!memoryObserver) return res.status(409).end();
  const workspaceId = typeof req.query.workspaceId === "string" && req.query.workspaceId ? req.query.workspaceId : null;
  res.status(200).set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  res.write("retry: 2000\n\n");
  const unsubscribe = memoryObserver.subscribe((event) => {
    if (!workspaceId || event.workspaceId === workspaceId) {
      res.write(`event: activity\ndata: ${JSON.stringify(event)}\n\n`);
    }
  });
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 20_000);
  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

function identityKey(context: RequestContext): string {
  return `${context.workspaceId}:${context.userId}`;
}

function sendError(res: express.Response, error: unknown): express.Response {
  const message = error instanceof Error ? error.message : String(error);
  const status = message.includes("UNAUTHENTICATED") ? 401
    : message.includes("FORBIDDEN") ? 403
    : message.includes("NOT_FOUND") ? 404
    : message.includes("NOT_ACTIVE") || message.includes("ALREADY_PROCESSING") ? 409
    : message.includes("INVALID") || message.includes("required") ? 400
    : 500;
  console.error("Request failed:", error);
  return res.status(status).json({ error: message });
}

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "Meet Agent Backend",
    persistence: isDatabaseConfigured() ? "postgresql" : "in-memory-demo",
    liveCopilot: useHeuristics ? "deterministic-demo" : "openai-structured-output",
    calendar: demoMode ? "simulated" : "google",
    openAIConfigured: Boolean(process.env.OPENAI_API_KEY),
    googleOAuthConfigured: Boolean(
      process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI
    ),
    authentication: process.env.ALLOW_LOCAL_IDENTITY === "true" ? "local-single-user" : "supabase-jwt",
  });
});

app.post("/meeting/start", async (req, res) => {
  try {
    const context = await authenticateRequest(req);
    const meeting = await store.createMeeting({
      id: typeof req.body?.meetingId === "string" ? req.body.meetingId : undefined,
      workspaceId: context.workspaceId,
      userId: context.userId,
      title: typeof req.body?.title === "string" ? req.body.title : "Google Meet",
      participants: Array.isArray(req.body?.participants) ? req.body.participants.map(String) : [],
      metadata: { source: "chrome-extension", meetUrl: req.body?.meetUrl ?? null },
    });
    activeMeetings.set(identityKey(context), meeting.id);
    return res.json({ success: true, meetingActive: true, meetingId: meeting.id,
      workspaceId: context.workspaceId, userId: context.userId });
  } catch (error) { return sendError(res, error); }
});

app.post("/meeting/end", async (req, res) => {
  try {
    const context = await authenticateRequest(req);
    const meetingId = String(req.body?.meetingId ?? activeMeetings.get(identityKey(context)) ?? "");
    if (!meetingId) throw new Error("meetingId is required");
    const meeting = await store.endMeeting(context, meetingId);
    activeMeetings.delete(identityKey(context));
    const correlationId = randomUUID();
    await store.enqueueJob({
      workspaceId: context.workspaceId,
      meetingId,
      eventType: "meeting.ended",
      correlationId,
      idempotencyKey: `curate:meeting-ended:${meetingId}`,
      payload: { userId: context.userId, meetingId, state: meeting.state },
    });
    const pendingActions = await store.listPendingActions(context, meetingId);
    return res.json({
      success: true,
      meetingActive: false,
      meetingId,
      closing: {
        kind: "meeting_close",
        title: "Cierre de 60 segundos",
        decisions: meeting.state.activeDecisions,
        commitments: meeting.state.commitments,
        openQuestions: meeting.state.openQuestions,
        documents: meeting.state.referencedDocuments,
        pendingActions: pendingActions.map((action) => String(action.preview.title ?? action.actionType)),
      },
    });
  } catch (error) { return sendError(res, error); }
});

const analyzeFinalSegment: express.RequestHandler = async (req, res) => {
  try {
    const context = await authenticateRequest(req);
    const meetingId = String(req.body?.meetingId ?? activeMeetings.get(identityKey(context)) ?? "");
    const speaker = typeof req.body?.speaker === "string" ? req.body.speaker.trim() : "";
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!meetingId || !speaker || !text) throw new Error("meetingId, speaker and text are required");
    const previous = await store.getRecentSegments(meetingId, 1);
    const sequence = Number.isInteger(req.body?.sequence)
      ? Number(req.body.sequence)
      : (previous.at(-1)?.sequence ?? 0) + 1;
    const segment = await store.addFinalSegment({
      id: typeof req.body?.segmentId === "string" ? req.body.segmentId : undefined,
      meetingId,
      sequence,
      speakerId: speaker,
      text,
      startedAt: req.body?.startedAt ?? null,
      endedAt: req.body?.endedAt ?? new Date().toISOString(),
      metadata: { source: req.body?.source ?? "meet_caption", isFinal: true },
    });
    const result = await copilot.processFinalSegment(context, segment, {
      currentDateTime: req.body?.currentDateTime,
      timeZone: req.body?.timeZone,
    });
    let proposedAction = null;
    if (result.intervention.proposedAction) {
      proposedAction = await actionExecutor.proposeCalendarEvent(
        context,
        meetingId,
        CalendarActionSchema.parse({ ...result.intervention.proposedAction, eventId: null }),
        result.correlationId,
      );
    }
    return res.json(toExtensionEvent(result, proposedAction?.id ?? null));
  } catch (error) { return sendError(res, error); }
};

// /analyze remains for extension compatibility; the event-named route is the
// stable contract for future tabCapture/STT producers.
app.post("/analyze", analyzeFinalSegment);
app.post("/events/transcript.segment.final", analyzeFinalSegment);

app.post("/actions/calendar/propose", async (req, res) => {
  try {
    const context = await authenticateRequest(req);
    const meetingId = String(req.body?.meetingId ?? activeMeetings.get(identityKey(context)) ?? "");
    if (!meetingId) throw new Error("meetingId is required");
    const action = await actionExecutor.proposeCalendarEvent(
      context, meetingId, CalendarActionSchema.parse(req.body.action),
      String(req.body.correlationId ?? randomUUID()), req.body.memoryId ?? null,
    );
    return res.status(201).json({ success: true, action });
  } catch (error) { return sendError(res, error); }
});

app.post("/actions/:id/confirm", async (req, res) => {
  try {
    const context = await authenticateRequest(req);
    const action = await actionExecutor.confirmCalendarEvent(context, req.params.id, req.body?.editedAction);
    return res.json({ success: true, action });
  } catch (error) { return sendError(res, error); }
});

app.post("/signals/:id/feedback", async (req, res) => {
  try {
    const context = await authenticateRequest(req);
    const reaction = String(req.body?.reaction ?? "");
    if (!["accepted", "edited", "dismissed", "postponed"].includes(reaction)) throw new Error("INVALID_REACTION");
    await store.recordSignalFeedback(context, req.params.id, reaction, {
      note: req.body?.note ?? null,
      recordedAt: new Date().toISOString(),
      idempotencyKey: req.body?.idempotencyKey ?? `${req.params.id}:${context.userId}:${reaction}`,
    });
    return res.json({ success: true });
  } catch (error) { return sendError(res, error); }
});

app.post("/memory/retrieve", async (req, res) => {
  try {
    const context = await authenticateRequest(req);
    const evidence = await retrieval.retrieveContext({ ...context, query: String(req.body?.query ?? ""),
      asOf: req.body?.asOf, limit: req.body?.limit, includeDrive: Boolean(req.body?.includeDrive) });
    return res.json({ evidence });
  } catch (error) { return sendError(res, error); }
});

app.get("/auth/google", (_req, res) => res.redirect(getGoogleAuthUrl()));
app.get("/auth/google/callback", async (req, res) => {
  try {
    if (!req.query.code || typeof req.query.code !== "string") throw new Error("Missing authorization code");
    await saveGoogleAuthCode(req.query.code);
    return res.send("<html><body style='font-family:Arial;background:#111;color:white;padding:40px'><h2>Google account connected</h2><p>You can close this tab and return to Google Meet.</p></body></html>");
  } catch (error) { return res.status(500).send(error instanceof Error ? error.message : "OAuth failed"); }
});
app.get("/calendar/status", (_req, res) => res.json({ connected: isGoogleCalendarConnected() }));

app.post("/calendar/create", (_req, res) => res.status(410).json({
  error: "Use POST /actions/calendar/propose and POST /actions/:id/confirm",
}));
app.patch("/calendar/update", (_req, res) => res.status(410).json({
  error: "Use POST /actions/calendar/propose and POST /actions/:id/confirm",
}));

app.post("/drive/search", async (req, res) => {
  try {
    await authenticateRequest(req);
    const query = String(req.body?.query ?? "").trim();
    if (!query) throw new Error("query is required");
    return res.json({ success: true, files: await searchDriveFiles(query) });
  } catch (error) { return sendError(res, error); }
});

function toExtensionEvent(result: Awaited<ReturnType<LiveCopilot["processFinalSegment"]>>, proposedActionId: string | null) {
  const { signal, intervention, evidence } = result;
  const typeMap: Record<string, string> = {
    commitment: "commitment", decision: "action_item", change: "change_request",
    possible_contradiction: "contradiction", question: "context",
    document_reference: "file_search", risk: "context", topic_boundary: "none", noop: "none",
  };
  const calendar = intervention.proposedAction;
  return {
    type: typeMap[signal.type] ?? "none",
    shouldIntervene: intervention.kind !== "silent",
    speaker: signal.relatedEntities[0] ?? null,
    owner: typeof signal.payload.owner === "string" ? signal.payload.owner : null,
    summary: intervention.message,
    action: typeof signal.payload.action === "string" ? signal.payload.action : intervention.message,
    deadline: typeof signal.payload.deadline === "string" ? signal.payload.deadline : null,
    conflictWith: evidence[0]?.quotedText ?? null,
    confidence: signal.confidence,
    calendarTitle: calendar?.title ?? null,
    calendarStart: calendar?.startDateTime ?? null,
    calendarEnd: calendar?.endDateTime ?? null,
    attendeeEmails: calendar?.attendeeEmails ?? null,
    driveQuery: signal.type === "document_reference" ? signal.retrievalQuery : null,
    driveResults: evidence.filter((item) => item.source.type === "google_drive").map((item) => ({
      id: item.source.sourceId, name: item.memory.content, webViewLink: item.source.documentUri,
      modifiedTime: item.observedAt, mimeType: null, owner: null,
    })),
    calendarConflict: null,
    meetingId: signal.meetingId,
    segmentSequence: signal.segmentSequence,
    correlationId: result.correlationId,
    signalId: signal.id,
    signal,
    intervention,
    evidence,
    proposedActionId,
  };
}

app.post("/gmail/search", async (req, res) => {
  try {
    await authenticateRequest(req);
    const query = String(req.body?.query ?? "").trim();
    if (!query) throw new Error("query is required");
    return res.json({ success: true, messages: await searchGmailMessages(query) });
  } catch (error) { return sendError(res, error); }
});

// This endpoint only fires when the user explicitly confirms sending from the
// extension UI — the agent never calls this automatically, it only prepares a draft.
app.post("/gmail/send", async (req, res) => {
  try {
    await authenticateRequest(req);
    if (!isGoogleCalendarConnected()) throw new Error("Google account is not connected");
    const { to, subject, body } = req.body ?? {};
    if (!to || !subject || !body) throw new Error("to, subject and body are required");
    return res.json({ success: true, result: await sendGmailMessage(to, subject, body) });
  } catch (error) { return sendError(res, error); }
});

async function startServer(): Promise<void> {
  await initializeGoogleOAuth();
  curator.start();
  if (memoryObserver) void memoryObserver.start().catch((error) => console.error("Memory observer listener failed:", error));
  app.listen(PORT, () => {
    console.log(`Meet Agent backend running on http://localhost:${PORT}`);
    if (!isDatabaseConfigured()) console.warn("DATABASE_URL is absent; using non-persistent demo memory");
  });
}

void startServer().catch((error) => {
  console.error("Meet Agent failed to start:", error);
  process.exit(1);
});
