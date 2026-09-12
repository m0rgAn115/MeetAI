import { randomUUID } from "node:crypto";
import { Agent, RunContext, assistant, run, system, tool, user } from "@openai/agents";
import { z } from "zod";
import { ActionExecutor, CalendarActionSchema } from "./action-executor";
import { MeetingRecord, RequestContext } from "./contracts";
import { MemoryStore } from "./memory/store";
import { AGENT_CHAT_PROMPT, AGENT_CHAT_PROMPT_VERSION } from "./prompts/agent-chat.v1";
import { KnowledgeRetrievalService } from "./services/retrieval";

export const ChatRequestSchema = z.object({
  message: z.string().trim().min(1).max(2000),
  history: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string().max(4000),
  })).max(20).default([]),
  meetingId: z.string().nullable().default(null),
  currentDateTime: z.string().nullable().default(null),
  timeZone: z.string().nullable().default(null),
  utcOffset: z.string().nullable().default(null),
});

export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export interface ChatDriveFile {
  id: string | null;
  name: string;
  webViewLink: string | null;
  modifiedTime: string | null;
}

export interface ChatGmailMessage {
  id: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
  webViewLink: string;
}

export interface ChatMemoryItem {
  summary: string;
  quotedText: string;
  observedAt: string;
  status: string;
  documentUri: string | null;
}

// Tool results the extension renders as cards under the agent reply. Drafts and
// proposals are never executed here: sending or confirming needs a user click.
export type ChatAttachment =
  | { kind: "memory"; query: string; items: ChatMemoryItem[] }
  | { kind: "drive"; query: string; files: ChatDriveFile[] }
  | { kind: "gmail"; query: string; messages: ChatGmailMessage[] }
  | { kind: "calendar_proposal"; actionId: string; title: string; startDateTime: string; endDateTime: string;
      attendeeEmails: string[]; conflict: unknown }
  | { kind: "email_draft"; to: string[]; subject: string; body: string }
  | { kind: "slack_draft"; text: string };

export interface ChatReply {
  reply: string;
  attachments: ChatAttachment[];
}

export interface AgentChatDependencies {
  store: MemoryStore;
  retrieval: KnowledgeRetrievalService;
  actions: ActionExecutor;
  searchDrive(query: string): Promise<ChatDriveFile[]>;
  searchGmail(query: string): Promise<ChatGmailMessage[]>;
}

export class ChatToolbox {
  readonly attachments: ChatAttachment[] = [];

  constructor(
    private readonly deps: AgentChatDependencies,
    readonly context: RequestContext,
    readonly request: ChatRequest,
  ) {}

  async searchMemory(query: string): Promise<ChatMemoryItem[]> {
    const evidence = await this.deps.retrieval.retrieveContext({ ...this.context, query, limit: 5 });
    const items = evidence.map((item) => ({
      summary: item.memory.summary,
      quotedText: item.quotedText,
      observedAt: item.observedAt,
      status: item.memory.status,
      documentUri: item.source.documentUri,
    }));
    if (items.length) this.attachments.push({ kind: "memory", query, items });
    return items;
  }

  async getMeetingSummary() {
    const meeting = await this.requireActiveMeeting();
    return { title: meeting.title, ...meeting.state };
  }

  async searchDrive(query: string): Promise<ChatDriveFile[]> {
    const files = (await this.deps.searchDrive(query)).slice(0, 5).map((file) => ({
      id: file.id, name: file.name, webViewLink: file.webViewLink, modifiedTime: file.modifiedTime,
    }));
    this.attachments.push({ kind: "drive", query, files });
    return files;
  }

  async searchGmail(query: string): Promise<ChatGmailMessage[]> {
    const messages = (await this.deps.searchGmail(query)).slice(0, 5).map((message) => ({
      id: message.id, subject: message.subject, from: message.from, date: message.date,
      snippet: message.snippet, webViewLink: message.webViewLink,
    }));
    this.attachments.push({ kind: "gmail", query, messages });
    return messages;
  }

  async proposeCalendarEvent(input: {
    title: string;
    startDateTime: string;
    endDateTime: string;
    description: string;
    attendeeEmails: string[];
  }) {
    const meeting = await this.requireActiveMeeting();
    const payload = CalendarActionSchema.parse({ ...input, eventId: null });
    const action = await this.deps.actions.proposeCalendarEvent(this.context, meeting.id, payload, randomUUID());
    const conflict = action.preview.conflict ?? null;
    this.attachments.push({
      kind: "calendar_proposal", actionId: action.id, title: payload.title,
      startDateTime: payload.startDateTime, endDateTime: payload.endDateTime,
      attendeeEmails: payload.attendeeEmails, conflict,
    });
    return { status: action.status, requiresUserConfirmation: true, conflict };
  }

