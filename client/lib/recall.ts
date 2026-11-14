import { ObjectId } from "mongodb";
import { getDb } from "./db";
import { SCHEMA_VERSION, SCOPES, type Scope } from "./memories";
import type { Role, Session } from "./auth";
import { embed, rerank, VoyageError } from "./voyage";
import { isoDate } from "./time";
import { traceTurn } from "./tracing";
import { loadGuidance } from "./guidance";

// Calibrated on the seed data (scripts/calibrate-recall.mts, Nov 14): in-knowledge 0.646-0.882, out-of-knowledge 0.256-0.371.
export const MIN_RERANK_SCORE = Number(process.env.MIN_RERANK_SCORE ?? 0.5);
// Only used when rerank fails and we fall back to vector order.
export const MIN_VECTOR_SCORE = Number(process.env.MIN_VECTOR_SCORE ?? 0.7);

const NUM_CANDIDATES = 100;
const VECTOR_LIMIT = 20;
const TOP_K = 5;

// A17: Margaret reads family and caregiver, like family. Nothing is private to her, so no private text reaches turns or the trace.
export const readableScopes = (role: Role): Scope[] => SCOPES[role].filter((sc) => sc !== "private");

export type Degraded = null | "embed_error" | "rerank_timeout" | "rerank_error" | "regex";

export type Candidate = {
  _id: ObjectId;
  text: string;
  scope: Scope;
  status: string;
  source: { role: Role; user_id: string; name?: string }; // name stored since A15; older memories lack it
  created_at: Date;
  vector_score: number | null;
  rerank_score: number | null;
};

// Ranked candidates before the cutoff, best first, at most TOP_K. Read-only: the calibration script calls this directly.
// Only verified memories reach the agent; unverified ones wait for family review.
export async function search(person_id: string, scopes: Scope[], query: string): Promise<{ candidates: Candidate[]; degraded: Degraded }> {
  const filter = { person_id, scope: { $in: scopes }, status: "verified" };
  const memories = (await getDb()).collection("memories");

  let vector: number[];
  try {
    [vector] = await embed([query], "query");
  } catch (e) {
    // No vector means no relevance signal. A keyword match here answers "doctor's phone number" with the phone charger,
    // so the agent gets nothing and says it isn't sure.
    console.warn("query embed failed, returning nothing:", (e as Error).message);
    return { candidates: [], degraded: "embed_error" };
  }

  let hits: Candidate[];
  try {
    hits = await memories.aggregate<Candidate>([
      { $vectorSearch: { index: "memory_vec", path: "embedding", queryVector: vector, numCandidates: NUM_CANDIDATES, limit: VECTOR_LIMIT, filter } },
      { $project: { text: 1, scope: 1, status: 1, source: 1, created_at: 1, vector_score: { $meta: "vectorSearchScore" }, rerank_score: null } },
    ]).toArray();
  } catch (e) {
    // The vector index is building or missing (fresh cluster): keyword match so setup still answers something.
    console.warn("vector search unavailable, using keyword fallback:", (e as Error).message);
    return { candidates: await keywordSearch(filter, query), degraded: "regex" };
  }
  if (!hits.length) return { candidates: [], degraded: null };

  try {
    const ranked = await rerank(query, hits.map((h) => h.text), TOP_K);
    return { candidates: ranked.map((r) => ({ ...hits[r.index], rerank_score: r.relevance_score })), degraded: null };
  } catch (e) {
    console.warn("rerank failed, using vector order:", (e as Error).message);
    const timeout = e instanceof VoyageError && e.kind === "timeout";
    return {
      candidates: hits.filter((h) => (h.vector_score ?? 0) >= MIN_VECTOR_SCORE).slice(0, TOP_K),
      degraded: timeout ? "rerank_timeout" : "rerank_error",
    };
  }
}

async function keywordSearch(filter: object, query: string): Promise<Candidate[]> {
  const words = query.toLowerCase().match(/[a-z']{4,}/g) ?? [];
  if (!words.length) return [];
  const rx = new RegExp(words.map((w) => w.replace(/[^a-z]/g, "")).filter(Boolean).join("|"), "i");
  const docs = await (await getDb()).collection("memories")
    .find({ ...filter, text: rx }, { projection: { text: 1, scope: 1, status: 1, source: 1, created_at: 1 } })
    .limit(TOP_K).toArray();
  return docs.map((d) => ({ ...(d as unknown as Candidate), vector_score: null, rerank_score: null }));
}

// What the voice agent receives. source.name lets it say "Ravi said…".
export type RecalledMemory = { text: string; status: string; added_on: string; source: { role: Role; name: string | null } };

// Rerank scores are cut off here. Vector fallback was already floored; keyword fallback has no scores.
// Shared with scripts/eval-recall.mts so the eval scores exactly what the agent would get.
export const applyCutoff = (candidates: Candidate[]) =>
  candidates.filter((c) => c.rerank_score === null || c.rerank_score >= MIN_RERANK_SCORE);

// Search, apply the cutoff, and log the turn for the trace. Empty memories means "I'm not sure, let's ask your family".
// `trace` sends the turn to LangSmith; the route runs it after responding so it never delays the agent.
export async function recall(s: Session, query: string, conversation_id: string | null) {
  const db = await getDb();
  const startedAt = Date.now();
  const [{ candidates, degraded }, household, guidance] = await Promise.all([
    search(s.person_id, readableScopes(s.role), query),
    db.collection("households").findOne({ person_id: s.person_id }, { projection: { members: 1 } }),
    s.role === "person" ? loadGuidance(s) : Promise.resolve([]),
  ]);
  const searchedAt = Date.now();

  const members = new Map<string, string>((household?.members ?? []).map((m: { user_id: string; name: string }) => [m.user_id, m.name]));
  const author = (c: Candidate) => c.source.name ?? members.get(c.source.user_id) ?? null;
  const kept = applyCutoff(candidates);

  const { insertedId } = await db.collection("turns").insertOne({
    schema_version: SCHEMA_VERSION,
    person_id: s.person_id,
    user_id: s.user_id,
    conversation_id,
    at: new Date(),
    question: query,
    guidance,
    results: kept.map((c) => ({
      memory_id: c._id,
      text: c.text,
      status: c.status,
      scope: c.scope,
      author_name: author(c),
      author_role: c.source.role,
      created_at: c.created_at,
      vector_score: c.vector_score,
      rerank_score: c.rerank_score,
    })),
    top_rerank_score: candidates[0]?.rerank_score ?? null,
    min_rerank_score: MIN_RERANK_SCORE,
    degraded,
    answer: null,
  });

  const memories: RecalledMemory[] = kept.map((c) => ({
    text: c.text,
    status: c.status,
    added_on: isoDate(c.created_at),
    source: { role: c.source.role, name: author(c) },
  }));
  const trace = () => traceTurn({
    turnId: insertedId, question: query, conversationId: conversation_id, person_id: s.person_id, user_id: s.user_id, role: s.role,
    startedAt, searchedAt, candidates, memories, guidance, degraded, minRerankScore: MIN_RERANK_SCORE,
  });
  return { turn_id: insertedId.toString(), memories, ...(s.role === "person" && { guidance }), trace };
}
