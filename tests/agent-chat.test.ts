import assert from "node:assert/strict";
import test from "node:test";
import { ActionExecutor, CalendarGateway } from "../src/action-executor";
import {
  AgentChatDependencies,
  AgentChatService,
  ChatRequestSchema,
  ChatToolbox,
  HeuristicChatModel,
} from "../src/agent-chat";
import { RequestContext } from "../src/contracts";
import { InMemoryMemoryStore } from "../src/memory/in-memory-store";
import { NullEmbeddingProvider } from "../src/services/embeddings";
import { KnowledgeRetrievalService } from "../src/services/retrieval";

const context: RequestContext = { workspaceId: "workspace-a", userId: "ana" };

function setup() {
  const store = new InMemoryMemoryStore();
  let executions = 0;
  const gateway: CalendarGateway = {
    async create() { executions += 1; return { id: "calendar-1" }; },
    async update() { executions += 1; return { id: "calendar-1" }; },
  };
  const gmailQueries: string[] = [];
  const deps: AgentChatDependencies = {
    store,
    retrieval: new KnowledgeRetrievalService(store, new NullEmbeddingProvider()),
    actions: new ActionExecutor(store, gateway),
    searchDrive: async (query) => [{ id: "file-1", name: `Presupuesto ${query}`,
      webViewLink: "https://drive.google.com/file-1", modifiedTime: null }],
    searchGmail: async (query) => {
      gmailQueries.push(query);
      return [{ id: "m1", subject: "Factura septiembre", from: "billing@example.com", date: "",
        snippet: "Adjunto la factura", webViewLink: "https://mail.google.com/m1" }];
    },
  };
  return { store, deps, gmailQueries, service: new AgentChatService(deps, new HeuristicChatModel()),
    executions: () => executions };
}

const ask = (message: string, meetingId: string | null = null) => ChatRequestSchema.parse({ message, meetingId });

test("el chat busca en Gmail y devuelve los correos como tarjeta", async () => {
  const { service, gmailQueries } = setup();
  const result = await service.respond(context, ask("Busca el correo de facturación"));
  assert.deepEqual(gmailQueries, ["facturación"]);
  assert.equal(result.attachments[0]?.kind, "gmail");
  assert.match(result.reply, /1 correo/);
});

test("el chat prepara un borrador de correo pero no lo envía", async () => {
  const { service } = setup();
  const result = await service.respond(context, ask("Redacta un correo a ana@example.com con las notas"));
  const draft = result.attachments[0];
  assert.equal(draft?.kind, "email_draft");
  assert.deepEqual(draft?.kind === "email_draft" ? draft.to : null, ["ana@example.com"]);
  assert.match(result.reply, /borrador/i);
});

test("el resumen desde el chat requiere que el agente esté en una reunión activa", async () => {
  const { service, store } = setup();
  const withoutMeeting = await service.respond(context, ask("Dame el resumen de la reunión"));
  assert.match(withoutMeeting.reply, /activa el agente/i);
  await store.createMeeting({ id: "meeting-1", workspaceId: context.workspaceId, userId: context.userId,
    title: "Seguimiento", participants: [] });
  const withMeeting = await service.respond(context, ask("Dame el resumen de la reunión", "meeting-1"));
  assert.match(withMeeting.reply, /todavía no hay/i);
});

test("un evento propuesto desde el chat no se ejecuta hasta confirmarlo", async () => {
  const { deps, store, executions } = setup();
  await store.createMeeting({ id: "meeting-1", workspaceId: context.workspaceId, userId: context.userId,
    title: "Seguimiento", participants: [] });
  const toolbox = new ChatToolbox(deps, context, ask("Agenda seguimiento", "meeting-1"));
  const proposal = await toolbox.proposeCalendarEvent({ title: "Seguimiento",
    startDateTime: "2026-09-14T10:00:00-06:00", endDateTime: "2026-09-14T10:30:00-06:00",
    description: "", attendeeEmails: [] });
  assert.equal(proposal.status, "awaiting_confirmation");
  assert.equal(executions(), 0);
  const attachment = toolbox.attachments[0];
  assert.equal(attachment?.kind, "calendar_proposal");
  const actionId = attachment?.kind === "calendar_proposal" ? attachment.actionId : "";
  await deps.actions.confirmCalendarEvent(context, actionId);
  assert.equal(executions(), 1);
});
