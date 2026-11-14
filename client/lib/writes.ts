import { createHmac, timingSafeEqual } from "node:crypto";
import { ObjectId, type ClientSession, type Document } from "mongodb";
import type { Session } from "./auth";
import { getClient, getDb } from "./db";
import type { ErrorCode } from "./http";
import { SCHEMA_VERSION, actor, audit, type Scope } from "./memories";
import { readableScopes } from "./recall";
import { embed, withRetry, VoyageError } from "./voyage";
import { classify as classifyCandidates } from "./classify";
import { validate, revalidateFacts, ValidationError, type Fact } from "./validate";

// The memory write path: add, correct, review (confirm/deny), forget, and the review queue.
// HTTP contract: docs/api-writes.yaml. The /api/memories and /api/reviews routes and the dashboard
// server actions both call these functions, so every surface gets the same rules.

// Q1 is open (rerank cutoff vs an LLM), so the supersede decision lives behind classify() alone.
// The method itself is in classify.ts (cutoff, optional Gemini judge, and the score notes).

// Thrown for a request the caller got wrong; routes turn it into { error: { code, message } }.
export class WriteError extends Error {
  constructor(public code: ErrorCode, message: string) { super(message); }
}

// R21: on a stale or missing confirm, the 409 body is a fresh needs-confirmation payload, not the error shape.
export class ConfirmMismatch extends Error {
  constructor(public payload: NeedsConfirmation | BatchResult) { super("Confirmation no longer matches"); }
}

type Role = Session["role"];
type From = { name: string; role: Role };
export type Candidate = { memory_id: string; text?: string; author_name?: string | null; created_at?: string | null; supersedes: boolean; rerank_score: number | null };
export type OldMemory = { memory_id: string; text: string; author_name: string; created_at: string };
export type NeedsConfirmation = { needs_confirmation: true; old: OldMemory };
export type SavedWrite = {
  saved: true; needs_confirmation: false; needs_family_review: boolean;
  memory_id: string; status: string; scope: Scope; from: From;
  // The stored text, after validate's rewrite ("tomorrow" becomes "on Sun Nov 15").
  text: string; event_start: string | null; event_end: string | null;
  proposed_supersedes?: string | null; supersedes?: string | null; audit_action: "write" | "approve" | "verify";
  message?: string | null; candidates: Candidate[];
};
export type WriteResult = NeedsConfirmation | SavedWrite;

// Multi-fact notes (A17): one result per fact. saved is false when any fact needs confirmation.
export type NotSaved = { saved: false; needs_confirmation: false };
export type BatchFactResult = { text: string; event_start: string | null; event_end: string | null; result: SavedWrite | NeedsConfirmation | NotSaved };
// facts_token is set when saved is false. The confirm resend must send it back with the same facts.
export type BatchResult = { batch: true; saved: boolean; facts: BatchFactResult[]; facts_token?: string };

// A confirm resend of a multi-fact note sends the split facts back, each with its own confirm_supersedes.
export type FactInput = { text: string; event_start?: string | null; event_end?: string | null; confirm_supersedes?: string };
export type MemoryInput = { text?: string; scope?: string; confirm?: boolean; confirm_supersedes?: string; facts?: FactInput[]; facts_token?: string };

const memories = async () => (await getDb()).collection("memories");
const iso = (d?: Date | null) => (d ? d.toISOString() : null);
// Display names for a household. Memories written before migration 006 have no source.name (A15).
type Names = Map<string, string>;
async function householdNames(person_id: string): Promise<Names> {
  const h = await (await getDb()).collection("households").findOne({ person_id }, { projection: { members: 1 } });
  return new Map((h?.members ?? []).map((m: { user_id: string; name: string }) => [m.user_id, m.name]));
}
const authorName = (m: Document, names: Names) =>
  (m.source?.name as string | undefined) ?? names.get(m.source?.user_id) ?? (m.source?.user_id as string);
const from = (s: Session): From => ({ name: s.name, role: s.role });
const isFamily = (s: Session) => s.role === "family";

function requireRole(s: Session, roles: Role[], message: string) {
  if (!roles.includes(s.role)) throw new WriteError("forbidden", message);
}

