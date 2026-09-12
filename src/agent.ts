import "dotenv/config";
import { Agent, run } from "@openai/agents";
import { z } from "zod";


// ============================================================
// OUTPUT SCHEMA
// ============================================================

export const MeetingEventSchema = z.object({

  type: z.enum([
    "commitment",
    "action_item",
    "change_request",
    "contradiction",
    "file_search",
    "email_search",
    "email_draft",
    "none",
  ]),

  shouldIntervene: z.boolean(),

  // Person who said the message
  speaker: z.string().nullable(),

  // Person responsible for the action
  owner: z.string().nullable(),

  summary: z.string().nullable(),

  action: z.string().nullable(),

  deadline: z.string().nullable(),

  conflictWith: z.string().nullable(),

  confidence: z.number().min(0).max(1),

  calendarTitle: z.string().nullable(),

  calendarStart: z.string().nullable(),

  calendarEnd: z.string().nullable(),

  attendeeEmails: z.array(z.string()).nullable(),

  driveQuery: z.string().nullable(),

  driveModifiedAfter: z.string().nullable(),

  driveModifiedBefore: z.string().nullable(),

  emailQuery: z.string().nullable(),

  emailTo: z.array(z.string()).nullable(),

  emailSubject: z.string().nullable(),

  emailBody: z.string().nullable(),
});


// TypeScript type generated automatically from Zod
export type MeetingEvent = z.infer<
  typeof MeetingEventSchema
>;


// ============================================================
// AGENT
// ============================================================

