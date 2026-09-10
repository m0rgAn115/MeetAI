import {
  processTranscript,
} from "./agent";


async function testMessage(
  speaker: string,
  text: string
) {

  const event = await processTranscript(
    speaker,
    text
  );


  console.log("\n----------------------------------");
  console.log(`🎙️ ${speaker}: ${text}`);
  console.log("----------------------------------");


  if (!event.shouldIntervene) {

    console.log("🤫 Agent stays silent.");

    return;
  }


  if (event.type === "commitment") {

    console.log("✅ COMMITMENT DETECTED");

    console.log(`Speaker: ${event.speaker}`);
    console.log(`Action: ${event.action}`);
    console.log(`Deadline: ${event.deadline}`);
    console.log(`Confidence: ${event.confidence}`);

    return;
  }


  if (event.type === "contradiction") {

    console.log("⚠️ POSSIBLE CONTRADICTION");

    console.log(`Summary: ${event.summary}`);
    console.log(
      `Conflicts with: ${event.conflictWith}`
    );
    console.log(
      `Confidence: ${event.confidence}`
    );
  }
}


// ============================================================
// SIMULATED MEETING
// ============================================================

async function main() {

  await testMessage(
    "Ana",
    "I really like the new interface."
  );


  await testMessage(
    "Rodrigo",
    "Yeah, I think it looks much cleaner now."
  );


  await testMessage(
    "Ana",
    "I'll send Rodrigo the Q3 report on Monday."
  );


  await testMessage(
    "Rodrigo",
    "The final presentation deadline is Friday."
  );


  await testMessage(
    "Ana",
    "Perfect, then we'll submit the final presentation on Monday."
  );
}


main().catch((error) => {
  console.error("ERROR:", error);
});