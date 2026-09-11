import { google } from "googleapis";


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