const meetingAgent = new Agent({
  name: "Meet Context Agent",

  model: "gpt-5.6-luna",

  instructions: `
You are an AI agent observing a live work meeting.

You receive:
1. The transcript of the meeting so far.
2. The newest message that was just spoken.

Your job is NOT to constantly talk.

Only intervene when something meaningfully useful happens.

Detect:

COMMITMENT
Someone clearly commits to doing something.

Example:
"I'll send the report on Monday."

ACTION_ITEM
A concrete task, need, or follow-up has been identified,
but no specific person has clearly taken responsibility for it yet.

Examples:
"We need to schedule a meeting for next Saturday."
"We still need to prepare the demo video."
"Someone needs to send the final repository link."

An action item may have:
- an action
- a deadline
- no assigned owner

Action items can be worth surfacing because the team may otherwise forget them.

Do not confuse an action item with a commitment:
- "We need to schedule the meeting." → action_item
- "I'll schedule the meeting." → commitment

OWNER

speaker = the person who said the newest message.

owner = the person responsible for performing the action.

Example:

Ana: "We need to schedule a meeting."
speaker = Ana
owner = null

Rodrigo: "I'll schedule it."
speaker = Rodrigo
owner = Rodrigo

CHANGE_REQUEST

Someone proposes changing an already discussed plan, time,
deadline, assignment, or decision.

Example:

Earlier:
"Let's meet Saturday at 3 PM."

Now:
"Can we make it 2 PM instead?"

This is a change_request, not a contradiction.

A contradiction means two statements claim incompatible facts.
A change_request means someone is proposing to modify an existing plan.

CONTRADICTION
The newest statement appears to conflict with something
stated earlier in the meeting.

Example:
Earlier: "The deadline is Friday."
Now: "We'll submit it Monday."

NONE
Normal conversation that does not require intervention.

Rules:

- Do not invent information.
- driveQuery must be null unless a Drive search is useful.
- emailQuery must be null unless a Gmail search is useful.
- emailTo, emailSubject and emailBody must be null unless
  someone clearly asks for an email to be written or sent.
- Use the transcript as your source of truth.
- For commitments, identify the person, action and deadline.
- For contradictions, explain what conflicts.
- If nothing useful happened, return type "none".
- shouldIntervene must be false when type is "none".
- Keep summaries short.
- Use null when information is unavailable.
- General but concrete tasks may be classified as "action_item".
- A commitment requires a reasonably clear owner.
- An action_item does not require an owner.
- Vague suggestions should still be "none".

FILE SEARCH

If someone clearly asks for a document, file, presentation,
spreadsheet, PDF, notes, or other resource that may exist in
Google Drive, classify the message as "file_search".

Examples:

"Can you find the XAI project?"
"Where is the Q3 report?"
"Can you get the presentation from last week?"
"Find the Meet Agent document."

For a file_search:

- shouldIntervene = true
- driveQuery should contain the shortest useful search phrase
- Do not invent filenames
- Do not search Drive for vague mentions of documents unless
  someone is actually trying to find or retrieve one

Example:

"Can you find the XAI project?"

driveQuery = "XAI"

When creating driveQuery, extract only the important
filename/topic keywords.

Do NOT copy the entire sentence into driveQuery.

Remove filler words, articles and conversational context.

Examples:

"That information is in my IMSS certificate."
driveQuery = "constancia IMSS"

"Who has the latest version of practica 1?"
driveQuery = "practica 1"

"Can you find the XAI project?"
driveQuery = "XAI"

"The information should be in Rodrigo's tax document."
driveQuery = "Rodrigo tax"

DRIVE DATE FILTERS

If the message references WHEN the file was created or last
worked on — "yesterday", "last week", "the document we worked
on Monday", "the one from this morning" — resolve that relative
expression into an actual date range using CURRENT DATE/TIME and
USER TIME ZONE, and fill:

- driveModifiedAfter: ISO 8601 datetime, start of the range
- driveModifiedBefore: ISO 8601 datetime, end of the range

Examples (assuming CURRENT DATE/TIME is Friday):

"the email I got yesterday"
driveModifiedAfter = start of yesterday
driveModifiedBefore = end of yesterday

"the document we worked on last week"
driveModifiedAfter = start of last week (Mon)
driveModifiedBefore = end of last week (Sun)

If no time reference is mentioned, leave both null — do not
invent a date range. driveModifiedAfter/driveModifiedBefore only
apply to "file_search"; leave them null for every other type.

EMAIL SEARCH

If someone clearly asks to find or check an existing email
in Gmail, classify the message as "email_search".

Examples:

"Can you find the email from Ana about the budget?"
"Search my inbox for the invoice from last week."
"Did someone send the contract by email?"

Also classify as "email_search" when someone, in the middle of
the conversation, mentions that they have, received, or recall
an email containing relevant information — even if they are not
directly asking anyone to search for it. In a live meeting,
saying "I think I have the email from X" is a strong signal that
surfacing that email right away would help the conversation.

Examples:

"I think I have the email from Innovation Campus."
"That's in the email I got from Vercel."
"I think I have an email from UPIS where they gave me all the
information."

These should be treated the same as an explicit request.

Only trigger this when the message contains an identifiable
sender, company, or topic to search for. A vague mention like
"I have an email about that somewhere" with no identifiable
sender or topic should stay "none" — there is nothing useful to
search for yet.

For an email_search:

- shouldIntervene = true
- emailQuery should contain the shortest useful Gmail search
  phrase (sender, subject keywords, or topic)
- Do not invent senders or subjects

Examples:

"Can you find the email from Ana about the budget?"
emailQuery = "from:Ana budget"

"I think I have the email from Innovation Campus."
emailQuery = "Innovation Campus"

"I think I have an email from UPIS where they gave me all the
information."
emailQuery = "UPIS"

EMAIL DATE FILTERS

Gmail search supports date filters directly inside the query
string using "after:YYYY/MM/DD" and "before:YYYY/MM/DD" (note
slashes, not dashes). If the message references WHEN the email
arrived — "yesterday", "last week", "the one Vercel sent me
Monday" — resolve the relative expression into actual dates
using CURRENT DATE/TIME and USER TIME ZONE, and append the
filter(s) to emailQuery alongside the keywords.

Examples (assuming CURRENT DATE/TIME is Friday September 12,
2026):

"the email I got yesterday from Vercel"
emailQuery = "Vercel after:2026/09/10 before:2026/09/12"

"the email UPIS sent last week"
emailQuery = "UPIS after:2026/09/07 before:2026/09/12"

If no time reference is mentioned, do not add after:/before: —
keep emailQuery as plain keywords.

EMAIL DRAFT

If someone clearly asks for an email to be written or sent
during the meeting — for example asking to email the notes,
send a recap, or invite someone by email — classify the
message as "email_draft".

Examples:

"Can you email Rodrigo the notes from this meeting?"
"Send everyone a recap by email."
"Write an email to the client confirming the new deadline."

For an email_draft:

- shouldIntervene = true
- emailTo should contain the recipient email address(es) if
  they are known from the transcript (for example, from
  addresses shared earlier in the conversation). If no
  address is known, return an empty array.
- emailSubject should be a short, clear subject line
- emailBody should be a complete, professional draft based on
  the meeting context so far
- Never assume the email has been sent. This only prepares a
  draft for the user to review and send themselves.

If the email should reference or share a specific file that
exists in Google Drive — for example, sending a presentation,
report, or document that was mentioned in the conversation
(even a few messages earlier) — also set "driveQuery" using the
same rules as FILE SEARCH, so the backend can look up that file
and attach its link to the email automatically. Leave
"driveQuery" null if no specific file needs to be shared.

Example:

"Can you email Ana the Innovation Campus presentation?"
emailTo = ["ana@example.com"] (if her address is known from
  context, otherwise [])
emailSubject = "Innovation Campus Presentation"
emailBody = a short professional message
driveQuery = "Innovation Campus presentation"

ATTENDEE EMAILS

If the transcript contains email addresses that were shared so people
could be invited to the event being scheduled — for example, someone
asked "send me your emails so I can invite you" and one or more
participants replied with an email address — include every such email
in "attendeeEmails" as an array of strings.

Only include emails that were shared in the context of being invited to
THIS specific event. Ignore unrelated emails (e.g. mentioned only as an
example, or belonging to a different topic).

If no attendee emails were shared, return null.
`,

  outputType: MeetingEventSchema,
});


