import "dotenv/config";
import express from "express";
import cors from "cors";

import {
  getGoogleAuthUrl,
  saveGoogleAuthCode,
  isGoogleCalendarConnected,
  createCalendarEvent,
  updateCalendarEvent,
  findConflictingEvent,
} from "./calendar";

import {
  searchDriveFiles,
} from "./drive";

import {
  processTranscript,
  resetMeetingMemory,
} from "./agent";


const app = express();
const PORT = 3000;
let meetingActive = false;


// ============================================================
// MIDDLEWARE
// ============================================================

// Permite recibir JSON
app.use(express.json());

// Más adelante permitirá que la extensión de Chrome
// pueda comunicarse con este servidor
app.use(cors());


// ============================================================
// HEALTH CHECK
// ============================================================

app.get("/health", (req, res) => {

  res.json({
    status: "ok",
    service: "Meet Agent Backend",
    meetingActive,
  });

});

// ============================================================
// START MEETING SESSION
// ============================================================

app.post("/meeting/start", (req, res) => {

  resetMeetingMemory();

  meetingActive = true;

  console.log("🟢 Meeting session started");


  return res.json({
    success: true,
    meetingActive: true,
  });

});

// ============================================================
// END MEETING SESSION
// ============================================================

app.post("/meeting/end", (req, res) => {

  meetingActive = false;

  resetMeetingMemory();

  console.log("🔴 Meeting session ended");


  return res.json({
    success: true,
    meetingActive: false,
  });

});

// ============================================================
// ANALYZE TRANSCRIPT
// ============================================================

app.post("/analyze", async (req, res) => {

  try {

    if (!meetingActive) {

      return res.status(409).json({
        error: "No active meeting session",
      });

    }

    const {
      speaker,
      text,
      currentDateTime,
      timeZone,
    } = req.body;


    // Validación básica
    if (!speaker || !text) {

      return res.status(400).json({
        error: "speaker and text are required",
      });

    }


    console.log(
      `🎙️ Received: ${speaker}: ${text}`
    );


    // Mandamos el fragmento al cerebro
    const event = await processTranscript(
      speaker,
      text,
      currentDateTime,
      timeZone
    );


    console.log(
      "🧠 Agent result:",
      event
    );


    // Si el evento propone una fecha/hora concreta, revisamos
    // si choca con algo que ya está en el calendario real.
    let calendarConflict: Awaited<
      ReturnType<
        typeof findConflictingEvent
      >
    > = null;

    let driveResults: any[] = [];


    if (
      event.type === "file_search" &&
      event.driveQuery
    ) {

      try {

        console.log(
          `📁 Agent searching Drive for: ${event.driveQuery}`
        );


        driveResults =
          await searchDriveFiles(
            event.driveQuery
          );


        console.log(
          `📁 Agent found ${driveResults.length} Drive file(s)`
        );


      } catch (error) {

        console.error(
          "Automatic Drive search failed:",
          error
        );
      }
    }

    if (
      isGoogleCalendarConnected() &&
      event.calendarStart &&
      event.calendarEnd
    ) {

      try {

        calendarConflict =
          await findConflictingEvent(
            event.calendarStart,
            event.calendarEnd
          );


        if (calendarConflict) {

          console.log(
            "⚠️ Calendar conflict found:",
            calendarConflict
          );
        }


      } catch (error) {

        console.error(
          "Calendar conflict check failed:",
          error
        );
      }
    }


    // Devolvemos el resultado al cliente
    return res.json({
      ...event,
      calendarConflict,
      driveResults,
    });


  } catch (error) {

    console.error(
      "❌ Analyze error:",
      error
    );


    return res.status(500).json({
      error: "Failed to analyze transcript",
    });

  }

});

// ============================================================
// GOOGLE AUTH
// ============================================================

app.get("/auth/google", (req, res) => {

  const url = getGoogleAuthUrl();

  res.redirect(url);

});


