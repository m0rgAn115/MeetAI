import { google } from "googleapis";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { getPool, isDatabaseConfigured } from "./db";


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


function requireGoogleOAuthConfig() {
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Missing Google OAuth variables in .env");
  }
}


export const googleOAuthClient =
  new google.auth.OAuth2(
    clientId ?? "",
    clientSecret ?? "",
    redirectUri ?? ""
  );


let googleTokens: any = null;
const oauthWorkspaceId = process.env.LOCAL_WORKSPACE_ID ?? "00000000-0000-0000-0000-000000000001";
const oauthUserId = process.env.LOCAL_USER_ID ?? "00000000-0000-0000-0000-000000000002";

function tokenEncryptionKey(): Buffer {
  const material = process.env.OAUTH_TOKEN_ENCRYPTION_KEY || clientSecret;
  if (!material) throw new Error("Missing OAUTH_TOKEN_ENCRYPTION_KEY or GOOGLE_CLIENT_SECRET");
  return createHash("sha256").update(material).digest();
}

function encryptTokens(tokens: unknown): { ciphertext: string; iv: string; tag: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", tokenEncryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(tokens), "utf8"),
    cipher.final(),
  ]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

function decryptTokens(row: { token_ciphertext: string; token_iv: string; token_auth_tag: string }): any {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    tokenEncryptionKey(),
    Buffer.from(row.token_iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(row.token_auth_tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(row.token_ciphertext, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8"));
}

async function persistGoogleTokens(): Promise<void> {
  if (!isDatabaseConfigured() || !googleTokens) return;
  const encrypted = encryptTokens(googleTokens);
  const scopes = typeof googleTokens.scope === "string" ? googleTokens.scope.split(" ").filter(Boolean) : [];
  await getPool().query(
    `insert into google_oauth_connections
       (workspace_id,user_id,provider,token_ciphertext,token_iv,token_auth_tag,scopes,expiry_date)
     values($1,$2,'google',$3,$4,$5,$6,$7)
     on conflict (workspace_id,user_id,provider) do update set
       token_ciphertext=excluded.token_ciphertext,
       token_iv=excluded.token_iv,
       token_auth_tag=excluded.token_auth_tag,
       scopes=excluded.scopes,
       expiry_date=excluded.expiry_date,
       updated_at=now()`,
    [oauthWorkspaceId, oauthUserId, encrypted.ciphertext, encrypted.iv, encrypted.tag,
      scopes, googleTokens.expiry_date ?? null],
  );
}

googleOAuthClient.on("tokens", (tokens) => {
  googleTokens = { ...(googleTokens ?? {}), ...tokens };
  void persistGoogleTokens().catch((error) => console.error("Could not persist refreshed Google tokens:", error));
});

export async function initializeGoogleOAuth(): Promise<void> {
  if (!isDatabaseConfigured()) return;
  const result = await getPool().query(
    `select token_ciphertext,token_iv,token_auth_tag
       from google_oauth_connections
      where workspace_id=$1 and user_id=$2 and provider='google'`,
    [oauthWorkspaceId, oauthUserId],
  );
  if (!result.rows[0]) return;
  try {
    googleTokens = decryptTokens(result.rows[0]);
    googleOAuthClient.setCredentials(googleTokens);
    console.log("Google OAuth connection restored from PostgreSQL");
  } catch (error) {
    googleTokens = null;
    console.error("Stored Google OAuth connection could not be decrypted:", error);
  }
}


// ============================================================
// GENERATE GOOGLE LOGIN URL
// ============================================================

export function getGoogleAuthUrl() {

  requireGoogleOAuthConfig();

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

  requireGoogleOAuthConfig();

  const {
    tokens,
  } =
    await googleOAuthClient.getToken(code);


  googleTokens = tokens;


  googleOAuthClient.setCredentials(
    tokens
  );

  await persistGoogleTokens();


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
