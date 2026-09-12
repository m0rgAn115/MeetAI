import { google } from "googleapis";

import {
  googleOAuthClient,
  isGoogleCalendarConnected,
} from "./calendar";


// ============================================================
// TYPES
// ============================================================

export interface GmailMessageSummary {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
  webViewLink: string;
}


// ============================================================
// GMAIL CLIENT
// ============================================================

function getGmailClient() {

  if (!isGoogleCalendarConnected()) {

    throw new Error(
      "Google account is not connected"
    );
  }

  return google.gmail({
    version: "v1",
    auth: googleOAuthClient,
  });
}


function getHeader(
  headers:
    | { name?: string | null; value?: string | null }[]
    | undefined,
  name: string
) {

  return (
    headers?.find(
      (header) =>
        header.name?.toLowerCase() ===
        name.toLowerCase()
    )?.value ?? ""
  );
}


// ============================================================
// SEARCH GMAIL
// ============================================================

export async function searchGmailMessages(
  query: string
): Promise<GmailMessageSummary[]> {

  const gmail = getGmailClient();

  const listResponse =
    await gmail.users.messages.list({

      userId: "me",

      q: query,

      maxResults: 10,
    });

  const messageRefs =
    listResponse.data.messages ?? [];

  if (messageRefs.length === 0) {
    return [];
  }

  const messages = await Promise.all(
    messageRefs.map(async (ref) => {

      if (!ref.id) {
        return null;
      }

      const detail =
        await gmail.users.messages.get({

          userId: "me",

          id: ref.id,

          format: "metadata",

          metadataHeaders: [
            "Subject",
            "From",
            "Date",
          ],
        });

      return {
        id: ref.id,

        threadId:
          detail.data.threadId ?? "",

        subject:
          getHeader(
            detail.data.payload?.headers,
            "Subject"
          ) || "(sin asunto)",

        from: getHeader(
          detail.data.payload?.headers,
          "From"
        ),

        date: getHeader(
          detail.data.payload?.headers,
          "Date"
        ),

        snippet:
          detail.data.snippet ?? "",

        webViewLink: `https://mail.google.com/mail/u/0/#inbox/${ref.id}`,
      };
    })
  );

  return messages.filter(
    (
      message
    ): message is GmailMessageSummary =>
      message !== null
  );
}


// ============================================================
// SEND GMAIL
// ============================================================

// Email headers must be plain ASCII. Any non-ASCII subject
// (accents, ñ, emoji, etc.) has to be encoded as an RFC 2047
// "encoded word", or clients render mojibake like "ÃƒÂ³".
function encodeMimeHeaderWord(
  value: string
) {

  const base64Value =
    Buffer.from(value, "utf-8").toString(
      "base64"
    );

  return `=?UTF-8?B?${base64Value}?=`;
}


// Splits a base64 string into 76-character lines, the standard
// MIME line-length limit.
function chunkBase64(
  base64Value: string
) {

  const lines: string[] = [];

  for (
    let i = 0;
    i < base64Value.length;
    i += 76
  ) {

    lines.push(
      base64Value.slice(i, i + 76)
    );
  }

  return lines.join("\r\n");
}


function buildRawEmail(
  to: string,
  subject: string,
  body: string
) {

  const encodedSubject =
    encodeMimeHeaderWord(subject);

  const encodedBody = chunkBase64(
    Buffer.from(body, "utf-8").toString(
      "base64"
    )
  );

  const messageParts = [
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    encodedBody,
  ];

  const message =
    messageParts.join("\r\n");

  return Buffer.from(message, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}


export async function sendGmailMessage(
  to: string,
  subject: string,
  body: string
) {

  const gmail = getGmailClient();

  const raw = buildRawEmail(
    to,
    subject,
    body
  );

  const response =
    await gmail.users.messages.send({

      userId: "me",

      requestBody: { raw },
    });

  return {
    id: response.data.id,
    threadId: response.data.threadId,
  };
}