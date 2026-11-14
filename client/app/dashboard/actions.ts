"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  ConfirmMismatch, WriteError, correctMemory as correct, createMemory, forgetMemory as forget, reviewMemory,
  type BatchResult, type FactInput, type OldMemory, type WriteResult,
} from "@/lib/writes";

// Dashboard forms. Each action calls the same lib/writes.ts function as its /api/memories route,
// so the dashboard and future clients share one set of rules (docs/api-writes.yaml).

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

// What the add and correct forms show after submitting: done, an error, or "Are you sure? This will supersede <old>".
export type FormState =
  | { kind: "idle" }
  | { kind: "saved"; message: string }
  | { kind: "error"; message: string }
  | { kind: "confirm"; old: OldMemory; text: string; scope?: string }
  // A multi-fact note with at least one conflict (A17): resend the split facts, not the raw text.
  | { kind: "confirm_batch"; facts: FactInput[]; facts_token: string; conflicts: { text: string; old: OldMemory }[]; scope?: string };

function askBatch(b: BatchResult, scope?: string): FormState {
  const facts = b.facts.map((f) => ({
    text: f.text, event_start: f.event_start, event_end: f.event_end,
    ...("old" in f.result && { confirm_supersedes: f.result.old.memory_id }),
  }));
  const conflicts = b.facts.flatMap((f) => ("old" in f.result ? [{ text: f.text, old: f.result.old }] : []));
  return { kind: "confirm_batch", facts, facts_token: b.facts_token ?? "", conflicts, scope };
}

async function run(write: () => Promise<WriteResult | BatchResult>, text: string, scope?: string): Promise<FormState> {
  try {
    const r = await write();
    if ("batch" in r) {
      if (!r.saved) return askBatch(r, scope);
      revalidatePath("/dashboard");
      const review = r.facts.some((f) => "needs_family_review" in f.result && f.result.needs_family_review);
      return { kind: "saved", message: `Saved ${r.facts.length} memories.${review ? " Sent to family for review." : ""}` };
    }
    if (r.needs_confirmation) return { kind: "confirm", old: r.old, text, scope };
    revalidatePath("/dashboard");
    return { kind: "saved", message: r.needs_family_review ? `Sent to family for review: "${r.text}"` : `Saved: "${r.text}"` };
  } catch (e) {
    // The memory changed since the prompt: ask again about whatever is proposed now (R21).
    if (e instanceof ConfirmMismatch) {
      return "batch" in e.payload ? askBatch(e.payload, scope) : { kind: "confirm", old: e.payload.old, text, scope };
    }
    if (e instanceof WriteError) return { kind: "error", message: e.message };
    throw e;
  }
}

const confirmFields = (form: FormData) => ({ confirm: str(form, "confirm") === "true", confirm_supersedes: str(form, "confirm_supersedes") || undefined });

// POST /api/memories, as a form.
export async function addMemory(_prev: FormState, form: FormData): Promise<FormState> {
  const s = await requireSession(["family", "caregiver"]);
  const text = str(form, "text");
  const scope = str(form, "scope") || undefined;
  const rawFacts = str(form, "facts");
  let facts: FactInput[] | undefined;
  if (rawFacts) {
    try { facts = JSON.parse(rawFacts); } catch { return { kind: "error", message: "Please add the note again." }; }
  }
  const facts_token = str(form, "facts_token") || undefined;
  // A batch resend sends facts and no text.
  return run(() => createMemory(s, { ...(facts ? { facts, facts_token } : { text }), scope, ...confirmFields(form) }), text, scope);
}

// POST /api/memories/:id/corrections, as a form.
export async function correctMemory(_prev: FormState, form: FormData): Promise<FormState> {
  const s = await requireSession(["family"]);
  const text = str(form, "text");
  return run(() => correct(s, str(form, "id"), { text, ...confirmFields(form) }), text);
}

// POST /api/memories/:id/review. A review someone else just decided is fine to ignore: the page refreshes.
async function decide(form: FormData, decision: "confirm" | "deny") {
  const s = await requireSession(["family"]);
  try {
    await reviewMemory(s, str(form, "id"), decision);
  } catch (e) {
    if (!(e instanceof WriteError && e.code === "conflict")) throw e;
  }
  revalidatePath("/dashboard");
}
export async function verifyMemory(form: FormData) { await decide(form, "confirm"); }
export async function denyMemory(form: FormData) { await decide(form, "deny"); }

// DELETE /api/memories/:id.
export async function forgetMemory(form: FormData) {
  const s = await requireSession(["family"]);
  await forget(s, str(form, "id"));
  revalidatePath("/dashboard");
}

export async function saveGuidance(form: FormData) {
  const s = await requireSession(["family"]);
  const topic = str(form, "topic").toLowerCase();
  const guidance = str(form, "guidance");
  if (!topic || !guidance) throw new Error("Topic and guidance are required");

  await (await getDb()).collection("topic_guidance").updateOne(
    { person_id: s.person_id, topic },
    { $set: { guidance, set_by: s.user_id, updated_at: new Date() }, $setOnInsert: { related_memory_ids: [] } },
    { upsert: true },
  );
  revalidatePath("/dashboard");
}
