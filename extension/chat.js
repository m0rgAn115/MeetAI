// ============================================================
// AGENT CHAT
// ============================================================
// Written chat with the agent inside the panel. Loaded after
// content.js (see manifest.json), so it reuses its state and
// helpers: escapeHtml, agentIcon, clampElementToViewport,
// sendGmailFromAgent, sendSlackFromAgent, currentMeetingId…
//
// The backend only searches and prepares drafts or proposals.
// Calendar, Gmail and Slack still run only after a click here.

const CHAT_HISTORY_LIMIT = 12;

const chatHistory = [];

let chatPending = false;

// Suggestions ending with a space are filled in for the person to
// finish; the rest are sent right away.
const CHAT_SUGGESTIONS = [
  { label: "Resumen de la reunión", text: "Resume lo que llevamos de la reunión" },
  { label: "Buscar un correo", text: "Busca el último correo de " },
  { label: "Buscar en Drive", text: "Encuentra en Drive el documento de " },
  { label: "Agendar seguimiento", text: "Agenda un seguimiento de 30 minutos mañana a las 10 con " },
];


// ============================================================
// CHAT UI
// ============================================================

function createAgentChat() {

  const panel = document.getElementById("meet-agent-panel");

  if (!panel || document.getElementById("meet-agent-chat")) {
    return;
  }

  const chat = document.createElement("div");

  chat.id = "meet-agent-chat";
  chat.className = "meet-agent-chat";

  chat.innerHTML = `
    <div id="meet-agent-chat-log" class="meet-agent-chat-log" role="log" aria-live="polite">
      <div class="meet-agent-chat-empty">
        Pídele al agente que busque algo o prepare una acción.
        <div class="meet-agent-chat-suggestions">
          ${CHAT_SUGGESTIONS.map((suggestion) => `
            <button type="button" data-chat-suggestion="${escapeAttribute(suggestion.text)}">${escapeHtml(suggestion.label)}</button>
          `).join("")}
        </div>
      </div>
    </div>

    <form id="meet-agent-chat-form" class="meet-agent-chat-form">
      <textarea
        id="meet-agent-chat-input"
        rows="1"
        maxlength="2000"
        placeholder="Escríbele al agente…"
        aria-label="Mensaje para Meet Agent"
      ></textarea>
      <button id="meet-agent-chat-send" class="meet-agent-chat-send" type="submit" aria-label="Enviar">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>
      </button>
    </form>
  `;

  panel.appendChild(chat);

  setupAgentChat(chat);
}


function setupAgentChat(chat) {

  const form = chat.querySelector("#meet-agent-chat-form");
  const input = chat.querySelector("#meet-agent-chat-input");
  const log = chat.querySelector("#meet-agent-chat-log");

  // Keep typing in the chat from triggering Meet's keyboard shortcuts.
  ["keydown", "keyup", "keypress"].forEach((type) => {
    chat.addEventListener(type, (event) => event.stopPropagation());
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  input.addEventListener("input", () => resizeChatInput(input));

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!input.value.trim() || chatPending) return;
    const text = input.value;
    input.value = "";
    resizeChatInput(input);
    submitChatMessage(text);
  });

  log.addEventListener("click", (event) => {
    const suggestion = event.target.closest("[data-chat-suggestion]");
    if (suggestion) {
      const text = suggestion.dataset.chatSuggestion;
      if (text.endsWith(" ")) {
        input.value = text;
        resizeChatInput(input);
        input.focus();
        input.setSelectionRange(text.length, text.length);
      } else {
        submitChatMessage(text);
      }
      return;
    }
    const actionButton = event.target.closest("[data-chat-action]");
    if (actionButton) handleChatCardAction(actionButton);
  });
}


// Used by renderAgentEvent so a live recommendation doesn't close
// the panel while the person is typing or waiting for an answer.
function isAgentChatInUse() {
  const chat = document.getElementById("meet-agent-chat");
  return Boolean(chat) && (chatPending || chat.contains(document.activeElement));
}