// Signs the split facts (text and dates) we returned in a saved:false batch, for this writer, person and scope.
// A resend's facts must carry this token, so they are exactly what validate produced: the client
// can't skip Gemini or change event_start/event_end. HMAC-SHA256 with AUTH_SECRET.
function factsToken(s: Session, scope: Scope, facts: Fact[]): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set");
  const body = JSON.stringify([s.user_id, s.person_id, scope, facts.map((f) => [f.text, iso(f.event_start), iso(f.event_end)])]);
  return createHmac("sha256", secret).update(body).digest("base64url");
}
function tokenMatches(s: Session, scope: Scope, facts: Fact[], token: unknown): boolean {
  if (typeof token !== "string") return false;
  const want = Buffer.from(factsToken(s, scope, facts));
  const got = Buffer.from(token);
  return want.length === got.length && timingSafeEqual(want, got);
}

// Validate results for 10 minutes, per writer, person, Toronto day and text. When Voyage fails after
// validate (503), the user's retry reuses the split instead of spending another Gemini call.
// Per server process; cleared on restart.
const VALIDATE_TTL_MS = 10 * 60_000;
const validated = new Map<string, { at: number; facts: Fact[] }>();
export const clearValidateCache = () => validated.clear(); // for tests
async function validateOnce(s: Session, text: unknown): Promise<Fact[]> {
  const day = new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
  const key = JSON.stringify([s.user_id, s.person_id, day, typeof text === "string" ? text.trim() : text]);
  const hit = validated.get(key);
  if (hit && Date.now() - hit.at < VALIDATE_TTL_MS) return hit.facts;
  const { facts } = await validate(text, s);
  for (const [k, v] of validated) if (Date.now() - v.at >= VALIDATE_TTL_MS) validated.delete(k);
  if (validated.size >= 500) validated.delete(validated.keys().next().value!);
  validated.set(key, { at: Date.now(), facts });
  return facts;
}

// Validation layer (A17): every add runs validate (empty/length checks, then Gemini splits facts and
// rewrites relative dates). The one exception is the confirm resend of a multi-fact note: it sends
// back facts[] with the facts_token from our saved:false batch, and those facts are not re-split.
async function factsOf(s: Session, input: MemoryInput, scope: Scope): Promise<Fact[]> {
  try {
    if (input.facts !== undefined) {
      if (input.confirm !== true || input.text) throw new WriteError("bad_request", "facts is only accepted on a confirm resend (confirm: true, no text)");
      const facts = revalidateFacts(input.facts);
      if (!tokenMatches(s, scope, facts, input.facts_token)) throw new WriteError("bad_request", "facts don't match the ones we returned; add the note again");
      return facts;
    }
    return await validateOnce(s, input.text);
  } catch (e) {
    if (e instanceof ValidationError) throw new WriteError(e.code, e.message);
    throw e;
  }
}
const dates = (f: Fact) => ({ event_start: iso(f.event_start), event_end: iso(f.event_end) });
// Stored only when set; the validator types them as dates (migration 006).
const dateFields = (f: Fact) => ({ ...(f.event_start && { event_start: f.event_start }), ...(f.event_end && { event_end: f.event_end }) });

function parseId(id: unknown, what = "Memory") {
  if (typeof id !== "string" || !ObjectId.isValid(id)) throw new WriteError("not_found", `${what} not found`);
  return new ObjectId(id);
}

const oldOf = (m: Document, names: Names): OldMemory => ({
  memory_id: m._id.toString(), text: m.text, author_name: authorName(m, names), created_at: m.created_at.toISOString(),
});

// One transaction per multi-document change (R3, D7).
async function inTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  const client = await getClient();
  return client.withSession((session) => session.withTransaction(() => fn(session)));
}

type Classified = {
  names: Names;
  embedding: number[];
  proposed: Document | null;
  candidates: { doc: Document; supersedes: boolean; rerank_score: number | null }[];
};

// Finds verified memories this one might replace (R19, R24) and decides supersedes per candidate (A14),
// via classify.ts. The embedding is reused for the insert. No embedding means no conflict check, so a
// Voyage failure is a 503 and nothing is saved (R7, EDGE-CASES #29).
export async function classify(text: string, person_id: string, s?: Session): Promise<Classified> {
  const names = await householdNames(person_id);
  try {
    const c = await classifyCandidates(text, person_id, s ?? { user_id: "", name: "", role: "family" });
    const candidates = c.candidates.map((x) => ({ doc: x.doc, supersedes: x.supersedes, rerank_score: x.rerank_score }));
    return { names, embedding: c.embedding, proposed: candidates.find((x) => x.supersedes)?.doc ?? null, candidates };
  } catch (e) {
    if (e instanceof VoyageError) throw new WriteError("unavailable", "The memory check is unavailable right now. Nothing was saved. Please try again.");
    throw e;
  }
}

