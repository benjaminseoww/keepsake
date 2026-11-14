import { ObjectId } from "mongodb";
import type { Role, Session } from "./auth";
import { getDb } from "./db";
import type { Degraded } from "./recall";
import type { TopicGuidance } from "./guidance";

// Reads for the trace ("How did it know this?"). Shapes follow docs/api-reads.yaml.
// The API routes and the trace pages both call these, so the rules live in one place.

// D-A2: family only for the MVP. A turn's answer can paraphrase a family-scope memory.
export const canViewTrace = (s: Session) => s.role === "family";

export type AskedBy = { name: string | null; role: Role };

export type TurnSummary = {
  id: string;
  at: string;
  // Margaret through the voice agent, or a caregiver or family member through /api/recall.
  asked_by: AskedBy;
  question: string;
  answer: string | null;
  result_count: number;
  top_rerank_score: number | null;
  degraded: Degraded;
};

export type TurnResult = {
  memory_id: string;
  text: string;
  status: string;
  current_status: string | null;
  scope: string;
  author_name: string | null;
  author_role: Role;
  created_at: string;
  vector_score: number | null;
  rerank_score: number | null;
};

export type Turn = Omit<TurnSummary, "result_count"> & {
  conversation_id: string | null;
  results: TurnResult[];
  min_rerank_score: number;
  guidance: TopicGuidance[];
};

const iso = (d: Date) => d.toISOString();

type Member = { user_id: string; name: string; role: Role };
// Names and roles come from households.members now, so a renamed member shows their current name.
async function membersOf(person_id: string) {
  const household = await (await getDb()).collection("households").findOne({ person_id }, { projection: { members: 1 } });
  return new Map<string, Member>((household?.members ?? []).map((m: Member) => [m.user_id, m]));
}
// A member who has since left the household shows as "Someone"; old turns predate other roles asking, so default to person.
const askedBy = (members: Map<string, Member>, user_id: string): AskedBy => {
  const m = members.get(user_id);
  return { name: m?.name ?? null, role: m?.role ?? "person" };
};

// Newest first, using the {person_id: 1, at: -1} index. before pages back from the oldest turn already shown.
export async function listTurns(s: Session, { limit = 20, before }: { limit?: number; before?: Date } = {}): Promise<TurnSummary[]> {
  const [docs, members] = await Promise.all([
    (await getDb()).collection("turns")
      .find(
        { person_id: s.person_id, ...(before ? { at: { $lt: before } } : {}) },
        { projection: { at: 1, user_id: 1, question: 1, answer: 1, results: 1, top_rerank_score: 1, degraded: 1 } },
      )
      .sort({ at: -1 })
      .limit(Math.min(Math.max(limit, 1), 100))
      .toArray(),
    membersOf(s.person_id),
  ]);
  return docs.map((d) => ({
    id: d._id.toString(),
    at: iso(d.at),
    asked_by: askedBy(members, d.user_id),
    question: d.question,
    answer: d.answer ?? null,
    result_count: d.results.length,
    top_rerank_score: d.top_rerank_score ?? null,
    degraded: d.degraded ?? null,
  }));
}

// One turn with each result's status now, so the trace can show "since superseded". null if not in this household.
export async function getTurn(s: Session, id: string): Promise<Turn | null> {
  if (!ObjectId.isValid(id)) return null;
  const db = await getDb();
  const t = await db.collection("turns").findOne({ _id: new ObjectId(id), person_id: s.person_id });
  if (!t) return null;

  const [current, members] = await Promise.all([
    db.collection("memories")
      .find({ _id: { $in: t.results.map((r: { memory_id: ObjectId }) => r.memory_id) }, person_id: s.person_id }, { projection: { status: 1 } })
      .toArray(),
    membersOf(s.person_id),
  ]);
  const statusNow = new Map(current.map((m) => [m._id.toString(), m.status as string]));

  return {
    id: t._id.toString(),
    at: iso(t.at),
    conversation_id: t.conversation_id ?? null,
    asked_by: askedBy(members, t.user_id),
    question: t.question,
    answer: t.answer ?? null,
    results: t.results.map((r: Record<string, unknown> & { memory_id: ObjectId; created_at: Date }) => ({
      memory_id: r.memory_id.toString(),
      text: r.text as string,
      status: r.status as string,
      current_status: statusNow.get(r.memory_id.toString()) ?? null,
      scope: r.scope as string,
      author_name: (r.author_name as string | null) ?? null,
      author_role: r.author_role as Role,
      created_at: iso(r.created_at),
      vector_score: (r.vector_score as number | null) ?? null,
      rerank_score: (r.rerank_score as number | null) ?? null,
    })),
    top_rerank_score: t.top_rerank_score ?? null,
    min_rerank_score: t.min_rerank_score,
    guidance: t.guidance ?? [],
    degraded: t.degraded ?? null,
  };
}
