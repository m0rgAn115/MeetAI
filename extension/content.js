console.log("🤖 Meet Agent content script loaded");


// ============================================================
// GLOBAL STATE
// ============================================================

let meetingActive = false;
let panelOpen = false;
let lastAgentEvent = null;
let activeCalendarEventId = null;

// True once the user explicitly turns the agent off during a
// live call. While true, the auto-detector must never turn it
// back on for that same call — only the user's own toggle can.
// It resets automatically once the call actually ends.
let userManuallyStopped = false;

// Drive files the user has already opened this session, so the
// "Open" button can show a confirmed/green state instead of
// looking the same every time the card re-renders.
const openedDriveFileKeys = new Set();

const captionTimers = new Map();
const lastSentCaptions = new Map();

const CAPTION_DEBOUNCE_MS = 1500;

const chatMessageTimers = new Map();
const processedChatMessageIds = new Set();

const CHAT_MESSAGE_DEBOUNCE_MS = 800;


// ============================================================
// ICONS
// ============================================================
// Small line icons, colored via CSS (currentColor) so each
// event type picks up its own accent from styles.css.

function agentIcon(name) {

  const icons = {
    commitment: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`,
    action: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"/></svg>`,
    change: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>`,
    contradiction: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"/><path d="M12 16.5h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>`,
    drive: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>`,
    file: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>`,
  };

  return icons[name] ?? "";
}


// ============================================================
// ADAPTIVE PANEL POSITIONING
// ============================================================
// The panel/recommendation card must never spill off-screen,
// regardless of where the bubble (FAB) was dropped. We detect
// which quadrant the bubble occupies and flip the panel's
// opening direction accordingly, then do a final pixel-level
// clamp in case the flip alone isn't enough (e.g. bubble
// dragged very close to a corner).

const MA_EDGE_MARGIN = 12;

function updatePanelOrientation() {

  const root =
    document.getElementById(
      "meet-agent-root"
    );

  if (!root) {
    return;
  }

  const rect =
    root.getBoundingClientRect();

  const bubbleCenterX =
    rect.left + rect.width / 2;

  const bubbleCenterY =
    rect.top + rect.height / 2;

  const isRightHalf =
    bubbleCenterX >
    window.innerWidth / 2;

  const isBottomHalf =
    bubbleCenterY >
    window.innerHeight / 2;

  // Bubble on the right → panel opens left.
  // Bubble on the left → panel opens right.
  root.classList.toggle(
    "ma-open-left",
    isRightHalf
  );

  root.classList.toggle(
    "ma-open-right",
    !isRightHalf
  );

  // Bubble on the bottom → panel opens upward.
  // Bubble on the top → panel opens downward.
  root.classList.toggle(
    "ma-open-up",
    isBottomHalf
  );

  root.classList.toggle(
    "ma-open-down",
    !isBottomHalf
  );
}


function clampElementToViewport(
  element
) {

  if (
    !element ||
    element.classList.contains(
      "hidden"
    )
  ) {

    return;
  }

  // Reset any previous clamp offset before measuring again.
  element.style.transform = "";

  const rect =
    element.getBoundingClientRect();

  let dx = 0;
  let dy = 0;

  if (rect.left < MA_EDGE_MARGIN) {

    dx =
      MA_EDGE_MARGIN - rect.left;

  } else if (
    rect.right >
    window.innerWidth -
      MA_EDGE_MARGIN
  ) {

    dx =
      (window.innerWidth -
        MA_EDGE_MARGIN) -
      rect.right;
  }

  if (rect.top < MA_EDGE_MARGIN) {

    dy =
      MA_EDGE_MARGIN - rect.top;

  } else if (
    rect.bottom >
    window.innerHeight -
      MA_EDGE_MARGIN
  ) {

    dy =
      (window.innerHeight -
        MA_EDGE_MARGIN) -
      rect.bottom;
  }

  if (dx !== 0 || dy !== 0) {

    element.style.transform =
      `translate(${dx}px, ${dy}px)`;
  }
}


function repositionFloatingUI() {

  updatePanelOrientation();

  // Wait a frame so the orientation classes above have been
  // applied and layout has settled before measuring for clamp.
  requestAnimationFrame(() => {

    clampElementToViewport(
      document.getElementById(
        "meet-agent-panel"
      )
    );

    clampElementToViewport(
      document.getElementById(
        "meet-agent-recommendation"
      )
    );
  });
}


window.addEventListener(
  "resize",
  repositionFloatingUI
);


// ============================================================
// PERSONALIZED SPEAKER DISPLAY
// ============================================================

