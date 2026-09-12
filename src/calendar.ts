import { google } from "googleapis";


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
// TEMPORARY TOKEN STORAGE
// ============================================================

// Para el MVP guardamos los tokens en memoria.
// Si reinicias el servidor tendrás que autorizar otra vez.

let googleTokens: any = null;


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