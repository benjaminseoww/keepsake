import type { ObjectId } from "mongodb";
import { RunTree } from "langsmith/run_trees";
import type { Candidate, Degraded, RecalledMemory } from "./recall";
import type { TopicGuidance } from "./guidance";
import type { Role } from "./auth";

// LangSmith observability for recall (Margaret's voice agent, and written searches by caregivers and family). Per turn: a "recall" trace (question, retriever step with every candidate
// and its scores, what the agent was given) and an "agent_answer" run (question, memories, what the agent said).
// Both carry the ElevenLabs conversation id as thread_id, so a conversation reads as one LangSmith thread.
// Off unless LANGSMITH_TRACING=true and a key is set. Best effort: failures log a warning and never touch recall.
const enabled = () => process.env.LANGSMITH_TRACING === "true" && !!process.env.LANGSMITH_API_KEY;
const project = () => process.env.LANGSMITH_PROJECT ?? "keepsake";

// Run ids derive from the turn's ObjectId so each run is posted at most once: LangSmith rejects a second create or update.
export function runIdFor(turnId: ObjectId | string, kind: "recall" | "answer") {
  const h = turnId.toString() + (kind === "recall" ? "00000000" : "a0000000");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

async function post(...runs: RunTree[]) {
  for (const r of runs) await r.postRun(true); // parent first, then children
  await runs[0].client.awaitPendingTraceBatches();
}

// Since D-A8 anyone in the household can recall: Margaret by voice, caregivers and family in writing.
const channel = (role: Role) => (role === "person" ? ["voice", "elevenlabs"] : [role, "written"]);

export type TurnTrace = {
  turnId: ObjectId;
  question: string;
  conversationId: string | null;
  person_id: string;
  user_id: string;
  role: Role;
  startedAt: number;
  searchedAt: number;
  candidates: Candidate[];
  memories: RecalledMemory[];
  degraded: Degraded;
  minRerankScore: number;
  guidance?: TopicGuidance[];
};

export async function traceTurn(t: TurnTrace) {
  if (!enabled()) return;
  try {
    const run = new RunTree({
      id: runIdFor(t.turnId, "recall"),
      name: "recall",
      run_type: "chain",
      project_name: project(),
      start_time: t.startedAt,
      inputs: { question: t.question },
      tags: [channel(t.role)[0], t.degraded ? `degraded:${t.degraded}` : "search:ok", t.memories.length ? "has-memories" : "no-memories"],
      metadata: { thread_id: t.conversationId ?? t.turnId.toString(), turn_id: t.turnId.toString(), person_id: t.person_id, user_id: t.user_id, role: t.role },
    });
    const search = run.createChild({ name: "search", run_type: "retriever", start_time: t.startedAt, inputs: { query: t.question } });
    await search.end({
      documents: t.candidates.map((c) => ({
        type: "Document",
        page_content: c.text,
        metadata: { scope: c.scope, status: c.status, vector_score: c.vector_score, rerank_score: c.rerank_score,
          kept: c.rerank_score === null || c.rerank_score >= t.minRerankScore },
      })),
      degraded: t.degraded,
    }, undefined, t.searchedAt);
    await run.end({ memories: t.memories, guidance: t.guidance ?? [], degraded: t.degraded, min_rerank_score: t.minRerankScore });
    await post(run, search);
  } catch (e) {
    console.warn("langsmith: recall trace failed:", (e as Error).message);
  }
}

export type AnswerTrace = {
  turnId: string;
  question: string;
  conversationId: string | null;
  person_id: string;
  role: Role;
  at: Date;
  memories: { text: string; status: string; source: string | null }[];
  answer: string;
  guidance?: TopicGuidance[];
};

// The answer given from a recall (the voice agent's speech, or a written answer), posted once per turn when it has settled.
export async function traceAnswer(a: AnswerTrace) {
  if (!enabled()) return;
  try {
    const run = new RunTree({
      id: runIdFor(a.turnId, "answer"),
      name: "agent_answer",
      run_type: "llm",
      project_name: project(),
      start_time: a.at.getTime(),
      inputs: { question: a.question, memories: a.memories, guidance: a.guidance ?? [] },
      tags: [...channel(a.role), a.memories.length ? "has-memories" : "no-memories"],
      metadata: { thread_id: a.conversationId ?? a.turnId, turn_id: a.turnId, person_id: a.person_id, role: a.role,
        ...(a.role === "person" && { ls_provider: "elevenlabs" }) },
    });
    await run.end({ answer: a.answer });
    await post(run);
  } catch (e) {
    // 409 means this turn's answer was already traced (a retried request): nothing to do.
    if (!/409|already/i.test((e as Error).message)) console.warn("langsmith: answer trace failed:", (e as Error).message);
  }
}