function updateSpeakerDisplay(
  name
) {

  const row =
    document.getElementById(
      "meet-agent-speaker-row"
    );

  const label =
    document.getElementById(
      "meet-agent-speaker-name"
    );

  if (!row || !label) {
    return;
  }

  if (!name) {

    row.classList.add(
      "hidden"
    );

    label.textContent = "";

    return;
  }

  label.textContent =
    `With ${name}`;

  row.classList.remove(
    "hidden"
  );
}


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

      <div class="meet-agent-header-row">

        <div class="meet-agent-header">
          ✦ Meet Agent
        </div>

        <button
          id="meet-agent-toggle"
          class="meet-agent-toggle"
          type="button"
          role="switch"
          aria-checked="false"
          aria-label="Turn Meet Agent on or off"
        >
          <span class="meet-agent-toggle-thumb"></span>
        </button>

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


      <div
        id="meet-agent-speaker-row"
        class="meet-agent-speaker-row hidden"
      >
        <span id="meet-agent-speaker-name"></span>
      </div>


      <div id="meet-agent-result">
        Waiting to join a call.
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


  root.classList.add(
    "ma-open-left",
    "ma-open-down"
  );


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


  requestAnimationFrame(() => {
    clampElementToViewport(panel);
  });
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

    requestAnimationFrame(() => {
      clampElementToViewport(
        recommendation
      );
    });
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


      const bubbleSize = 44;


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


      if (actuallyDragged) {

        repositionFloatingUI();

      } else {

        toggleAgentPanel();
      }
    }
  );
}


// ============================================================
// PANEL LISTENERS
// ============================================================

function setupPanelListeners() {

  const toggle =
    document.getElementById(
      "meet-agent-toggle"
    );

  if (!toggle) {
    return;
  }

  toggle.addEventListener(
    "click",
    () => {

      if (toggle.disabled) {
        return;
      }

      if (meetingActive) {

        // Explicit manual stop — the auto-detector must respect
        // this for the rest of the call.
        userManuallyStopped = true;

        stopAgent();

      } else {

        // Explicit manual start clears any earlier override.
        userManuallyStopped = false;

        startAgent();
      }
    }
  );
}


// ============================================================
// START AGENT
// ============================================================
// Shared by the manual "Start Agent" button and by the
// auto-detection of a live Google Meet call.

async function startAgent() {

  if (meetingActive) {
    return;
  }

  const resultContainer =
    document.getElementById("meet-agent-result");


  try {

    if (resultContainer) {

      resultContainer.innerHTML = `
        <div class="meet-agent-loading">
          Starting agent...
        </div>
      `;
    }


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


    if (resultContainer) {

      resultContainer.innerHTML = `
        <div class="meet-agent-error">
          Could not start the agent.
        </div>
      `;
    }
  }
}


// ============================================================
// STOP AGENT
// ============================================================

async function stopAgent() {

  if (!meetingActive) {
    return;
  }

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
    updateSpeakerDisplay(null);


    console.log(
      "🔴 Meet Agent stopped"
    );


  } catch (error) {

    console.error(
      "Could not stop Meet Agent:",
      error
    );


    if (resultContainer) {

      resultContainer.innerHTML = `
        <div class="meet-agent-error">
          Could not stop the agent.
        </div>
      `;
    }
  }
}


// ============================================================
// UPDATE START / STOP UI
// ============================================================