  draftEmail(input: { to: string[]; subject: string; body: string }) {
    this.attachments.push({ kind: "email_draft", ...input });
    return { status: "draft_ready", requiresUserToSend: true };
  }

  draftSlackMessage(text: string) {
    this.attachments.push({ kind: "slack_draft", text });
    return { status: "draft_ready", requiresUserToSend: true };
  }

  private async requireActiveMeeting(): Promise<MeetingRecord> {
    const meeting = this.request.meetingId
      ? await this.deps.store.getMeeting(this.context, this.request.meetingId)
      : null;
    if (!meeting || meeting.status !== "active") throw new Error("MEETING_NOT_ACTIVE");
    return meeting;
  }
}

export function describeChatToolError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("not connected")) {
    return "Google no está conectado. Abre http://localhost:3000/auth/google para conectarlo.";
  }
  if (message.includes("MEETING_NOT_ACTIVE")) {
    return "Activa el agente dentro de la llamada para usar esta función.";
  }
  if (error instanceof z.ZodError || message.includes("INVALID_TIME")) {
    return "Los datos del evento no son válidos (revisa fechas, horas y correos).";
  }
  return `No pude completarlo: ${message}`;
}

export interface ChatModel {
  respond(toolbox: ChatToolbox): Promise<string>;
}

async function toolOutput(action: () => unknown): Promise<string> {
  try {
    return JSON.stringify(await action());
  } catch (error) {
    return JSON.stringify({ error: describeChatToolError(error) });
  }
}

function toolboxFrom(runContext?: RunContext<ChatToolbox>): ChatToolbox {
  if (!runContext) throw new Error("Chat toolbox is missing from the run context");
  return runContext.context;
}

const chatAgent = new Agent<ChatToolbox>({
  name: "Meet Agent Chat",
  model: process.env.OPENAI_MODEL ?? "gpt-5.6-luna",
  instructions: AGENT_CHAT_PROMPT,
  tools: [
    tool({
      name: "search_memory",
      description: "Busca decisiones, compromisos y contexto de reuniones anteriores.",
      parameters: z.object({ query: z.string() }),
      execute: (args, runContext?: RunContext<ChatToolbox>) =>
        toolOutput(() => toolboxFrom(runContext).searchMemory(args.query)),
    }),
    tool({
      name: "get_meeting_summary",
      description: "Devuelve el estado de la reunión actual: decisiones, compromisos, preguntas y documentos.",
      parameters: z.object({}),
      execute: (_args, runContext?: RunContext<ChatToolbox>) =>
        toolOutput(() => toolboxFrom(runContext).getMeetingSummary()),
    }),
    tool({
      name: "search_drive",
      description: "Busca archivos de Google Drive por nombre o tema.",
      parameters: z.object({ query: z.string() }),
      execute: (args, runContext?: RunContext<ChatToolbox>) =>
        toolOutput(() => toolboxFrom(runContext).searchDrive(args.query)),
    }),
    tool({
      name: "search_gmail",
      description: "Busca correos en Gmail. Acepta sintaxis de búsqueda de Gmail.",
      parameters: z.object({ query: z.string() }),
      execute: (args, runContext?: RunContext<ChatToolbox>) =>
        toolOutput(() => toolboxFrom(runContext).searchGmail(args.query)),
    }),
    tool({
      name: "propose_calendar_event",
      description: "Prepara un evento de Google Calendar para que la persona lo confirme. No lo crea.",
      parameters: z.object({
        title: z.string(),
        startDateTime: z.string().describe("ISO 8601 con desplazamiento, p. ej. 2026-09-14T10:00:00-06:00"),
        endDateTime: z.string().describe("ISO 8601 con desplazamiento"),
        description: z.string(),
        attendeeEmails: z.array(z.string()),
      }),
      execute: (args, runContext?: RunContext<ChatToolbox>) =>
        toolOutput(() => toolboxFrom(runContext).proposeCalendarEvent(args)),
    }),
    tool({
      name: "draft_email",
      description: "Prepara un borrador de correo para que la persona lo revise y lo envíe. No lo envía.",
      parameters: z.object({ to: z.array(z.string()), subject: z.string(), body: z.string() }),
      execute: (args, runContext?: RunContext<ChatToolbox>) =>
        toolOutput(() => toolboxFrom(runContext).draftEmail(args)),
    }),
    tool({
      name: "draft_slack_message",
      description: "Prepara un mensaje de Slack para que la persona lo revise y lo envíe. No lo envía.",
      parameters: z.object({ text: z.string() }),
      execute: (args, runContext?: RunContext<ChatToolbox>) =>
        toolOutput(() => toolboxFrom(runContext).draftSlackMessage(args.text)),
    }),
  ],
});

