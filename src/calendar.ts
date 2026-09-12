import { google } from "googleapis";
import fs from "fs";
import path from "path";


// Local shape for the fields we read off a Calendar API event.
// (googleapis' own per-API type declarations aren't resolvable
// in this install, so we avoid importing calendar_v3 directly.)
interface CalendarApiEvent {
  id?: string | null;
  summary?: string | null;
  htmlLink?: string | null;
  start?: { dateTime?: string | null } | null;
  end?: { dateTime?: string | null } | null;
}


// ============================================================
// GOOGLE OAUTH CLIENT
// ============================================================

const clientId =
  process.env.GOOGLE_CLIENT_ID;

const clientSecret =
  process.env.GOOGLE_CLIENT_SECRET;

const redirectUri =
  process.env.GOOGLE_REDIRECT_URI;


if (
  !clientId ||
  !clientSecret ||
  !redirectUri
) {
  throw new Error(
    "Missing Google OAuth variables in .env"
  );
}


export const googleOAuthClient =
  new google.auth.OAuth2(
    clientId,
    clientSecret,
    redirectUri
  );


// ============================================================
// PERSISTENT TOKEN STORAGE
// ============================================================

// Tokens are cached in memory (fast) but also written to a local
// JSON file, so restarting the backend (`npm run dev`) doesn't
// force you to re-authorize with Google every time. Add this file
// to .gitignore — it contains a live refresh token.

const TOKEN_PATH =
  path.join(
    process.cwd(),
    ".google-token.json"
  );


let googleTokens: any = null;


function persistTokensToDisk() {

  if (!googleTokens) {
    return;
  }

  try {

    fs.writeFileSync(
      TOKEN_PATH,
      JSON.stringify(
        googleTokens,
        null,
        2
      ),
      "utf-8"
    );

  } catch (error) {

    console.error(
      "⚠️ Could not save Google token to disk:",
      error
    );
  }
}


function loadTokensFromDisk() {

  try {

    if (
      !fs.existsSync(TOKEN_PATH)
    ) {

      return;
    }


    const raw =
      fs.readFileSync(
        TOKEN_PATH,
        "utf-8"
      );

    googleTokens =
      JSON.parse(raw);

    googleOAuthClient.setCredentials(
      googleTokens
    );

    console.log(
      "✅ Google Calendar re-authorized from saved token"
    );

  } catch (error) {

    console.error(
      "⚠️ Could not load saved Google token, you'll need to re-authorize:",
      error
    );

    googleTokens = null;
  }
}


// Load whatever we have on disk as soon as this module runs.
loadTokensFromDisk();


// google-auth-library silently refreshes the access token behind
// the scenes using the refresh_token. Whenever that happens, this
// event fires with the updated tokens — persist them so the fresh
// access token survives a restart too.
googleOAuthClient.on(
  "tokens",
  (tokens) => {

    googleTokens = {
      ...googleTokens,
      ...tokens,
    };

    persistTokensToDisk();
  }
);


// ============================================================
// GENERATE GOOGLE LOGIN URL
// ============================================================

export function getGoogleAuthUrl() {

  return googleOAuthClient.generateAuthUrl({
    access_type: "offline",

    prompt: "consent",
    
    scope: [
        "https://www.googleapis.com/auth/calendar.events",
        "https://www.googleapis.com/auth/drive.metadata.readonly",
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.send",
      ],
  });
}


// ============================================================
// EXCHANGE CODE FOR TOKENS
// ============================================================

export async function saveGoogleAuthCode(
  code: string
) {

  const {
    tokens,
  } =
    await googleOAuthClient.getToken(code);


  googleTokens = tokens;


  googleOAuthClient.setCredentials(
    tokens
  );


  persistTokensToDisk();


  console.log(
    "✅ Google Calendar authorized"
  );
}


// ============================================================
// CHECK CONNECTION
// ============================================================

export function isGoogleCalendarConnected() {

  return googleTokens !== null;
}


// ============================================================
// FIND CONFLICTING EVENT
// ============================================================

export async function findConflictingEvent(
  startDateTime: string,
  endDateTime: string
) {

  if (!googleTokens) {

    throw new Error(
      "Google Calendar is not connected"
    );

  }


  googleOAuthClient.setCredentials(
    googleTokens
  );


  const calendar =
    google.calendar({
      version: "v3",
      auth: googleOAuthClient,
    });


  const response =
    await calendar.events.list({

      calendarId: "primary",

      timeMin: startDateTime,

      timeMax: endDateTime,

      singleEvents: true,

      orderBy: "startTime",

    });


  const conflict =
    (
      response.data.items ??
      []
    ).find(
      (item: CalendarApiEvent) =>
        item.start?.dateTime &&
        item.end?.dateTime
    );


  if (!conflict) {
    return null;
  }


  return {
    id: conflict.id,

    summary:
      conflict.summary ??
      "Untitled event",

    start: conflict.start?.dateTime,

    end: conflict.end?.dateTime,

    htmlLink: conflict.htmlLink,
  };
}


// ============================================================
// CREATE CALENDAR EVENT
// ============================================================

export async function createCalendarEvent(
  title: string,
  startDateTime: string,
  endDateTime: string,
  description?: string,
  attendeeEmails?: string[]
) {

  if (!googleTokens) {

    throw new Error(
      "Google Calendar is not connected"
    );

  }


  googleOAuthClient.setCredentials(
    googleTokens
  );


  const calendar =
    google.calendar({
      version: "v3",
      auth: googleOAuthClient,
    });


  const response =
    await calendar.events.insert({

      calendarId: "primary",

      sendUpdates:
        attendeeEmails?.length
          ? "all"
          : "none",

      requestBody: {

        summary: title,

        description:
          description ?? "",

        start: {
          dateTime: startDateTime,
        },

        end: {
          dateTime: endDateTime,
        },

        attendees:
          attendeeEmails?.map(
            (email) => ({ email })
          ),

      },

    });


  return {
    id: response.data.id,
    htmlLink: response.data.htmlLink,
    summary: response.data.summary,
    attendees:
      response.data.attendees ?? [],
  };
}

export async function updateCalendarEvent(
  eventId: string,
  title: string,
  startDateTime: string,
  endDateTime: string,
  description?: string,
  attendeeEmails?: string[]
) {

  if (!googleTokens) {
    throw new Error(
      "Google Calendar is not connected"
    );
  }


  googleOAuthClient.setCredentials(
    googleTokens
  );


  const calendar =
    google.calendar({
      version: "v3",
      auth: googleOAuthClient,
    });


  const response =
    await calendar.events.patch({

      calendarId: "primary",

      eventId,

      sendUpdates:
        attendeeEmails?.length
          ? "all"
          : "none",

      requestBody: {

        summary: title,

        description:
          description ?? "",

        start: {
          dateTime: startDateTime,
        },

        end: {
          dateTime: endDateTime,
        },

        attendees:
          attendeeEmails?.map(
            (email) => ({ email })
          ),

      },

    });


  return {
    id: response.data.id,
    htmlLink: response.data.htmlLink,
    summary: response.data.summary,
    attendees:
      response.data.attendees ?? [],
  };
}