function updateMeetingUI(active) {

  meetingActive = active;

  const bubble =
    document.getElementById(
      "meet-agent-bubble"
    );

  const bubbleStatus =
    document.getElementById(
      "meet-agent-bubble-status"
    );

  const toggle =
    document.getElementById(
      "meet-agent-toggle"
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

    bubble.classList.add(
      "is-listening"
    );

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


    if (toggle) {

      toggle.setAttribute(
        "aria-checked",
        "true"
      );
    }


    resultContainer.innerHTML = `
      <div class="meet-agent-silent">
      </div>
    `;


  } else {

    bubble.classList.remove(
      "is-listening"
    );

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


    if (toggle) {

      toggle.setAttribute(
        "aria-checked",
        "false"
      );
    }


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


        button.classList.add(
          "meet-agent-action-button--success"
        );

        button.textContent =
          "✓ Scheduled";


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

function formatDriveDate(
  isoDate
) {

  if (!isoDate) {
    return "";
  }


  const date =
    new Date(isoDate);


  return new Intl.DateTimeFormat(
    undefined,
    {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }
  ).format(date);
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


        button.classList.add(
          "meet-agent-action-button--success"
        );

        button.textContent =
          "✓ Updated";


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

  requestAnimationFrame(() => {
    clampElementToViewport(
      container
    );
  });

  // ----------------------------------------------------------
  // DRIVE FILE SEARCH
  // ----------------------------------------------------------

  if (
    event.type === "file_search"
  ) {

    const files =
      Array.isArray(
        event.driveResults
      )
        ? event.driveResults
        : [];


    container.innerHTML = `
      <div class="meet-agent-card meet-agent-card--drive">

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
          ${agentIcon("drive")} Drive search
        </div>


        ${
          files.length === 0
            ? `
              <div class="meet-agent-drive-empty">

                No matching files found for

                <strong>
                  ${escapeHtml(
                    event.driveQuery ??
                    ""
                  )}
                </strong>

              </div>
            `
            : `
              <div class="meet-agent-drive-summary">

                Found
                ${files.length}
                file${files.length === 1 ? "" : "s"}

              </div>


              <div class="meet-agent-drive-results">

                ${files
                  .map(
                    (file, index) => `

                      <div
                        class="meet-agent-drive-result"
                      >

                        <div
                          class="meet-agent-drive-file-info"
                        >

                          <div
                            class="meet-agent-drive-name"
                            title="${escapeHtml(
                              file.name ??
                              "Untitled file"
                            )}"
                          >
                            ${agentIcon("file")}
                            ${escapeHtml(
                              file.name ??
                              "Untitled file"
                            )}
                          </div>


                          ${
                            file.modifiedTime
                              ? `
                                <div
                                  class="meet-agent-drive-meta"
                                >
                                  Modified
                                  ${escapeHtml(
                                    formatDriveDate(
                                      file.modifiedTime
                                    )
                                  )}
                                </div>
                              `
                              : ""
                          }


                          ${
                            file.owner?.name ||
                            file.owner?.email
                              ? `
                                <div
                                  class="meet-agent-drive-meta"
                                >
                                  Owner:
                                  ${escapeHtml(
                                    file.owner?.name ??
                                    file.owner?.email ??
                                    "Unknown"
                                  )}
                                </div>
                              `
                              : ""
                          }

                        </div>


                        ${
                          file.webViewLink
                            ? `
                              <button
                                class="
                                  meet-agent-drive-open
                                  meet-agent-open-drive
                                  ${
                                    openedDriveFileKeys.has(
                                      file.id ??
                                      file.webViewLink
                                    )
                                      ? "meet-agent-drive-open--opened"
                                      : ""
                                  }
                                "
                                data-drive-index="${index}"
                                title="Open in Google Drive"
                              >
                                ${
                                  openedDriveFileKeys.has(
                                    file.id ??
                                    file.webViewLink
                                  )
                                    ? "✓ Opened"
                                    : "Open"
                                }
                              </button>
                            `
                            : ""
                        }

                      </div>

                    `
                  )
                  .join("")}

              </div>
            `
        }

      </div>
    `;


    setupDismissButton();


    document
      .querySelectorAll(
        ".meet-agent-open-drive"
      )
      .forEach(
        (button) => {

          button.addEventListener(
            "click",
            () => {

              const index =
                Number(
                  button.dataset
                    .driveIndex
                );


              const file =
                files[index];


              if (
                file &&
                file.webViewLink
              ) {

                window.open(
                  file.webViewLink,
                  "_blank",
                  "noopener,noreferrer"
                );

                openedDriveFileKeys.add(
                  file.id ??
                  file.webViewLink
                );

                button.classList.add(
                  "meet-agent-drive-open--opened"
                );

                button.textContent =
                  "✓ Opened";
              }
            }
          );
        }
      );


    return;
  }

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
      <div class="meet-agent-card meet-agent-card--commitment">

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
          ${agentIcon("commitment")} Commitment detected
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
          event.calendarConflict
            ? `
              <div class="meet-agent-conflict">
                ⚠️ Conflicts with
                "${escapeHtml(
                  event.calendarConflict.summary
                )}"
                (${escapeHtml(
                  formatCalendarDate(
                    event.calendarConflict.start
                  )
                )} –
                ${escapeHtml(
                  formatCalendarDate(
                    event.calendarConflict.end
                  )
                )})
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
      <div class="meet-agent-card meet-agent-card--action">

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
          ${agentIcon("action")} Action item
        </div>

        <div>
          ${escapeHtml(
            event.action ??
            event.summary ??
            ""
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
          event.calendarConflict
            ? `
              <div class="meet-agent-conflict">
                ⚠️ Conflicts with
                "${escapeHtml(
                  event.calendarConflict.summary
                )}"
                (${escapeHtml(
                  formatCalendarDate(
                    event.calendarConflict.start
                  )
                )} –
                ${escapeHtml(
                  formatCalendarDate(
                    event.calendarConflict.end
                  )
                )})
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
      <div class="meet-agent-card meet-agent-card--change">

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
          ${agentIcon("change")} Change suggested
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
      <div class="meet-agent-card meet-agent-card--contradiction">

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
          ${agentIcon("contradiction")} Possible contradiction
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


      updateSpeakerDisplay(
        speaker
      );


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
// AUTO-START ON MEET CALL DETECTION
// ============================================================
// No manual click required: as soon as we detect the user is
// actually inside a live Meet call (not just the pre-join
// lobby), the agent starts listening on its own.
//
// IMPORTANT: this only ever starts the agent automatically. It
// never stops it automatically — an earlier version stopped the
// agent whenever the "in call" heuristic failed to match (e.g.
// wrong locale string), which killed manual sessions within
// seconds. Stopping stays entirely under manual/explicit control
// (the Stop button, or the backend's own end-of-meeting logic).

// aria-label varies by Google account language, so we check a
// handful of the most common ones. This list is best-effort —
// see the language-independent check below for the real safety
// net.
const MEET_IN_CALL_ARIA_LABELS = [
  "Leave call",
  "Salir de la llamada",
  "Abandonar la llamada",
  "Sair da chamada",
  "Quitter l'appel",
  "Anruf verlassen",
  "Turn off captions",
  "Desactivar los subtítulos",
  "Turn off microphone",
  "Desactivar micrófono",
  "Apagar micrófono",
];

const MEET_CALL_POLL_MS = 2000;

function isInMeetCall() {

  // 1) aria-label match (language dependent, best-effort).
  const ariaMatch =
    MEET_IN_CALL_ARIA_LABELS.some(
      (label) =>
        document.querySelector(
          `[aria-label="${label}"]`
        )
    );

  if (ariaMatch) {
    return true;
  }

  // 2) Language-independent fallback: Google Meet renders its
  // Material Symbols icons using a ligature font, so the literal
  // text "call_end" sits in the DOM for the leave-call button
  // regardless of the account's language.
  const iconSpans =
    document.querySelectorAll(
      '.google-symbols, [class*="google-material-icons"], [class*="material-symbols"]'
    );

  for (const span of iconSpans) {

    if (
      span.textContent
        ?.trim() === "call_end"
    ) {

      return true;
    }
  }

  return false;
}

// Require several consecutive "not in call" polls before treating
// the call as actually over. A single missed poll is normal DOM
// flicker; several in a row (a few seconds) means you really left.
const CALL_END_CONFIRM_POLLS = 3;

let notInCallStreak = 0;

function checkMeetCallState() {

  const inCall =
    isInMeetCall();

  if (inCall) {

    notInCallStreak = 0;

    if (
      !meetingActive &&
      !userManuallyStopped
    ) {

      console.log(
        "📞 Google Meet call detected — auto-starting agent"
      );

      startAgent();
    }

    return;
  }


  // Not currently detected as in-call.
  notInCallStreak += 1;

  if (
    meetingActive &&
    notInCallStreak >=
      CALL_END_CONFIRM_POLLS
  ) {

    console.log(
      "📴 Call ended — stopping agent"
    );

    stopAgent();

    // A fresh call should auto-start again on its own.
    userManuallyStopped = false;
  }
}

setInterval(
  checkMeetCallState,
  MEET_CALL_POLL_MS
);


// Manual diagnostic: run `meetAgentInspectCallDetection()` in the
// devtools console while inside a live Meet call to see exactly
// which check matched (or didn't), so wrong selectors can be
// fixed quickly instead of guessing.
window.meetAgentInspectCallDetection =
  function () {

    const ariaHit =
      MEET_IN_CALL_ARIA_LABELS.find(
        (label) =>
          document.querySelector(
            `[aria-label="${label}"]`
          )
      );

    const iconSpans =
      document.querySelectorAll(
        '.google-symbols, [class*="google-material-icons"], [class*="material-symbols"]'
      );

    const iconHit =
      Array.from(iconSpans).find(
        (span) =>
          span.textContent
            ?.trim() === "call_end"
      );

    console.log(
      "meetAgentInspectCallDetection →",
      {
        result: isInMeetCall(),
        matchedAriaLabel:
          ariaHit ?? null,
        matchedByIconLigature:
          Boolean(iconHit),
        iconSpansScanned:
          iconSpans.length,
      }
    );

    return isInMeetCall();
  };


// ============================================================
// START EXTENSION UI
// ============================================================

createMeetAgentPanel();

checkMeetCallState();