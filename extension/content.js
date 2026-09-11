console.log("🤖 Meet Agent content script loaded");


// ============================================================
// GLOBAL STATE
// ============================================================

let meetingActive = false;
let panelOpen = false;
let lastAgentEvent = null;
let activeCalendarEventId = null;

const captionTimers = new Map();
const lastSentCaptions = new Map();

const CAPTION_DEBOUNCE_MS = 1500;

const chatMessageTimers = new Map();
const processedChatMessageIds = new Set();

const CHAT_MESSAGE_DEBOUNCE_MS = 800;


// ============================================================
// CREATE PANEL
// ============================================================

function createMeetAgentPanel() {

  if (document.getElementById("meet-agent-root")) {
    return;
  }


  const root = document.createElement("div");

  root.id = "meet-agent-root";


  root.innerHTML = `

    <!-- ========================================== -->
    <!-- FLOATING AGENT BUBBLE                     -->
    <!-- ========================================== -->

    <div
      id="meet-agent-bubble"
      title="Meet Agent"
    >

      <span class="meet-agent-bubble-logo">
        ✦
      </span>

      <span
        id="meet-agent-bubble-status"
        class="meet-agent-bubble-status inactive"
      ></span>

    </div>


    <!-- ========================================== -->
    <!-- FULL CONTROL PANEL                         -->
    <!-- ========================================== -->

    <div
      id="meet-agent-panel"
      class="meet-agent-window hidden"
    >

      <div class="meet-agent-header">
        ✦ Meet Agent
      </div>


      <div class="meet-agent-status">

        <span
          id="meet-agent-status-dot"
          class="meet-agent-status-dot inactive"
        ></span>

        <span id="meet-agent-status-text">
          Not listening
        </span>

      </div>


      <div class="meet-agent-controls">

        <button id="meet-agent-start">
          Start Agent
        </button>

        <button
          id="meet-agent-stop"
          disabled
        >
          Stop
        </button>

      </div>


      <div class="meet-agent-form">

        <input
          id="meet-agent-speaker"
          type="text"
          placeholder="Speaker"
          value="Ana"
        />


        <textarea
          id="meet-agent-text"
          placeholder="Debug transcript"
        ></textarea>


        <button id="meet-agent-analyze">
          Analyze manually
        </button>

      </div>


      <div id="meet-agent-result">
        Start the agent to begin listening.
      </div>

    </div>


    <!-- ========================================== -->
    <!-- CONTEXTUAL RECOMMENDATION                  -->
    <!-- ========================================== -->

    <div
      id="meet-agent-recommendation"
      class="meet-agent-recommendation hidden"
    >
    </div>
  `;


  document.body.appendChild(root);


  setupPanelListeners();

  setupFloatingAgent();
}


function openAgentPanel() {

  const panel =
    document.getElementById(
      "meet-agent-panel"
    );

  const recommendation =
    document.getElementById(
      "meet-agent-recommendation"
    );


  panelOpen = true;

  panel.classList.remove("hidden");


  recommendation.classList.add("hidden");
}


function closeAgentPanel() {

  const panel =
    document.getElementById(
      "meet-agent-panel"
    );


  panelOpen = false;

  panel.classList.add("hidden");


  if (
    lastAgentEvent &&
    lastAgentEvent.shouldIntervene
  ) {

    const recommendation =
      document.getElementById(
        "meet-agent-recommendation"
      );

    recommendation.classList.remove(
      "hidden"
    );
  }
}


function toggleAgentPanel() {

  if (panelOpen) {

    closeAgentPanel();

  } else {

    openAgentPanel();

  }
}


// ============================================================
// FLOATING / DRAGGABLE AGENT
// ============================================================