export class OpenAIChatModel implements ChatModel {
  async respond(toolbox: ChatToolbox): Promise<string> {
    const { request } = toolbox;
    const situation = [
      `Prompt ${AGENT_CHAT_PROMPT_VERSION}`,
      request.currentDateTime && `Fecha y hora local: ${request.currentDateTime}`,
      request.timeZone && `Zona horaria: ${request.timeZone}`,
      request.utcOffset && `Desplazamiento UTC: ${request.utcOffset}`,
      `Agente escuchando una reunión: ${request.meetingId ? "sí" : "no"}`,
    ].filter(Boolean).join(". ");
    const result = await run(chatAgent, [
      system(situation),
      ...request.history
        .filter((message) => message.content.trim())
        .map((message) => message.role === "user" ? user(message.content) : assistant(message.content)),
      user(request.message),
    ], { context: toolbox, maxTurns: 8 });
    const reply = typeof result.finalOutput === "string" ? result.finalOutput.trim() : "";
    return reply || "No tengo una respuesta para eso.";
  }
}

function searchTerms(text: string, noise: RegExp): string {
  return text.replace(noise, " ").replace(/[¿?¡!.,:;"]/g, " ").replace(/\s+/g, " ").trim() || text;
}

// Deterministic router for DEMO_MODE, mirroring HeuristicObserver.
export class HeuristicChatModel implements ChatModel {
  async respond(toolbox: ChatToolbox): Promise<string> {
    const text = toolbox.request.message;
    const lower = text.toLocaleLowerCase();
    try {
      if (/slack/.test(lower)) {
        toolbox.draftSlackMessage(text.replace(/^.*?slack\s*[:,]?\s*/i, "").trim() || text);
        return "Te dejé el mensaje de Slack listo para revisar y enviar.";
      }
      if (/(redacta|escribe|manda|env[ií]a|prepara|draft|write|send).*(correo|email|mail)/.test(lower)) {
        toolbox.draftEmail({
          to: text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) ?? [],
          subject: "Seguimiento de la reunión",
          body: text,
        });
        return "Te dejé un borrador de correo listo para revisar antes de enviarlo.";
      }
      if (/(correo|email|mail|gmail|inbox|bandeja)/.test(lower)) {
        const query = searchTerms(text, /\b(busca|buscar|encuentra|revisa|search|find|el|la|los|las|un|una|de|del|mi|mis|[uú]ltimo|correos?|emails?|mail|gmail|the|an?)\b/gi);
        const messages = await toolbox.searchGmail(query);
        return messages.length
          ? `Encontré ${messages.length} correo(s) para “${query}”.`
          : `No encontré correos para “${query}”.`;
      }
      if (/(drive|documento|archivo|presentaci[oó]n|pdf|hoja de c[aá]lculo|file|document)/.test(lower)) {
        const query = searchTerms(text, /\b(busca|buscar|encuentra|abre|search|find|open|en|el|la|los|las|un|una|de|del|drive|documento|archivo|file|document|the|an?)\b/gi);
        const files = await toolbox.searchDrive(query);
        return files.length
          ? `Encontré ${files.length} archivo(s) en Drive para “${query}”.`
          : `No encontré archivos en Drive para “${query}”.`;
      }
      if (/(agenda|programa|calendar|calendario|evento|schedule)/.test(lower)) {
        return "En modo demo no interpreto fechas. Configura OpenAI para preparar eventos de Calendar desde el chat.";
      }
      if (/(resumen|resume|resumir|decisiones|compromisos|pendientes|summary)/.test(lower)) {
        const summary = await toolbox.getMeetingSummary();
        const lines = [
          summary.activeDecisions.length && `Decisiones: ${summary.activeDecisions.join("; ")}`,
          summary.commitments.length && `Compromisos: ${summary.commitments.join("; ")}`,
          summary.openQuestions.length && `Preguntas abiertas: ${summary.openQuestions.join("; ")}`,
        ].filter(Boolean);
        return lines.length ? lines.join("\n") : "Todavía no hay decisiones ni compromisos en esta reunión.";
      }
      const memories = await toolbox.searchMemory(text);
      return memories.length ? memories[0].summary : "No encontré nada relacionado en la memoria.";
    } catch (error) {
      return describeChatToolError(error);
    }
  }
}

export class AgentChatService {
  constructor(
    private readonly deps: AgentChatDependencies,
    private readonly model: ChatModel,
  ) {}

  async respond(context: RequestContext, request: ChatRequest): Promise<ChatReply> {
    const toolbox = new ChatToolbox(this.deps, context, request);
    const reply = await this.model.respond(toolbox);
    return { reply, attachments: toolbox.attachments };
  }
}
