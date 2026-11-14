import { getMemberSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { apiError } from "@/lib/http";
import { formatTopicGuidance } from "@/lib/prompt";
import { longDate } from "@/lib/time";

// Hands the browser a short-lived signed URL so the ElevenLabs key never leaves the server.
// today is computed here, in the household's timezone, and goes to the agent as a dynamic variable.
// topic_guidance is loaded for the signed-in person so dashboard edits apply on the next session.
export async function GET() {
  const s = await getMemberSession();
  if (!s) return apiError("unauthorized", "Sign in required");
  if (s.role !== "person") return apiError("forbidden", "Only the person can use the voice agent");

  const today = longDate();
  const agentId = process.env.ELEVENLABS_AGENT_ID!;
  const db = await getDb();
  const [rows, res] = await Promise.all([
    db.collection("topic_guidance").find({ person_id: s.person_id }).sort({ topic: 1 }).project({ topic: 1, guidance: 1, _id: 0 }).toArray(),
    fetch(`https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${agentId}`, {
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY! },
    }),
  ]);
  const topic_guidance = formatTopicGuidance(rows);
  const vars = { name: s.name, today, topic_guidance };

  if (res.ok) return Response.json({ signedUrl: (await res.json()).signed_url, ...vars });

  // ponytail: falls back to a public-agent connection when the key lacks convai_write; private agents need the key fixed.
  console.warn("ElevenLabs signed URL failed:", res.status, await res.text());
  return Response.json({ agentId, ...vars });
}
