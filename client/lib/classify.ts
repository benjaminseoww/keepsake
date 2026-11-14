import "server-only";
import type { Db, Document, ObjectId } from "mongodb";
import { getDb } from "./db";
import { embed, rerank, withRetry, type RetryOpts } from "./voyage";
import { generateJson } from "./gemini";
import { stripTimes, timesDiffer } from "./strip-times";

// classify (A1, A14, R19, R24): does a new memory supersede an existing one?
// Binary per candidate. Kept behind this one function so the method can change (Q1).

// Active method: a rerank-2.5 score at or above this means "supersedes". Placeholder until
// calibrated (Q1). Override with SUPERSEDE_CUTOFF.
// Ben's measurements on keepsake_test: the demo physio change scored 0.648 against "Physio visit is
// every Tuesday at 2pm", and the dinner change 0.569 against the old dinner but also 0.548 against
// "Anna calls every evening around 7". So no fixed cutoff separates "replaces" from "same topic",
// and 0.8 proposes nothing on the demo data. The Gemini judge (CLASSIFY_GEMINI=1) is the likely fix.
export const SUPERSEDE_CUTOFF = Number(process.env.SUPERSEDE_CUTOFF ?? 0.8);
// Time-stripped check (Daniel's idea): rerank again with times and dates replaced by <TIME>/<DATE>
// (lib/strip-times.ts). A stripped score at or above STRIPPED_CUTOFF, plus a time, date or event_start
// that differs between the originals, means "supersedes". The plain cutoff above still applies too.
// Tuned 2026-11-14 with scripts/tune-classify.mts on real Voyage scores. Stripped supersedes scored 0.614 (physio),
// 0.818 (Leo), 0.845 and 0.896 (dinner); the highest must-not was 0.436 ("Anna calls every evening around 7").
// 0.55 sits in that gap. Off with STRIPPED_CUTOFF=off.
// Costs one more rerank call, only when the new note has a time or date.
export const STRIPPED_CUTOFF = process.env.STRIPPED_CUTOFF === "off" ? null : Number(process.env.STRIPPED_CUTOFF ?? 0.55);
// Gemini judge for contradictions and replacements the rerank score can't see, e.g. "Margaret has no grandkids"
// scored 0.648 against "Margaret has two grandchildren, Leo and Maya" (below 0.8). It only looks at candidates
// scoring at least JUDGE_MIN that the rules above did not already mark, and it can only add a supersede, never
// remove one. On by default; CLASSIFY_GEMINI=0 turns it off. Costs one Gemini call when a candidate qualifies.
export const USE_GEMINI_JUDGE = process.env.CLASSIFY_GEMINI !== "0";
export const JUDGE_MIN = Number(process.env.JUDGE_MIN ?? 0.4);

export const NUM_CANDIDATES = 100;
export const VECTOR_LIMIT = 20;
export const MAX_CANDIDATES = 10; // memories validator: review.candidates maxItems 10

// Candidates come from these scopes only. private is gone (A17); never include it (R24).
const CANDIDATE_SCOPES = ["family", "caregiver"];

export type CandidateHit = {
  memory_id: ObjectId;
  supersedes: boolean;
  rerank_score: number | null;
  // Score of the time-stripped texts, when that check ran.
  stripped_score: number | null;
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
  // The new fact's resolved date, compared with each candidate's event_start.
  event_start?: Date | null;
  stripped_cutoff?: number | null;
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

  const verdicts = top.map((c) => c.score >= SUPERSEDE_CUTOFF);
  const strippedScores: (number | null)[] = top.map(() => null);
  const cutoff = deps.stripped_cutoff !== undefined ? deps.stripped_cutoff : STRIPPED_CUTOFF;
  const mine = stripTimes(text);
  if (cutoff !== null && mine.keys.length) {
    const theirs = top.map((c) => stripTimes(c.hit.text));
    try {
      const r2 = await withRetry(() => (deps.rerank ?? rerank)(mine.text, theirs.map((t) => t.text), top.length, 5000), "rerank-stripped", deps.retry);
      for (const r of r2) {
        strippedScores[r.index] = r.relevance_score;
        const old = top[r.index].hit as Hit & { event_start?: Date };
        if (r.relevance_score >= cutoff && timesDiffer(mine, theirs[r.index], deps.event_start, old.event_start)) verdicts[r.index] = true;
      }
    } catch (e) {
      // The plain cutoff already ran, so a failure here only loses the extra check.
      console.error("classify: stripped rerank failed, using the plain cutoff", (e as Error).name);
    }
  }
  const judge = deps.judge ?? (USE_GEMINI_JUDGE ? geminiJudge : null);
  const ask = top.map((c, i) => i).filter((i) => !verdicts[i] && top[i].score >= JUDGE_MIN);
  if (judge && ask.length) {
    try {
      const j = await judge(text, ask.map((i) => ({ text: top[i].hit.text })));
      if (j.length === ask.length) ask.forEach((i, k) => { if (j[k]) verdicts[i] = true; });
    } catch (e) {
      console.error("classify: Gemini judge failed, using rerank cutoff", (e as Error).name);
    }
  }

  const candidates: CandidateHit[] = top.map((c, i) => ({
    memory_id: c.hit._id, supersedes: verdicts[i], rerank_score: c.score, stripped_score: strippedScores[i], scope: c.hit.scope,
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
    `A family member wrote a new note about the person they care for. For each existing note, answer true if the new note replaces it or contradicts it, so the existing note would no longer be true. Examples that are true: the same event at a new time or place, a changed routine, or a denial such as "has no grandchildren" against "has two grandchildren". Count contradictions that follow by plain logic too: "has no kids" contradicts "has two grandchildren" and any note that names their son or daughter. Different events on the same day, related facts that can both be true, and additions are false.\n\nNew note: """${text}"""\n\nExisting notes:\n${list}\n\nReturn one boolean per existing note, in order.`,
    { type: "OBJECT", properties: { supersedes: { type: "ARRAY", items: { type: "BOOLEAN" } } }, required: ["supersedes"] },
  );
  return out.supersedes;
}