function setupFloatingAgent() {

  const root =
    document.getElementById(
      "meet-agent-root"
    );

  const bubble =
    document.getElementById(
      "meet-agent-bubble"
    );


  let dragging = false;
  let actuallyDragged = false;

  let startX = 0;
  let startY = 0;

  let startLeft = 0;
  let startTop = 0;


  bubble.addEventListener(
    "pointerdown",
    (event) => {

      dragging = true;
      actuallyDragged = false;


      const rect =
        root.getBoundingClientRect();


      startX = event.clientX;
      startY = event.clientY;

      startLeft = rect.left;
      startTop = rect.top;


      bubble.setPointerCapture(
        event.pointerId
      );
    }
  );


  bubble.addEventListener(
    "pointermove",
    (event) => {

      if (!dragging) {
        return;
      }


      const deltaX =
        event.clientX - startX;

      const deltaY =
        event.clientY - startY;


      if (
        Math.abs(deltaX) > 4 ||
        Math.abs(deltaY) > 4
      ) {

        actuallyDragged = true;
      }


      if (!actuallyDragged) {
        return;
      }


      const bubbleSize = 58;


      const newLeft =
        Math.max(
          8,
          Math.min(
            window.innerWidth -
              bubbleSize -
              8,

            startLeft + deltaX
          )
        );


      const newTop =
        Math.max(
          8,
          Math.min(
            window.innerHeight -
              bubbleSize -
              8,

            startTop + deltaY
          )
        );


      root.style.left =
        `${newLeft}px`;

      root.style.top =
        `${newTop}px`;

      root.style.right =
        "auto";
    }
  );


  bubble.addEventListener(
    "pointerup",
    (event) => {

      dragging = false;


      bubble.releasePointerCapture(
        event.pointerId
      );


      if (!actuallyDragged) {

        toggleAgentPanel();
      }
    }
  );
}


// ============================================================
// PANEL LISTENERS
// ============================================================

function setupPanelListeners() {

  const startButton =
    document.getElementById("meet-agent-start");

  const stopButton =
    document.getElementById("meet-agent-stop");

  const analyzeButton =
    document.getElementById("meet-agent-analyze");


  // ----------------------------------------------------------
  // START
  // ----------------------------------------------------------

  startButton.addEventListener(
    "click",
    async () => {

      const resultContainer =
        document.getElementById("meet-agent-result");


      try {

        resultContainer.innerHTML = `
          <div class="meet-agent-loading">
            Starting agent...
          </div>
        `;


        const response = await fetch(
          "http://localhost:3000/meeting/start",
          {
            method: "POST",
          }
        );


        if (!response.ok) {

          throw new Error(
            `Backend returned ${response.status}`
          );
        }


        clearCaptionMemory();

        activeCalendarEventId = null;
        hideRecommendation(true);

        updateMeetingUI(true);
        closeAgentPanel();


        console.log(
          "🟢 Meet Agent started"
        );


      } catch (error) {

        console.error(
          "Could not start Meet Agent:",
          error
        );


        resultContainer.innerHTML = `
          <div class="meet-agent-error">
            Could not start the agent.
          </div>
        `;
      }
    }
  );


  // ----------------------------------------------------------
  // STOP
  // ----------------------------------------------------------

  stopButton.addEventListener(
    "click",
    async () => {

      const resultContainer =
        document.getElementById("meet-agent-result");


      try {

        const response = await fetch(
          "http://localhost:3000/meeting/end",
          {
            method: "POST",
          }
        );


        if (!response.ok) {

          throw new Error(
            `Backend returned ${response.status}`
          );
        }


        clearCaptionMemory();

        activeCalendarEventId = null;
        hideRecommendation(true);

        updateMeetingUI(false);


        console.log(
          "🔴 Meet Agent stopped"
        );


      } catch (error) {

        console.error(
          "Could not stop Meet Agent:",
          error
        );


        resultContainer.innerHTML = `
          <div class="meet-agent-error">
            Could not stop the agent.
          </div>
        `;
      }
    }
  );


  // ----------------------------------------------------------
  // MANUAL ANALYZE
  // ----------------------------------------------------------

  analyzeButton.addEventListener(
    "click",
    async () => {

      const resultContainer =
        document.getElementById("meet-agent-result");


      const speaker =
        document
          .getElementById("meet-agent-speaker")
          .value
          .trim();


      const text =
        document
          .getElementById("meet-agent-text")
          .value
          .trim();


      if (!speaker || !text) {
        return;
      }


      if (!meetingActive) {

        resultContainer.innerHTML = `
          <div class="meet-agent-error">
            Start the agent first.
          </div>
        `;

        return;
      }


      resultContainer.innerHTML = `
        <div class="meet-agent-loading">
          Analyzing...
        </div>
      `;


      try {

        const event =
          await sendTranscriptToBackend(
            speaker,
            text
          );


        renderAgentEvent(event);


      } catch (error) {

        console.error(
          "Manual analysis failed:",
          error
        );


        resultContainer.innerHTML = `
          <div class="meet-agent-error">
            Could not analyze transcript.
          </div>
        `;
      }
    }
  );
}


