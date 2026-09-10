# ✦ Meet Agent

A proactive AI agent that lives directly inside Google Meet.

Meet Agent listens to the live meeting context, understands what people are discussing, and intervenes only when something useful happens — such as a commitment, action item, scheduling change, or contradiction.

Instead of requiring users to explicitly talk to an AI assistant, Meet Agent observes the meeting and provides contextual actions at the right moment.

## Demo

Examples:

### Commitment

> "I'll schedule our meeting tomorrow at 2 PM."

Meet Agent detects:

- Owner
- Action
- Deadline
- Calendar information

and offers:

**Add to Calendar**

### Meeting change

> "Actually, let's move it from 2 PM to 3 PM."

Meet Agent understands that this refers to the previously discussed event and offers:

**Update Calendar**

The existing Google Calendar event is updated instead of creating a duplicate.

### Action item

> "We still need to prepare the demo video by Friday."

Meet Agent can identify it as an action item and surface it proactively.

### Contradiction

If participants mention incompatible information during the same meeting, Meet Agent can flag the conflict.

---

## How it works

```text
Google Meet
    ↓
Google Meet captions
    ↓
Chrome Extension
    ↓
Local Express Backend
    ↓
OpenAI Agent
    ↓
Structured meeting event
    ↓
Contextual UI inside Google Meet
    ↓
Google Calendar action
```

The agent keeps temporary context for the current meeting, allowing it to understand follow-up statements such as:

```text
"We'll meet Saturday at 2 PM."

later...

"Actually, make it 3 PM."
```

---

## Current features

- Live Google Meet caption detection
- Proactive AI analysis
- Commitment detection
- Action item detection
- Meeting change detection
- Contradiction detection
- Meeting-level conversational memory
- Google Calendar event creation
- Google Calendar event updates
- Floating draggable Meet Agent interface
- Compact listening mode
- Contextual recommendation cards
- Manual transcript debug mode

---

## Tech stack

- OpenAI Agents SDK
- TypeScript
- Node.js
- Express
- Chrome Extension — Manifest V3
- Google Meet captions
- Google Calendar API
- Google OAuth 2.0
- Zod

---

## Project structure

```text
meet-agent/
│
├── extension/
│   ├── manifest.json
│   ├── content.js
│   └── styles.css
│
├── src/
│   ├── agent.ts
│   ├── calendar.ts
│   ├── index.ts
│   └── server.ts
│
├── .env.example
├── .gitignore
├── package.json
├── package-lock.json
└── README.md
```

---

## Setup

### 1. Clone the repository

```bash
git clone https://github.com/YOUR_USERNAME/meet-agent.git
cd meet-agent
```

### 2. Install dependencies

```bash
npm install
```

### 3. Create environment variables

Copy:

```text
.env.example
```

to:

```text
.env
```

Example:

```env
OPENAI_API_KEY=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:3000/auth/google/callback
```

Never commit your real `.env` file.

---

## Google Calendar setup

Create a project in Google Cloud Console.

Enable:

```text
Google Calendar API
```

Create an OAuth 2.0 Client ID using:

```text
Application type:
Web application
```

Add this redirect URI:

```text
http://localhost:3000/auth/google/callback
```

Put the generated Client ID and Client Secret inside `.env`.

If the OAuth application is in Testing mode, add the Google accounts that will use the demo as test users.

---

## Run the backend

```bash
npm run dev
```

The backend runs at:

```text
http://localhost:3000
```

Test it with:

```text
http://localhost:3000/health
```

---

## Connect Google Calendar

With the backend running, open:

```text
http://localhost:3000/auth/google
```

Authorize the Google account.

The current MVP stores the Google OAuth token in memory, so authorization may be required again after restarting the backend.

---

## Install the Chrome extension

Open Chrome:

```text
chrome://extensions
```

Enable:

```text
Developer mode
```

Click:

```text
Load unpacked
```

and select:

```text
meet-agent/extension
```

---

## Using Meet Agent

1. Start the backend.
2. Connect Google Calendar.
3. Open a Google Meet.
4. Enable Google Meet captions.
5. Click the floating ✦ Meet Agent icon.
6. Click **Start Agent**.
7. Continue the meeting normally.

While listening, Meet Agent stays minimized as a small draggable circle.

When relevant context appears, it automatically displays a contextual recommendation.

---

## Example flow

```text
Rodrigo:
"We need to schedule a meeting tomorrow at 2 PM."

             ↓

Meet Agent

📌 Action item
Schedule meeting

[ Add to Calendar ]

             ↓

Google Calendar
Meeting — 2:00 PM
```

Then:

```text
Rodrigo:
"Actually, let's move it to 3 PM."

             ↓

Meet Agent

🕒 Change suggested

Previous:
Meeting at 2 PM

[ Update Calendar ]

             ↓

Google Calendar
Meeting — 3:00 PM
```

---

## MVP limitations

This is currently a hackathon MVP.

- Google Meet caption selectors depend on the current Meet DOM and may change.
- Google OAuth tokens are currently stored only in backend memory.
- Calendar tracking currently focuses on the active event rather than maintaining a database of many simultaneous events.
- The backend currently runs locally.
- Google Meet captions must be enabled.

---

## Hackathon

Built for:

**AI Tinkerers — Agents, Everywhere: Bots, Channels, & More Global Hackathon**

The project explores an agent that does not live in a traditional chatbot.

Instead, it lives inside an environment people already use for work:

**Google Meet.**