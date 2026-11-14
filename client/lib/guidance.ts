import type { Session } from "./auth";
import { getDb } from "./db";

export type TopicGuidance = {
  topic: string;
  guidance: string;
  set_by: { user_id: string; name: string };
  updated_at: string;
};

// Internal read for the family editor and voice recall only. Never expose to caregivers.
export async function loadGuidance(s: Session): Promise<TopicGuidance[]> {
  if (s.role === "caregiver") throw new Error("Only family and the voice agent can read guidance");
  const docs = await (await getDb()).collection("topic_guidance")
    .find({ person_id: s.person_id }).sort({ topic: 1 }).toArray();
  return docs.map((d) => ({
    topic: d.topic, guidance: d.guidance,
    set_by: { user_id: d.set_by?.user_id ?? "", name: d.set_by?.name ?? "Family" },
    updated_at: d.updated_at instanceof Date ? d.updated_at.toISOString() : "",
  }));
}