// ============================================================
// UPDATE START / STOP UI
// ============================================================

function updateMeetingUI(active) {

  meetingActive = active;

  const bubbleStatus =
    document.getElementById(
      "meet-agent-bubble-status"
    );

  const startButton =
    document.getElementById(
      "meet-agent-start"
    );

  const stopButton =
    document.getElementById(
      "meet-agent-stop"
    );

  const statusText =
    document.getElementById(
      "meet-agent-status-text"
    );

  const statusDot =
    document.getElementById(
      "meet-agent-status-dot"
    );

  const resultContainer =
    document.getElementById(
      "meet-agent-result"
    );


  if (active) {

    bubbleStatus.classList.remove(
      "inactive"
    );

    bubbleStatus.classList.add(
      "active"
    );


    statusText.textContent =
      "Listening";


    statusDot.classList.remove(
      "inactive"
    );

    statusDot.classList.add(
      "active"
    );


    startButton.disabled = true;
    stopButton.disabled = false;


    resultContainer.innerHTML = `
      <div class="meet-agent-silent">
        👂 Listening for meeting context...
      </div>
    `;


  } else {

    bubbleStatus.classList.remove(
      "active"
    );

    bubbleStatus.classList.add(
      "inactive"
    );


    statusText.textContent =
      "Not listening";


    statusDot.classList.remove(
      "active"
    );

    statusDot.classList.add(
      "inactive"
    );


    startButton.disabled = false;
    stopButton.disabled = true;


    resultContainer.innerHTML = `
      <div class="meet-agent-silent">
        Agent stopped.
      </div>
    `;
  }
}


// ============================================================
// CLEAR LOCAL CAPTION MEMORY
// ============================================================

function clearCaptionMemory() {

  captionTimers.forEach(
    (timer) => {
      clearTimeout(timer);
    }
  );


  captionTimers.clear();

  lastSentCaptions.clear();


  chatMessageTimers.forEach(
    (timer) => {
      clearTimeout(timer);
    }
  );


  chatMessageTimers.clear();

  processedChatMessageIds.clear();
}


// ============================================================
// SEND TRANSCRIPT TO BACKEND
// ============================================================

async function sendTranscriptToBackend(
  speaker,
  text
) {

  const timeZone =
    Intl.DateTimeFormat()
      .resolvedOptions()
      .timeZone;

  const now = new Date();

  // Fecha/hora local legible, ya resuelta en la zona horaria
  // del usuario, para que el modelo NO tenga que convertir UTC.
  const currentDateTime =
    now.toLocaleString("en-US", {
      timeZone,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });


  const response = await fetch(
    "http://localhost:3000/analyze",
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
      },

      body: JSON.stringify({
        speaker,
        text,
        currentDateTime,
        timeZone,
      }),
    }
  );


  if (!response.ok) {

    throw new Error(
      `Backend returned ${response.status}`
    );
  }


  return await response.json();
}


// ============================================================
// CREATE CALENDAR EVENT FROM AGENT
// ============================================================

async function createCalendarEventFromAgent(
  event
) {

  if (
    !event.calendarTitle ||
    !event.calendarStart ||
    !event.calendarEnd
  ) {

    throw new Error(
      "Event does not contain calendar information"
    );
  }


  const response = await fetch(
    "http://localhost:3000/calendar/create",
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
      },

      body: JSON.stringify({
        title:
          event.calendarTitle,

        startDateTime:
          event.calendarStart,

        endDateTime:
          event.calendarEnd,

        description:
          event.summary ??
          "Created by Meet Agent",

        attendees:
          event.attendeeEmails ??
          [],
      }),
    }
  );


  if (!response.ok) {

    const error =
      await response.json();


    throw new Error(
      error.error ??
      `Backend returned ${response.status}`
    );
  }


  return await response.json();
}