function resizeChatInput(input) {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 96)}px`;
}


function setChatBusy(busy) {
  const send = document.getElementById("meet-agent-chat-send");
  if (send) send.disabled = busy;
}


function appendChatMessage(role, html) {
  const log = document.getElementById("meet-agent-chat-log");
  const message = document.createElement("div");
  message.className = `meet-agent-chat-msg meet-agent-chat-msg--${role}`;
  message.innerHTML = html;
  log.appendChild(message);
  scrollChatToBottom();
  return message;
}


function scrollChatToBottom() {
  const log = document.getElementById("meet-agent-chat-log");
  if (log) log.scrollTop = log.scrollHeight;
  requestAnimationFrame(() => {
    clampElementToViewport(document.getElementById("meet-agent-panel"));
  });
}


// ============================================================
// SEND CHAT MESSAGE
// ============================================================

function localTimingContext() {

  const now = new Date();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const offset = -now.getTimezoneOffset();
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
  const minutes = String(Math.abs(offset) % 60).padStart(2, "0");

  return {
    currentDateTime: now.toLocaleString("en-US", {
      timeZone,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }),
    timeZone,
    utcOffset: `${offset >= 0 ? "+" : "-"}${hours}:${minutes}`,
  };
}


async function sendChatToBackend(message, history) {

  const response = await fetch(
    "http://localhost:3000/agent/chat",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        history,
        meetingId: meetingActive ? currentMeetingId : null,
        workspaceId: currentWorkspaceId,
        userId: currentUserId,
        ...localTimingContext(),
      }),
    }
  );

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error ?? `Backend returned ${response.status}`);
  }

  return payload;
}


async function submitChatMessage(text) {

  const message = text.trim();

  if (!message || chatPending) {
    return;
  }

  document.querySelector("#meet-agent-chat-log .meet-agent-chat-empty")?.remove();

  chatPending = true;
  setChatBusy(true);

  appendChatMessage("user", `<div class="meet-agent-chat-bubble">${escapeHtml(message)}</div>`);

  const pending = appendChatMessage(
    "assistant",
    `<div class="meet-agent-chat-bubble"><span class="meet-agent-chat-typing" aria-label="El agente está escribiendo"><i></i><i></i><i></i></span></div>`
  );

  const history = chatHistory.slice(-CHAT_HISTORY_LIMIT);

  try {

    const { reply, attachments } = await sendChatToBackend(message, history);

    chatHistory.push(
      { role: "user", content: message },
      { role: "assistant", content: reply ?? "" }
    );

    pending.innerHTML = `<div class="meet-agent-chat-bubble">${formatChatReply(reply ?? "")}</div>`
      + (Array.isArray(attachments) ? attachments : []).map(renderChatAttachment).join("");

  } catch (error) {

    console.error("Agent chat failed:", error);

    pending.classList.add("meet-agent-chat-msg--error");

    const text = error instanceof TypeError
      ? "No pude conectar con el backend en localhost:3000."
      : `Error: ${error.message}`;

    pending.innerHTML = `<div class="meet-agent-chat-bubble">${escapeHtml(text)}</div>`;

  } finally {

    chatPending = false;
    setChatBusy(false);
    scrollChatToBottom();
    document.getElementById("meet-agent-chat-input")?.focus();
  }
}


// ============================================================
// CHAT ATTACHMENTS
// ============================================================

function escapeAttribute(value) {
  return escapeHtml(value).replace(/"/g, "&quot;");
}


// Escapes first, then renders the little Markdown models still emit
// (**bold**, *italic*, `code`) so it doesn't show up literally.
function formatChatReply(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*(\S(?:[^*\n]*\S)?)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>");
}


// Gmail snippets arrive HTML-encoded (&#39;); decode before escaping.
function decodeHtmlEntities(value) {
  const textarea = document.createElement("textarea");
  textarea.innerHTML = String(value ?? "");
  return textarea.value;
}


function safeChatUrl(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url) ? url : null;
}


function formatChatDate(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}


function chatCard(titleHtml, bodyHtml) {
  return `
    <div class="meet-agent-chat-card">
      <div class="meet-agent-chat-card-title">${titleHtml}</div>
      ${bodyHtml}
    </div>`;
}


function chatResultRow(title, meta, snippet, url) {
  const href = safeChatUrl(url);
  return `
    <div class="meet-agent-drive-result">
      <div class="meet-agent-drive-file-info">
        <div class="meet-agent-drive-name">${escapeHtml(title)}</div>
        ${meta ? `<div class="meet-agent-drive-meta">${escapeHtml(meta)}</div>` : ""}
        ${snippet ? `<div class="meet-agent-chat-snippet">${escapeHtml(snippet)}</div>` : ""}
      </div>
      ${href ? `<a class="meet-agent-drive-open" href="${escapeAttribute(href)}" target="_blank" rel="noopener noreferrer">Abrir</a>` : ""}
    </div>`;
}


function renderChatAttachment(attachment) {

  switch (attachment?.kind) {

    case "memory":
      return chatCard("Memoria", attachment.items.map((item) => {
        const href = safeChatUrl(item.documentUri);
        return `
          <div class="meet-agent-evidence historical">
            <span>${escapeHtml(formatChatDate(item.observedAt))}</span>
            “${escapeHtml(item.quotedText)}”
            ${href ? `<a href="${escapeAttribute(href)}" target="_blank" rel="noopener noreferrer">Abrir fuente</a>` : ""}
          </div>`;
      }).join(""));

    case "drive":
      return chatCard(`${agentIcon("drive")} Drive`, attachment.files.length
        ? attachment.files.map((file) =>
            chatResultRow(file.name, formatChatDate(file.modifiedTime), null, file.webViewLink)
          ).join("")
        : `<div class="meet-agent-drive-empty">Sin archivos para “${escapeHtml(attachment.query)}”.</div>`);

    case "gmail":
      return chatCard("Gmail", attachment.messages.length
        ? attachment.messages.map((message) =>
            chatResultRow(
              message.subject,
              [message.from, formatChatDate(message.date)].filter(Boolean).join(" · "),
              decodeHtmlEntities(message.snippet),
              message.webViewLink
            )
          ).join("")
        : `<div class="meet-agent-drive-empty">Sin correos para “${escapeHtml(attachment.query)}”.</div>`);

    case "calendar_proposal": {
      const conflict = attachment.conflict;
      return chatCard("Evento de Calendar", `
        <div class="meet-agent-drive-name">${escapeHtml(attachment.title)}</div>
        <div class="meet-agent-drive-meta">${escapeHtml(formatChatDate(attachment.startDateTime))} – ${escapeHtml(formatChatDate(attachment.endDateTime))}</div>
        ${attachment.attendeeEmails?.length ? `<div class="meet-agent-drive-meta">${escapeHtml(attachment.attendeeEmails.join(", "))}</div>` : ""}
        ${conflict ? `<div class="meet-agent-conflict">Choca con “${escapeHtml(conflict.summary ?? "otro evento")}” (${escapeHtml(formatChatDate(conflict.start))})</div>` : ""}
        <button type="button" class="meet-agent-action-button" data-chat-action="confirm-calendar" data-action-id="${escapeAttribute(attachment.actionId)}">Confirmar en Calendar</button>
        <div class="meet-agent-human-confirmation">Solo se crea después de este clic.</div>
      `);
    }

    case "email_draft":
      return chatCard("Borrador de correo", `
        <label class="meet-agent-chat-field"><span>Para</span><input data-field="to" type="text" placeholder="correo@ejemplo.com" value="${escapeAttribute((attachment.to ?? []).join(", "))}"></label>
        <label class="meet-agent-chat-field"><span>Asunto</span><input data-field="subject" type="text" value="${escapeAttribute(attachment.subject ?? "")}"></label>
        <label class="meet-agent-chat-field"><span>Mensaje</span><textarea data-field="body" rows="5">${escapeHtml(attachment.body ?? "")}</textarea></label>
        <button type="button" class="meet-agent-action-button" data-chat-action="send-email">Enviar correo</button>
      `);

    case "slack_draft":
      return chatCard("Mensaje de Slack", `
        <label class="meet-agent-chat-field"><textarea data-field="text" rows="3">${escapeHtml(attachment.text ?? "")}</textarea></label>
        <button type="button" class="meet-agent-action-button" data-chat-action="send-slack">Enviar a Slack</button>
      `);

    default:
      return "";
  }
}


// ============================================================
// CHAT CARD ACTIONS (explicit clicks only)
// ============================================================

async function confirmChatCalendarAction(actionId) {

  const response = await fetch(
    `http://localhost:3000/actions/${encodeURIComponent(actionId)}/confirm`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: currentWorkspaceId, userId: currentUserId }),
    }
  );

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error ?? `Backend returned ${response.status}`);
  }

  return payload;
}