const candidateOut = (c: Classified["candidates"][number], names: Names): Candidate => ({
  memory_id: c.doc._id.toString(), text: c.doc.text, author_name: authorName(c.doc, names), created_at: iso(c.doc.created_at),
  supersedes: c.supersedes, rerank_score: c.rerank_score,
});

// What the writer may see about the classification: only memories in their readable scopes (A3, R22).
function visibleClassification(s: Session, c: Classified) {
  const scopes = readableScopes(s.role);
  const proposedVisible = c.proposed && scopes.includes(c.proposed.scope);
  return {
    candidates: c.candidates.filter((x) => scopes.includes(x.doc.scope)).map((x) => candidateOut(x, c.names)),
    proposed_supersedes: proposedVisible ? c.proposed!._id.toString() : null,
    message: proposedVisible ? `This will supersede ${c.proposed!.text}` : null,
  };
}

const reviewOf = (c: Classified) => ({
  state: "pending" as const,
  proposed_supersedes: c.proposed?._id ?? null,
  candidates: c.candidates.map((x) => ({ memory_id: x.doc._id, supersedes: x.supersedes, rerank_score: x.rerank_score })),
  decided_by: null, decided_at: null,
});

// Someone else superseded or forgot the old memory since the writer saw it: throwing aborts the transaction.
class OldChanged extends Error {}

type Kind = "pending" | "verified" | "supersede";
type Plan = { fact: Fact; c: Classified; kind: Kind };

// Saves one fact inside a transaction (insert, supersede if any, audit) and returns its SavedWrite.
async function saveFact(s: Session, scope: Scope, p: Plan, session: ClientSession): Promise<SavedWrite> {
  const coll = await memories();
  const { fact, c, kind } = p;
  const base = {
    schema_version: SCHEMA_VERSION, person_id: s.person_id, text: fact.text, scope, source: actor(s),
    embedding: c.embedding, created_at: new Date(), ...dateFields(fact),
  };
  const out = { saved: true as const, needs_confirmation: false as const, scope, from: from(s), text: fact.text, ...dates(fact) };

  if (kind === "pending") {
    // Caregiver: saved unverified for family review, whatever classify found (R15).
    const { insertedId } = await coll.insertOne({ ...base, status: "unverified", flagged: true, supersedes: null, review: reviewOf(c) }, { session });
    await audit(s, insertedId, "write", scope, null, null, session);
    return { ...out, needs_family_review: true, memory_id: insertedId.toString(), status: "unverified", audit_action: "write", ...visibleClassification(s, c) };
  }
  if (kind === "verified") {
    // Family, nothing to supersede: trusted, saved verified. A stale confirm has nothing left to confirm.
    const { insertedId } = await coll.insertOne({ ...base, status: "verified", flagged: false, supersedes: null }, { session });
    await audit(s, insertedId, "write", scope, null, null, session);
    return { ...out, needs_family_review: false, memory_id: insertedId.toString(), status: "verified", audit_action: "write", ...visibleClassification(s, c) };
  }
  // Family confirmed a supersede (A6): flip the old one only if it's still verified (R21).
  const old = c.proposed!;
  const flipped = await coll.updateOne({ _id: old._id, person_id: s.person_id, status: "verified" }, { $set: { status: "superseded" } }, { session });
  if (!flipped.modifiedCount) throw new OldChanged();
  const review = { ...reviewOf(c), state: "approved", decided_by: s.user_id, decided_at: new Date() };
  const { insertedId } = await coll.insertOne({ ...base, status: "verified", flagged: false, supersedes: old._id, review }, { session });
  await audit(s, insertedId, "approve", scope, old._id, insertedId, session);
  return {
    ...out, needs_family_review: false, memory_id: insertedId.toString(), status: "verified", audit_action: "approve",
    supersedes: old._id.toString(), ...visibleClassification(s, c),
  };
}