// ============================================================
// UPDATE CALENDAR EVENT
// ============================================================

async function updateCalendarEventFromAgent(
  event
) {

  if (!activeCalendarEventId) {

    throw new Error(
      "No calendar event exists to update"
    );
  }


  if (
    !event.calendarStart ||
    !event.calendarEnd
  ) {

    throw new Error(
      "Change request has no calendar time"
    );
  }


  const response = await fetch(
    "http://localhost:3000/calendar/update",
    {
      method: "PATCH",

      headers: {
        "Content-Type": "application/json",
      },

      body: JSON.stringify({
        eventId:
          activeCalendarEventId,

        title:
          event.calendarTitle ??
          "Meeting",

        startDateTime:
          event.calendarStart,

        endDateTime:
          event.calendarEnd,

        description:
          event.summary ??
          "Updated by Meet Agent",

        attendees:
          event.attendeeEmails ??
          [],
      }),
    }
  );


  if (!response.ok) {

    const error =
      await response.json();


    throw new Error(
      error.error ??
      `Backend returned ${response.status}`
    );
  }


  return await response.json();
}


// ============================================================
// FORMAT CALENDAR DATE
// ============================================================

function formatCalendarDate(
  isoDate
) {

  if (!isoDate) {
    return "Not specified";
  }


  const date =
    new Date(isoDate);


  return new Intl.DateTimeFormat(
    undefined,
    {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }
  ).format(date);
}


// ============================================================
// ADD TO CALENDAR BUTTON
// ============================================================

function setupCalendarButton(
  event
) {

  const button =
    document.getElementById(
      "meet-agent-add-calendar"
    );


  if (!button) {
    return;
  }


  button.addEventListener(
    "click",
    async () => {

      const originalText =
        button.textContent;


      button.disabled = true;

      button.textContent =
        "Adding...";


      try {

        const result =
          await createCalendarEventFromAgent(
            event
          );


        activeCalendarEventId =
          result.event.id;


        button.textContent =
          "✓ Added to Calendar";


        console.log(
          "📅 Event added to Google Calendar"
        );


      } catch (error) {

        console.error(
          "Calendar error:",
          error
        );


        button.disabled = false;

        button.textContent =
          "Calendar error — retry";


        setTimeout(
          () => {

            button.textContent =
              originalText;

          },
          2500
        );
      }
    }
  );
}


// ============================================================
// UPDATE CALENDAR BUTTON
// ============================================================

function setupCalendarUpdateButton(
  event
) {

  const button =
    document.getElementById(
      "meet-agent-update-calendar"
    );


  if (!button) {
    return;
  }


  button.addEventListener(
    "click",
    async () => {

      button.disabled = true;

      button.textContent =
        "Updating...";


      try {

        await updateCalendarEventFromAgent(
          event
        );


        button.textContent =
          "✓ Calendar updated";


        console.log(
          "📅 Calendar event updated"
        );


      } catch (error) {

        console.error(
          "Calendar update error:",
          error
        );


        button.disabled = false;

        button.textContent =
          "Update failed — retry";
      }
    }
  );
}


// ============================================================
// RECOMMENDATION DISMISS / HIDE
// ============================================================

function hideRecommendation(
  clearEvent = false
) {

  const container =
    document.getElementById(
      "meet-agent-recommendation"
    );


  if (container) {

    container.classList.add(
      "hidden"
    );
  }


  if (clearEvent) {

    lastAgentEvent = null;
  }
}


function setupDismissButton() {

  const button =
    document.getElementById(
      "meet-agent-dismiss"
    );


  if (!button) {
    return;
  }


  button.addEventListener(
    "click",
    (event) => {

      event.stopPropagation();


      hideRecommendation(true);


      console.log(
        "✕ Meet Agent recommendation dismissed"
      );
    }
  );
}


