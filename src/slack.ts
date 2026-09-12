// ============================================================
// SLACK INCOMING WEBHOOK
// ============================================================
//
// Uses a simple Incoming Webhook URL — no OAuth, no bot token.
// See: https://api.slack.com/messaging/webhooks

const slackWebhookUrl =
  process.env.SLACK_WEBHOOK_URL;


export function isSlackConnected() {

  return Boolean(slackWebhookUrl);
}


export async function sendSlackMessage(
  text: string
) {

  if (!slackWebhookUrl) {

    throw new Error(
      "Missing SLACK_WEBHOOK_URL in .env"
    );
  }


  const response = await fetch(
    slackWebhookUrl,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
      },

      body: JSON.stringify({
        text,
      }),
    }
  );


  if (!response.ok) {

    const errorText =
      await response.text();


    throw new Error(
      `Slack webhook returned ${response.status}: ${errorText}`
    );
  }


  return { success: true };
}