// POST /api/memories. Family and caregiver; Margaret doesn't add memories in the MVP (A16).
// The note runs through validate first; each resulting fact is classified on its own (A17).
export async function createMemory(s: Session, input: MemoryInput): Promise<WriteResult | BatchResult> {
  requireRole(s, ["family", "caregiver"], "Only family and caregivers can add memories");
  // R20: caregivers always write caregiver scope; family picks (default family).
  const scope = (isFamily(s) ? input.scope ?? "family" : "caregiver") as Scope;
  if (!readableScopes(s.role).includes(scope)) throw new WriteError("bad_request", "scope must be family or caregiver");

  const facts = await factsOf(s, input, scope);
  return addFacts(s, scope, facts, input);
}

// Plans and saves already-validated facts. Split out so the OldChanged retry doesn't validate again.
async function addFacts(s: Session, scope: Scope, facts: Fact[], input: MemoryInput): Promise<WriteResult | BatchResult> {
  const single = facts.length === 1;
  const confirmIds = input.facts ? input.facts.map((f) => f.confirm_supersedes) : single ? [input.confirm_supersedes] : facts.map(() => undefined);

  // Decide each fact before saving anything.
  const plans: Plan[] = [];
  const asks: (NeedsConfirmation | null)[] = [];
  let mismatch = false;
  for (let i = 0; i < facts.length; i++) {
    const c = await classify(facts[i].text, s.person_id, s);
    let kind: Kind = isFamily(s) ? (c.proposed ? "supersede" : "verified") : "pending";
    let ask: NeedsConfirmation | null = null;
    if (kind === "supersede") {
      ask = { needs_confirmation: true, old: oldOf(c.proposed!, c.names) };
      if (input.confirm === true && confirmIds[i] === c.proposed!._id.toString()) ask = null;
      else if (input.confirm === true && (confirmIds[i] || single)) mismatch = true; // R21: confirmed a different (or no) memory
    }
    if (ask) kind = "supersede";
    plans.push({ fact: facts[i], c, kind });
    asks.push(ask);
  }

  const batchOf = (results: (SavedWrite | NeedsConfirmation | NotSaved)[], saved: boolean): BatchResult => ({
    batch: true, saved, facts: plans.map((p, i) => ({ text: p.fact.text, ...dates(p.fact), result: results[i] })),
    ...(!saved && { facts_token: factsToken(s, scope, facts) }),
  });

  if (asks.some(Boolean)) {
    // Save nothing; every conflicting fact gets its own "Are you sure?" (A6, A17).
    if (single) {
      if (mismatch) throw new ConfirmMismatch(asks[0]!);
      return asks[0]!;
    }
    const body = batchOf(asks.map((a) => a ?? { saved: false, needs_confirmation: false }), false);
    if (mismatch) throw new ConfirmMismatch(body);
    return body;
  }

  try {
    const results = await inTransaction(async (session) => {
      const out: SavedWrite[] = [];
      for (const p of plans) out.push(await saveFact(s, scope, p, session));
      return out;
    });
    return single ? results[0] : batchOf(results, true);
  } catch (e) {
    if (!(e instanceof OldChanged)) throw e;
    // The old memory changed between classify and the save. Classify again: a new proposal is a fresh
    // 409 needs-confirmation (R21); with nothing left to supersede, it's a plain conflict.
    const again = await addFacts(s, scope, facts, { ...input, confirm: false });
    if ("needs_confirmation" in again && again.needs_confirmation) throw new ConfirmMismatch(again);
    if ("batch" in again && !again.saved) throw new ConfirmMismatch(again);
    throw new WriteError("conflict", "The old memory was already replaced. Please review and try again.");
  }
}