// ============================================================
// RENDER AGENT EVENT
// ============================================================

function renderAgentEvent(
  event
) {

  const container =
    document.getElementById(
      "meet-agent-recommendation"
    );


  if (!container) {
    return;
  }


  // Normal conversation = do nothing
  if (!event.shouldIntervene) {
    return;
  }


  lastAgentEvent = event;


  const panel =
    document.getElementById(
      "meet-agent-panel"
    );


  panel.classList.add(
    "hidden"
  );

  panelOpen = false;


  container.classList.remove(
    "hidden"
  );


  // ----------------------------------------------------------
  // COMMITMENT
  // ----------------------------------------------------------

  if (
    event.type === "commitment"
  ) {

    const canAddToCalendar =
      Boolean(
        event.calendarTitle &&
        event.calendarStart &&
        event.calendarEnd
      );


    const displayDate =
      event.deadline ??
      (
        event.calendarStart
          ? formatCalendarDate(
              event.calendarStart
            )
          : "Not specified"
      );


    container.innerHTML = `
      <div class="meet-agent-card">

        <button
          id="meet-agent-dismiss"
          class="meet-agent-dismiss"
          type="button"
          aria-label="Dismiss recommendation"
          title="Dismiss"
        >
          ×
        </button>

        <div class="meet-agent-card-title">
          ✅ Commitment detected
        </div>

        <div>
          <strong>Owner:</strong>
          ${escapeHtml(
            event.owner ??
            event.speaker ??
            "Unknown"
          )}
        </div>

        <div>
          <strong>Action:</strong>
          ${escapeHtml(
            event.action ??
            "Unknown"
          )}
        </div>

        <div>
          <strong>When:</strong>
          ${escapeHtml(
            displayDate
          )}
        </div>

        ${
          event.attendeeEmails?.length
            ? `
              <div>
                <strong>Invite:</strong>
                ${escapeHtml(
                  event.attendeeEmails.join(", ")
                )}
              </div>
            `
            : ""
        }

        ${
          canAddToCalendar
            ? `
              <button
                id="meet-agent-add-calendar"
                class="meet-agent-action-button"
              >
                Add to Calendar
              </button>
            `
            : ""
        }

      </div>
    `;


    setupDismissButton();


    if (canAddToCalendar) {

      setupCalendarButton(
        event
      );
    }


    return;
  }


  // ----------------------------------------------------------
  // ACTION ITEM
  // ----------------------------------------------------------

  if (
    event.type === "action_item"
  ) {

    const canAddToCalendar =
      Boolean(
        event.calendarTitle &&
        event.calendarStart &&
        event.calendarEnd
      );


    const displayDate =
      event.deadline ??
      (
        event.calendarStart
          ? formatCalendarDate(
              event.calendarStart
            )
          : "Not specified"
      );


    container.innerHTML = `
      <div class="meet-agent-card">

        <button
          id="meet-agent-dismiss"
          class="meet-agent-dismiss"
          type="button"
          aria-label="Dismiss recommendation"
          title="Dismiss"
        >
          ×
        </button>

        <div class="meet-agent-card-title">
          📌 Action item
        </div>

        <div>
          ${escapeHtml(
            event.action ??
            event.summary ??
            ""
          )}
        </div>

        <div>
          <strong>Owner:</strong>
          ${escapeHtml(
            event.owner ??
            "Unassigned"
          )}
        </div>

        <div>
          <strong>When:</strong>
          ${escapeHtml(
            displayDate
          )}
        </div>

        ${
          event.attendeeEmails?.length
            ? `
              <div>
                <strong>Invite:</strong>
                ${escapeHtml(
                  event.attendeeEmails.join(", ")
                )}
              </div>
            `
            : ""
        }

        ${
          canAddToCalendar
            ? `
              <button
                id="meet-agent-add-calendar"
                class="meet-agent-action-button"
              >
                Add to Calendar
              </button>
            `
            : ""
        }

      </div>
    `;


    setupDismissButton();


    if (canAddToCalendar) {

      setupCalendarButton(
        event
      );
    }


    return;
  }


  // ----------------------------------------------------------
  // CHANGE REQUEST
  // ----------------------------------------------------------

  if (
    event.type === "change_request"
  ) {

    const canUpdateCalendar =
      Boolean(
        activeCalendarEventId &&
        event.calendarStart &&
        event.calendarEnd
      );


    container.innerHTML = `
      <div class="meet-agent-card">

        <button
          id="meet-agent-dismiss"
          class="meet-agent-dismiss"
          type="button"
          aria-label="Dismiss recommendation"
          title="Dismiss"
        >
          ×
        </button>

        <div class="meet-agent-card-title">
          🕒 Change suggested
        </div>

        <div>
          ${escapeHtml(
            event.summary ??
            ""
          )}
        </div>

        ${
          event.conflictWith
            ? `
              <div class="meet-agent-secondary">
                Previous:
                ${escapeHtml(
                  event.conflictWith
                )}
              </div>
            `
            : ""
        }

        ${
          canUpdateCalendar
            ? `
              <button
                id="meet-agent-update-calendar"
                class="meet-agent-action-button"
              >
                Update Calendar
              </button>
            `
            : ""
        }

      </div>
    `;


    setupDismissButton();


    if (canUpdateCalendar) {

      setupCalendarUpdateButton(
        event
      );
    }


    return;
  }


  // ----------------------------------------------------------
  // CONTRADICTION
  // ----------------------------------------------------------

  if (
    event.type === "contradiction"
  ) {

    container.innerHTML = `
      <div class="meet-agent-card">

        <button
          id="meet-agent-dismiss"
          class="meet-agent-dismiss"
          type="button"
          aria-label="Dismiss recommendation"
          title="Dismiss"
        >
          ×
        </button>

        <div class="meet-agent-card-title">
          ⚠️ Possible contradiction
        </div>

        <div>
          ${escapeHtml(
            event.summary ??
            ""
          )}
        </div>

        ${
          event.conflictWith
            ? `
              <div class="meet-agent-secondary">
                Conflicts with:
                ${escapeHtml(
                  event.conflictWith
                )}
              </div>
            `
            : ""
        }

      </div>
    `;


    setupDismissButton();


    return;
  }
}