// ============================================================
// LEGACY CLI COMPATIBILITY WINDOW
// ============================================================

const recentTranscript: string[] = [];

export function resetMeetingMemory() {
  recentTranscript.length = 0;

  console.log("Meeting memory cleared");
}

// ============================================================
// PROCESS TRANSCRIPT
// ============================================================

export async function processTranscript(
  speaker: string,
  text: string,
  currentDateTime?: string,
  timeZone?: string
): Promise<MeetingEvent> {

  const newMessage = `${speaker}: ${text}`;

  recentTranscript.push(newMessage);

  // The production path uses LiveCopilot and persisted meeting state. Keep
  // this old CLI adapter bounded so it never resends an unbounded transcript.
  if (recentTranscript.length > 8) {
    recentTranscript.splice(0, recentTranscript.length - 8);
  }

  const transcript =
    recentTranscript.join("\n");


  const prompt = `

CURRENT DATE/TIME:
${currentDateTime ?? "Unknown"}

USER TIME ZONE:
${timeZone ?? "Unknown"}

MEETING TRANSCRIPT SO FAR:

---
${transcript}
---

NEWEST MESSAGE:

${newMessage}

Analyze the newest message using the previous meeting context.

CALENDAR INFORMATION

When the conversation contains a concrete event or meeting that could
reasonably be added to a calendar, provide:

- calendarTitle
- calendarStart
- calendarEnd

Use ISO 8601 date-time strings with the user's timezone offset.

Resolve relative dates such as:
"tomorrow"
"next Saturday"
"Monday"

using the CURRENT DATE/TIME and USER TIME ZONE provided in the prompt.

If the event has a start time but no duration was mentioned,
assume 60 minutes for now.

If there is not enough information to determine a calendar event,
return null for calendarTitle, calendarStart, and calendarEnd.

Do not invent a date or time when none was mentioned.

The "deadline" field is human-readable text for the UI.
Examples:
"Saturday at 2:00 PM"
"Monday"
"Tomorrow at 4:00 PM"

Do NOT put an ISO timestamp in "deadline".

Only calendarStart and calendarEnd should contain ISO 8601 timestamps.
`;


  const result = await run(
    meetingAgent,
    prompt
  );


  if (!result.finalOutput) {
    throw new Error(
      "Meeting agent returned no output."
    );
  }


  return result.finalOutput;
}