// POST /api/memories/:id/corrections. Family replaces a verified memory with new text (A2).
// The old memory is kept as superseded for the audit trail and the trace; the new one inherits its scope (R20).
// A caregiver's correction is just an add: POST /api/memories, which goes to family review.
export async function correctMemory(s: Session, id: string, input: MemoryInput): Promise<WriteResult> {
  requireRole(s, ["family"], "Only family can correct a memory; caregivers add a note for review instead");
  const _id = parseId(id);
  const coll = await memories();
  const old = await coll.findOne({ _id, person_id: s.person_id, scope: { $in: readableScopes(s.role) }, status: "verified" }, { projection: { embedding: 0 } });
  if (!old) throw new WriteError("not_found", "Memory not found");

  const facts = await factsOf(s, { text: input.text }, old.scope as Scope);
  if (facts.length !== 1) throw new WriteError("bad_request", "A correction must be one fact. Add the other facts separately.");
  const fact = facts[0];

  const ask: NeedsConfirmation = { needs_confirmation: true, old: oldOf(old, await householdNames(s.person_id)) };
  if (input.confirm !== true) return ask;
  if (input.confirm_supersedes !== id) throw new ConfirmMismatch(ask);

  let embedding: number[];
  try {
    [embedding] = await withRetry(() => embed([fact.text], "document", 5000), "embed");
  } catch {
    // Never store an empty embedding (R7, EDGE-CASES #29).
    throw new WriteError("unavailable", "The memory check is unavailable right now. Nothing was saved. Please try again.");
  }
  const plan: Plan = { fact, c: { names: new Map(), embedding, proposed: old, candidates: [] }, kind: "supersede" };
  try {
    const saved = await inTransaction((session) => saveFact(s, old.scope as Scope, plan, session));
    return { ...saved, proposed_supersedes: id, candidates: [] };
  } catch (e) {
    if (e instanceof OldChanged) throw new ConfirmMismatch(ask);
    throw e;
  }
}

export type ReviewDecision = {
  decision: "confirm" | "deny"; memory_id: string; new_status: string; review_state: string;
  supersedes: string | null; old_status: string | null; audit_action: "approve" | "verify" | "deny";
  decided_by: string; decided_at: string;
};

// POST /api/memories/:id/review. Any family member confirms or denies a pending memory (A12, R3).
export async function reviewMemory(s: Session, id: string, decision: unknown): Promise<ReviewDecision> {
  requireRole(s, ["family"], "Only a family member can confirm or deny a review");
  if (decision !== "confirm" && decision !== "deny") throw new WriteError("bad_request", 'decision must be "confirm" or "deny"');
  const _id = parseId(id);
  const coll = await memories();
  const mem = await coll.findOne({ _id, person_id: s.person_id }, { projection: { review: 1, scope: 1 } });
  if (!mem?.review) throw new WriteError("not_found", "Review not found");
  if (mem.review.state !== "pending") throw new WriteError("conflict", "This review has already been decided");

  const decided_at = new Date();
  const proposed = mem.review.proposed_supersedes as ObjectId | null;

  return inTransaction(async (session) => {
    const pending = { _id, "review.state": "pending" };
    const decidedBy = { "review.decided_by": s.user_id, "review.decided_at": decided_at, flagged: false };

    if (decision === "deny") {
      const r = await coll.updateOne(pending, { $set: { ...decidedBy, status: "retracted", "review.state": "denied" } }, { session });
      if (!r.modifiedCount) throw new WriteError("conflict", "This review has already been decided");
      await audit(s, _id, "deny", mem.scope, null, null, session);
      const old = proposed ? await coll.findOne({ _id: proposed }, { projection: { status: 1 }, session }) : null;
      return result("deny", "retracted", "denied", null, old?.status ?? null, "deny");
    }

    // Confirm: supersede the proposed memory if it's still verified, even if this family member can't read it (R3).
    const old = proposed
      ? await coll.findOneAndUpdate({ _id: proposed, person_id: s.person_id, status: "verified" }, { $set: { status: "superseded" } }, { session })
      : null;
    const supersedes = old?._id ?? null;
    const r = await coll.updateOne(pending, { $set: { ...decidedBy, status: "verified", "review.state": "approved", supersedes } }, { session });
    if (!r.modifiedCount) throw new WriteError("conflict", "This review has already been decided");
    const action = supersedes ? "approve" : "verify";
    await audit(s, _id, action, mem.scope, supersedes, supersedes ? _id : null, session);
    return result("confirm", "verified", "approved", supersedes?.toString() ?? null, supersedes ? "superseded" : null, action);
  });

  function result(d: ReviewDecision["decision"], new_status: string, review_state: string, supersedes: string | null, old_status: string | null, audit_action: ReviewDecision["audit_action"]): ReviewDecision {
    return { decision: d, memory_id: id, new_status, review_state, supersedes, old_status, audit_action, decided_by: s.user_id, decided_at: decided_at.toISOString() };
  }
}

export type ReviewItem = {
  id: string; text: string; status: string; scope: Scope; flagged: boolean; from: From; created_at: string;
  message: string | null; proposed_old: OldMemory | null;
  review: { state: string; proposed_supersedes: string | null; candidates: Candidate[]; decided_by: string | null; decided_at: string | null };
};