// ============================================================
// HTML SAFETY
// ============================================================

function escapeHtml(
  value
) {

  const div =
    document.createElement(
      "div"
    );


  div.textContent =
    String(value);


  return div.innerHTML;
}


// ============================================================
// GOOGLE MEET CAPTIONS
// ============================================================

function scanMeetCaptions() {

  if (!meetingActive) {
    return;
  }


  const captionBlocks =
    document.querySelectorAll(
      ".nMcdL.bj4p3b"
    );


  captionBlocks.forEach(
    (block) => {

      const speakerElement =
        block.querySelector(
          ".NWpY1d"
        );


      const textElement =
        block.querySelector(
          ".ygicle.VbkSUe"
        );


      if (
        !speakerElement ||
        !textElement
      ) {

        return;
      }


      const speaker =
        speakerElement
          .textContent
          ?.trim();


      const text =
        textElement
          .textContent
          ?.trim();


      if (
        !speaker ||
        !text
      ) {

        return;
      }


      scheduleCaptionAnalysis(
        speaker,
        text
      );
    }
  );
}


// ============================================================
// CAPTION DEBOUNCE
// ============================================================

function scheduleCaptionAnalysis(
  speaker,
  text
) {

  if (!meetingActive) {
    return;
  }


  const previousTimer =
    captionTimers.get(
      speaker
    );


  if (previousTimer) {

    clearTimeout(
      previousTimer
    );
  }


  const timer =
    setTimeout(
      async () => {

        if (!meetingActive) {
          return;
        }


        const lastSent =
          lastSentCaptions.get(
            speaker
          );


        if (lastSent === text) {
          return;
        }


        lastSentCaptions.set(
          speaker,
          text
        );


        console.log(
          `🎙️ Caption detected: ${speaker}: ${text}`
        );


        await analyzeLiveCaption(
          speaker,
          text
        );

      },

      CAPTION_DEBOUNCE_MS
    );


  captionTimers.set(
    speaker,
    timer
  );
}