async function handleChatCardAction(button) {

  const card = button.closest(".meet-agent-chat-card");
  const action = button.dataset.chatAction;
  const field = (name) => card?.querySelector(`[data-field="${name}"]`)?.value?.trim() ?? "";
  const originalText = button.textContent;

  if (!["confirm-calendar", "send-email", "send-slack"].includes(action)) {
    return;
  }

  button.disabled = true;
  button.textContent = action === "confirm-calendar" ? "Agendando…" : "Enviando…";

  try {

    if (action === "confirm-calendar") {
      const result = await confirmChatCalendarAction(button.dataset.actionId);
      activeCalendarEventId = result.action?.result?.id ?? result.action?.result?.eventId ?? activeCalendarEventId;
      button.textContent = "✓ Agendado";
    }

    if (action === "send-email") {
      if (!field("to") || !field("subject") || !field("body")) {
        throw new Error("Falta destinatario, asunto o mensaje");
      }
      await sendGmailFromAgent(field("to"), field("subject"), field("body"));
      button.textContent = "✓ Correo enviado";
    }

    if (action === "send-slack") {
      if (!field("text")) {
        throw new Error("El mensaje está vacío");
      }
      await sendSlackFromAgent(field("text"));
      button.textContent = "✓ Enviado a Slack";
    }

    button.classList.add("meet-agent-action-button--success");
    card?.querySelectorAll("input, textarea").forEach((input) => { input.disabled = true; });

  } catch (error) {

    console.error("Agent chat action failed:", error);

    button.disabled = false;
    button.textContent = error.message || "Error — reintentar";

    setTimeout(() => { button.textContent = originalText; }, 2500);
  }
}


createAgentChat();