// ============================================================
// GOOGLE AUTH CALLBACK
// ============================================================

app.get(
  "/auth/google/callback",
  async (req, res) => {

    try {

      const code = req.query.code;


      if (
        !code ||
        typeof code !== "string"
      ) {

        return res.status(400).send(
          "Missing authorization code."
        );

      }


      await saveGoogleAuthCode(code);


      return res.send(`
        <html>
          <body
            style="
              font-family: Arial;
              background: #111;
              color: white;
              padding: 40px;
            "
          >
            <h2>✅ Google Calendar connected</h2>

            <p>
              You can close this tab and return to Google Meet.
            </p>
          </body>
        </html>
      `);


    } catch (error) {

      console.error(
        "Google OAuth callback error:",
        error
      );


      return res.status(500).send(
        "Failed to connect Google Calendar."
      );

    }
  }
);


// ============================================================
// CALENDAR STATUS
// ============================================================

app.get(
  "/calendar/status",
  (req, res) => {

    return res.json({
      connected:
        isGoogleCalendarConnected(),
    });

  }
);


// ============================================================
// CREATE CALENDAR EVENT
// ============================================================

app.post(
  "/calendar/create",
  async (req, res) => {

    try {

      if (
        !isGoogleCalendarConnected()
      ) {

        console.warn(
          "⚠️ Calendar creation rejected: Google Calendar is not connected"
        );

        return res.status(401).json({
          error:
            "Google Calendar is not connected",
        });

      }


      const {
        title,
        startDateTime,
        endDateTime,
        description,
        attendees,
      } = req.body;


      if (
        !title ||
        !startDateTime ||
        !endDateTime
      ) {

        return res.status(400).json({
          error:
            "title, startDateTime and endDateTime are required",
        });

      }


      const event =
        await createCalendarEvent(
          title,
          startDateTime,
          endDateTime,
          description,
          attendees
        );


      console.log(
        "📅 Calendar event created:",
        event
      );


      return res.json({
        success: true,
        event,
      });


    } catch (error) {

      console.error(
        "Calendar creation error:",
        error
      );


      return res.status(500).json({
        error:
          "Failed to create calendar event",
      });

    }
  }
);

// ============================================================
// UPDATE CALENDAR EVENT
// ============================================================

app.patch(
  "/calendar/update",
  async (req, res) => {

    try {

      const {
        eventId,
        title,
        startDateTime,
        endDateTime,
        description,
        attendees,
      } = req.body;


      if (
        !eventId ||
        !title ||
        !startDateTime ||
        !endDateTime
      ) {

        return res.status(400).json({
          error:
            "eventId, title, startDateTime and endDateTime are required",
        });

      }


      const event =
        await updateCalendarEvent(
          eventId,
          title,
          startDateTime,
          endDateTime,
          description,
          attendees
        );


      console.log(
        "📅 Calendar event updated:",
        event
      );


      return res.json({
        success: true,
        event,
      });


    } catch (error) {

      console.error(
        "Calendar update error:",
        error
      );


      return res.status(500).json({
        error:
          "Failed to update calendar event",
      });

    }
  }
);

// ============================================================
// GOOGLE DRIVE SEARCH
// ============================================================

app.post(
  "/drive/search",
  async (req, res) => {

    try {

      const {
        query,
      } = req.body;


      if (
        !query ||
        typeof query !== "string"
      ) {

        return res.status(400).json({
          error:
            "query is required",
        });
      }


      console.log(
        `📁 Searching Drive for: ${query}`
      );


      const files =
        await searchDriveFiles(
          query
        );


      console.log(
        `📁 Drive results: ${files.length}`
      );


      return res.json({
        success: true,
        files,
      });


    } catch (error) {

      console.error(
        "Drive search error:",
        error
      );


      return res.status(500).json({
        error:
          "Failed to search Google Drive",
      });
    }
  }
);

// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, () => {

  console.log(
    `🚀 Meet Agent backend running on http://localhost:${PORT}`
  );

});