// GET /api/reviews (R23). Every pending memory, newest first, with the proposed old memory and candidates looked up.
export async function listReviews(s: Session): Promise<ReviewItem[]> {
  requireRole(s, ["family"], "Only family can see the review queue");
  const coll = await memories();
  const [pending, names] = await Promise.all([
    coll.find({ person_id: s.person_id, "review.state": "pending" }, { projection: { embedding: 0 } }).sort({ created_at: -1 }).toArray(),
    householdNames(s.person_id),
  ]);

  const ids = pending.flatMap((m) => (m.review.candidates ?? []).map((c: { memory_id: ObjectId }) => c.memory_id));
  const lookups = ids.length
    ? await coll.find({ _id: { $in: ids }, scope: { $in: readableScopes(s.role) } }, { projection: { text: 1, source: 1, created_at: 1 } }).toArray()
    : [];
  const byId = new Map(lookups.map((d) => [d._id.toString(), d]));

  return pending.map((m) => {
    const proposedDoc = m.review.proposed_supersedes ? byId.get(m.review.proposed_supersedes.toString()) : undefined;
    return {
      id: m._id.toString(), text: m.text, status: m.status, scope: m.scope, flagged: !!m.flagged,
      from: { name: authorName(m, names), role: m.source.role }, created_at: m.created_at.toISOString(),
      message: proposedDoc ? `This will supersede ${proposedDoc.text}` : null,
      proposed_old: proposedDoc ? oldOf(proposedDoc, names) : null,
      review: {
        state: m.review.state,
        proposed_supersedes: m.review.proposed_supersedes?.toString() ?? null,
        candidates: (m.review.candidates ?? []).map((c: { memory_id: ObjectId; supersedes: boolean; rerank_score: number | null }) => {
          const d = byId.get(c.memory_id.toString());
          return { memory_id: c.memory_id.toString(), ...(d && { text: d.text, author_name: authorName(d, names), created_at: iso(d.created_at) }), supersedes: c.supersedes, rerank_score: c.rerank_score ?? null };
        }),
        decided_by: m.review.decided_by ?? null,
        decided_at: iso(m.review.decided_at),
      },
    };
  });
}

export type MemoryItem = { id: string; text: string; status: string; scope: Scope; flagged: boolean; from: From; created_at: string; supersedes: string | null };

// GET /api/memories. Live memories (unverified and verified) the caller can read, newest first.
// A caregiver sees only their own notes, as on their dashboard.
export async function listMemories(s: Session, status?: string): Promise<MemoryItem[]> {
  requireRole(s, ["family", "caregiver"], "Only family and caregivers can list memories");
  const statuses = status ? [status] : ["unverified", "verified"];
  if (!statuses.every((x) => ["unverified", "verified", "superseded", "retracted"].includes(x))) throw new WriteError("bad_request", "unknown status");
  const names = await householdNames(s.person_id);
  const docs = await (await memories()).find({
    person_id: s.person_id, scope: { $in: readableScopes(s.role) }, status: { $in: statuses },
    ...(isFamily(s) ? {} : { "source.user_id": s.user_id }),
  }, { projection: { embedding: 0, review: 0 } }).sort({ created_at: -1 }).limit(200).toArray();
  return docs.map((m) => ({
    id: m._id.toString(), text: m.text, status: m.status, scope: m.scope, flagged: !!m.flagged,
    from: { name: authorName(m, names), role: m.source.role }, created_at: m.created_at.toISOString(), supersedes: m.supersedes?.toString() ?? null,
  }));
}

// DELETE /api/memories/:id. Family forgets a memory: the document and its embedding are deleted,
// and only a content-free audit row stays.
export async function forgetMemory(s: Session, id: string) {
  requireRole(s, ["family"], "Only family can forget a memory");
  const _id = parseId(id);
  const coll = await memories();
  const mem = await coll.findOne({ _id, person_id: s.person_id, scope: { $in: readableScopes(s.role) } }, { projection: { scope: 1 } });
  if (!mem) throw new WriteError("not_found", "Memory not found");
  await inTransaction(async (session) => {
    await coll.deleteOne({ _id }, { session });
    await audit(s, _id, "forget", mem.scope, _id, null, session);
  });
  return { forgotten: true, memory_id: id };
}
