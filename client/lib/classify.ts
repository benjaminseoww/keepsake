import "server-only";
import type { Db, Document, ObjectId } from "mongodb";
import { getDb } from "./db";
import { embed, rerank, withRetry, type RetryOpts } from "./voyage";
import { generateJson } from "./gemini";

// classify (A1, A14, R19, R24): does a new memory supersede an existing one?
// Binary per candidate. Kept behind this one function so the method can change (Q1).

// Active method: a rerank-2.5 score at or above this means "supersedes". Placeholder until
// calibrated (Q1). Override with SUPERSEDE_CUTOFF.
// Ben's measurements on keepsake_test: the demo physio change scored 0.648 against "Physio visit is
// every Tuesday at 2pm", and the dinner change 0.569 against the old dinner but also 0.548 against
// "Anna calls every evening around 7". So no fixed cutoff separates "replaces" from "same topic",
// and 0.8 proposes nothing on the demo data. The Gemini judge (CLASSIFY_GEMINI=1) is the likely fix.
export const SUPERSEDE_CUTOFF = Number(process.env.SUPERSEDE_CUTOFF ?? 0.8);
// Optional Gemini judge on top of the reranked candidates (A18 Q1). Off until tested.
export const USE_GEMINI_JUDGE = process.env.CLASSIFY_GEMINI === "1";

export const NUM_CANDIDATES = 100;
export const VECTOR_LIMIT = 20;
export const MAX_CANDIDATES = 10; // memories validator: review.candidates maxItems 10

// Candidates come from these scopes only. private is gone (A17); never include it (R24).
const CANDIDATE_SCOPES = ["family", "caregiver"];

export type CandidateHit = {
  memory_id: ObjectId;
  supersedes: boolean;
  rerank_score: number | null;
  // Looked up so the write service can filter by readable scope (R22) and show the card.
  scope: string;
  text: string;
  author_name: string | null;
  created_at: Date | null;
  // The full candidate document (without its embedding), for callers that need more fields.
  doc: Document;
};

export type Classified = {
  proposed_supersedes: ObjectId | null;
  candidates: CandidateHit[];
  // The document embedding of the new text, reused for the insert so it is embedded once.
  embedding: number[];
};

export type Writer = { user_id: string; name: string; role: string };

export type ClassifyDeps = {
  db?: Db;
  embed?: typeof embed;
  rerank?: typeof rerank;
  retry?: RetryOpts;
  judge?: (text: string, candidates: { text: string }[]) => Promise<boolean[]>;
};

type Hit = Document & { _id: ObjectId; text: string; scope: string; source?: { name?: string }; created_at?: Date };

// Voyage calls retry briefly (withRetry); after that the error propagates, and the caller returns 503 and saves nothing (EDGE-CASES #29).
export async function classify(text: string, person_id: string, _writer: Writer, deps: ClassifyDeps = {}): Promise<Classified> {
  const db = deps.db ?? (await getDb());
  const [vector] = await withRetry(() => (deps.embed ?? embed)([text], "document", 5000), "embed", deps.retry);

  const hits = (await db.collection("memories").aggregate([
    { $vectorSearch: {
      index: "memory_vec", path: "embedding", queryVector: vector, numCandidates: NUM_CANDIDATES, limit: VECTOR_LIMIT,
      filter: { person_id, status: "verified", scope: { $in: CANDIDATE_SCOPES } },
    } },
    { $project: { embedding: 0 } },
  ]).toArray()) as Hit[];
  if (!hits.length) return { proposed_supersedes: null, candidates: [], embedding: vector };

  const ranked = await withRetry(() => (deps.rerank ?? rerank)(text, hits.map((h) => h.text), MAX_CANDIDATES, 5000), "rerank", deps.retry);
  const top = ranked.map((r) => ({ hit: hits[r.index], score: r.relevance_score }));

  let verdicts = top.map((c) => c.score >= SUPERSEDE_CUTOFF);
  const judge = deps.judge ?? (USE_GEMINI_JUDGE ? geminiJudge : null);
  if (judge) {
    try {
      const j = await judge(text, top.map((c) => ({ text: c.hit.text })));
      if (j.length === top.length) verdicts = j;
    } catch (e) {
      console.error("classify: Gemini judge failed, using rerank cutoff", (e as Error).name);
    }
  }

  const candidates: CandidateHit[] = top.map((c, i) => ({
    memory_id: c.hit._id, supersedes: verdicts[i], rerank_score: c.score, scope: c.hit.scope,
    text: c.hit.text, author_name: c.hit.source?.name ?? null, created_at: c.hit.created_at ?? null, doc: c.hit,
  }));
  // Candidates are in rerank order, so the first true one is the top-ranked supersede (A14).
  const proposed = candidates.find((c) => c.supersedes)?.memory_id ?? null;
  return { proposed_supersedes: proposed, candidates, embedding: vector };
}

// Not active by default. Asks Gemini whether the new note replaces each existing note.
async function geminiJudge(text: string, candidates: { text: string }[]): Promise<boolean[]> {
  const list = candidates.map((c, i) => `${i}. ${c.text}`).join("\n");
  const out = await generateJson<{ supersedes: boolean[] }>(
    `A new note about Margaret was written. For each existing note, answer true only if the new note replaces it (the same fact or event with a new value, time or place). Different events on the same day, or additions, are false.\n\nNew note: """${text}"""\n\nExisting notes:\n${list}\n\nReturn one boolean per existing note, in order.`,
    { type: "OBJECT", properties: { supersedes: { type: "ARRAY", items: { type: "BOOLEAN" } } }, required: ["supersedes"] },
  );
  return out.supersedes;
}