// ============================================================
// LIVE CAPTION ANALYSIS
// ============================================================

async function analyzeLiveCaption(
  speaker,
  text
) {

  if (!meetingActive) {
    return;
  }


  try {

    const event =
      await sendTranscriptToBackend(
        speaker,
        text
      );


    console.log(
      "🧠 Live agent result:",
      event
    );


    renderAgentEvent(
      event
    );


  } catch (error) {

    console.error(
      "Live caption analysis failed:",
      error
    );
  }
}


// ============================================================
// GOOGLE MEET CHAT MESSAGES
// ============================================================

function scanMeetChat() {

  if (!meetingActive) {
    return;
  }


  const messageElements =
    document.querySelectorAll(
      ".RLrADb[data-message-id]"
    );


  messageElements.forEach(
    (messageElement) => {

      const messageId =
        messageElement.dataset
          .messageId;


      if (
        !messageId ||
        processedChatMessageIds.has(
          messageId
        ) ||
        chatMessageTimers.has(
          messageId
        )
      ) {

        return;
      }


      scheduleChatMessageAnalysis(
        messageId,
        messageElement
      );
    }
  );
}


// ============================================================
// EXTRACT CHAT MESSAGE TEXT
// ============================================================
//
// [jsname="dTKtvb"] holds the actual message body (confirmed by
// testing — it shows the typed text, not the sender's identity).

function extractChatMessageText(
  messageElement
) {

  const textElement =
    messageElement.querySelector(
      '[jsname="dTKtvb"]'
    );


  return (
    textElement
      ?.textContent
      ?.trim() ?? ""
  );
}


// ============================================================
// EXTRACT CHAT MESSAGE SENDER
// ============================================================
//
// Meet doesn't expose a stable class for a per-message sender
// label, and it appears to omit one entirely for your own
// messages. Instead of guessing a class name, we take the whole
// message group (grouped by jsname="Ypafjf") and strip out the
// parts we know aren't a sender name — the message rows
// themselves, the timestamp, and pin-button tooltips. Whatever
// text is left over is the group's sender label, if Meet
// rendered one; otherwise we assume it's your own message.

function extractChatMessageSender(
  messageElement
) {

  const group =
    messageElement.closest(
      '[jsname="Ypafjf"]'
    );


  if (!group) {
    return "Tú";
  }


  const clone =
    group.cloneNode(true);


  clone
    .querySelectorAll(
      '.RLrADb, .HNucUd, [role="tooltip"]'
    )
    .forEach(
      (el) => el.remove()
    );


  const leftoverText =
    clone.textContent
      ?.trim();


  return leftoverText || "Tú";
}


// ============================================================
// CHAT MESSAGE DEBOUNCE
// ============================================================
//
// Chat messages can render before their text has fully populated,
// so we wait briefly before reading the final content.

function scheduleChatMessageAnalysis(
  messageId,
  messageElement
) {

  if (!meetingActive) {
    return;
  }


  const timer =
    setTimeout(
      async () => {

        chatMessageTimers.delete(
          messageId
        );


        if (!meetingActive) {
          return;
        }


        processedChatMessageIds.add(
          messageId
        );


        const sender =
          extractChatMessageSender(
            messageElement
          );

        const text =
          extractChatMessageText(
            messageElement
          );


        if (!text) {
          return;
        }


        console.log(
          `💬 Chat message detected: ${sender}: ${text}`
        );


        await analyzeLiveCaption(
          sender,
          text
        );
      },

      CHAT_MESSAGE_DEBOUNCE_MS
    );


  chatMessageTimers.set(
    messageId,
    timer
  );
}


// ============================================================
// WATCH GOOGLE MEET DOM
// ============================================================

const captionObserver =
  new MutationObserver(
    () => {

      scanMeetCaptions();
      scanMeetChat();
    }
  );


captionObserver.observe(
  document.body,
  {
    childList: true,
    subtree: true,
    characterData: true,
  }
);


console.log(
  "👀 Meet Agent is watching for captions"
);


// ============================================================
// START EXTENSION UI
// ============================================================

createMeetAgentPanel();