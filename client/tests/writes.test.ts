import { beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import type { Session } from "@/lib/auth";
import type { CandidateHit, Classified } from "@/lib/classify";
import type { Fact } from "@/lib/validate";
import { fakeDb } from "./fake-db";

// DB, Voyage, Gemini (validate) and classify are mocked; the rules in lib/writes.ts run for real.
process.env.AUTH_SECRET ??= "test-secret";
let f: ReturnType<typeof fakeDb>;
vi.mock("@/lib/db", () => ({ getDb: async () => f.db, getClient: async () => f.client }));

let facts: Fact[] = [];
const validateMock = vi.fn(async () => ({ facts, errors: [] as string[] }));
vi.mock("@/lib/validate", async (orig) => ({ ...(await orig<typeof import("@/lib/validate")>()), validate: (...a: unknown[]) => validateMock(...(a as [])) }));

let classifyResult: (text: string) => Classified = () => cls([]);
const classifyMock = vi.fn(async (text: string) => classifyResult(text));
vi.mock("@/lib/classify", () => ({ classify: (text: string) => classifyMock(text) }));

const embedMock = vi.fn(async () => [[0.7]]);
vi.mock("@/lib/voyage", async (orig) => ({ ...(await orig<typeof import("@/lib/voyage")>()), embed: () => embedMock() }));

const w = await import("@/lib/writes");
const { ValidationError } = await import("@/lib/validate");
const { VoyageError } = await import("@/lib/voyage");

const sess = (user_id: string, name: string, role: Session["role"]): Session => ({ user_id, name, role, person_id: "margaret" });
const anna = sess("anna", "Anna", "family"), david = sess("david", "David", "family"), ravi = sess("ravi", "Ravi", "caregiver");

const dinner = new ObjectId(), physio = new ObjectId(), glasses = new ObjectId();
const mem = (_id: ObjectId, text: string, scope: string, author: string, extra = {}) => ({
  _id, schema_version: 1, person_id: "margaret", text, scope, status: "verified",
  source: { user_id: author, name: author[0].toUpperCase() + author.slice(1), role: author === "ravi" ? "caregiver" : "family" },
  supersedes: null, flagged: false, embedding: [0], created_at: new Date("2026-11-01T10:00:00Z"), ...extra,
});
const byId = (id: string | ObjectId) => f.store.memories.find((m) => (m._id as ObjectId).equals(new ObjectId(String(id))))!;
const hit = (id: ObjectId, supersedes: boolean, score = 0.9): CandidateHit => {
  const d = byId(id);
  return { memory_id: id, supersedes, rerank_score: score, stripped_score: null, scope: d.scope as string, text: d.text as string,
    author_name: (d.source as { name: string }).name, created_at: d.created_at as Date, doc: d };
};
function cls(c: CandidateHit[]): Classified {
  return { proposed_supersedes: c.find((x) => x.supersedes)?.memory_id ?? null, candidates: c, embedding: [0.5] };
}
const reject = async (p: Promise<unknown>) => p.then(() => { throw new Error("expected a rejection"); }, (e) => e);

beforeEach(() => {
  f = fakeDb({
    households: [{ person_id: "margaret", members: [
      { user_id: "anna", name: "Anna", role: "family", admin: true }, { user_id: "david", name: "David", role: "family" },
      { user_id: "ravi", name: "Ravi", role: "caregiver" }, { user_id: "margaret", name: "Margaret", role: "person" },
    ] }],
    memories: [
      mem(dinner, "Anna is bringing dinner on Saturday Nov 14 at 6pm", "family", "anna"),
      mem(physio, "Physio visit is every Tuesday at 2pm", "caregiver", "anna"),
      mem(glasses, "Reading glasses are on the kitchen windowsill", "caregiver", "ravi"),
    ],
  });
  facts = [{ text: "placeholder" }];
  w.clearValidateCache();
  classifyResult = () => cls([]);
  validateMock.mockClear(); classifyMock.mockClear(); embedMock.mockClear();
});

describe("createMemory: family", () => {
  it("#12 no supersede: saved verified with schema_version 1, source with name (A15) and audit write", async () => {
    facts = [{ text: "Margaret's favourite biscuits are ginger snaps" }];
    const r = (await w.createMemory(anna, { text: "x", scope: "family" })) as import("@/lib/writes").SavedWrite;
    expect(r).toMatchObject({ saved: true, needs_family_review: false, status: "verified", scope: "family", from: { name: "Anna", role: "family" }, text: "Margaret's favourite biscuits are ginger snaps", event_start: null, event_end: null });
    expect(byId(r.memory_id)).toMatchObject({ schema_version: 1, source: { user_id: "anna", name: "Anna", role: "family" }, embedding: [0.5] });
    expect(f.store.audit_log.at(-1)).toMatchObject({ action: "write", actor: { user_id: "anna", name: "Anna", role: "family" } });
  });

  it("#1/#9 supersede: asks first and saves nothing; confirm saves verified, supersedes, stores event_start", async () => {
    facts = [{ text: "Anna is bringing dinner at 7pm on Sat Nov 14, not 6", event_start: new Date("2026-11-15T00:00:00Z") }];
    classifyResult = () => cls([hit(dinner, true)]);
    const n = f.store.memories.length;
    const ask = await w.createMemory(anna, { text: "x" });
    expect(ask).toEqual({ needs_confirmation: true, old: { memory_id: dinner.toString(), text: "Anna is bringing dinner on Saturday Nov 14 at 6pm", author_name: "Anna", created_at: "2026-11-01T10:00:00.000Z" } });
    expect(f.store.memories.length).toBe(n);

    const r = (await w.createMemory(anna, { text: "x", confirm: true, confirm_supersedes: dinner.toString() })) as import("@/lib/writes").SavedWrite;
    expect(r).toMatchObject({ saved: true, status: "verified", supersedes: dinner.toString(), audit_action: "approve", text: "Anna is bringing dinner at 7pm on Sat Nov 14, not 6", event_start: "2026-11-15T00:00:00.000Z" });
    expect(byId(dinner).status).toBe("superseded");
    expect(byId(r.memory_id)).toMatchObject({ supersedes: dinner, event_start: new Date("2026-11-15T00:00:00Z"), review: { state: "approved", decided_by: "anna" } });
  });

  it("#17/R21 confirm_supersedes that no longer matches: 409 with a fresh needs_confirmation, nothing saved", async () => {
    classifyResult = () => cls([hit(physio, true)]);
    const n = f.store.memories.length;
    const e = await reject(w.createMemory(anna, { text: "x", confirm: true, confirm_supersedes: dinner.toString() }));
    expect(e).toBeInstanceOf(w.ConfirmMismatch);
    expect(e.payload).toMatchObject({ needs_confirmation: true, old: { memory_id: physio.toString() } });
    expect(f.store.memories.length).toBe(n);
  });

  it("#17 old memory changed before the save: rolled back, re-classified, 409", async () => {
    classifyResult = () => cls([hit(dinner, true)]);
    f.store.memories = f.store.memories.map((m) => ((m._id as ObjectId).equals(dinner) ? { ...m, status: "superseded" } : m));
    const n = f.store.memories.length;
    const e = await reject(w.createMemory(anna, { text: "x", confirm: true, confirm_supersedes: dinner.toString() }));
    expect(e).toBeInstanceOf(w.ConfirmMismatch);
    expect(f.store.memories.length).toBe(n);
    expect(f.store.audit_log.length).toBe(0);
  });

  it("a confirm resend with no conflict left saves verified", async () => {
    const r = await w.createMemory(anna, { text: "x", confirm: true, confirm_supersedes: dinner.toString() });
    expect(r).toMatchObject({ saved: true, status: "verified" });
    expect(byId(dinner).status).toBe("verified");
  });

  it("#21 family may pick caregiver scope; private is 400", async () => {
    expect(await w.createMemory(anna, { text: "x", scope: "caregiver" })).toMatchObject({ scope: "caregiver" });
    await expect(w.createMemory(anna, { text: "x", scope: "private" })).rejects.toMatchObject({ code: "bad_request" });
  });
});

describe("createMemory: caregiver", () => {
  it("#11 saved unverified, pending, flagged, with the proposal the caregiver can read", async () => {
    classifyResult = () => cls([hit(glasses, true)]);
    const r = (await w.createMemory(ravi, { text: "x" })) as import("@/lib/writes").SavedWrite;
    expect(r).toMatchObject({ needs_family_review: true, status: "unverified", scope: "caregiver", from: { name: "Ravi", role: "caregiver" },
      proposed_supersedes: glasses.toString(), message: "This will supersede Reading glasses are on the kitchen windowsill" });
    expect(byId(r.memory_id)).toMatchObject({ flagged: true, review: { state: "pending", proposed_supersedes: glasses } });
    expect(byId(glasses).status).toBe("verified");
  });

  it("#18/R22 a family-scope old memory never reaches the caregiver's response", async () => {
    classifyResult = () => cls([hit(dinner, true), hit(glasses, false, 0.5)]);
    const r = (await w.createMemory(ravi, { text: "x" })) as import("@/lib/writes").SavedWrite;
    expect(r.proposed_supersedes).toBeNull();
    expect(r.message).toBeNull();
    expect(r.candidates.map((c) => c.memory_id)).toEqual([glasses.toString()]);
    expect(JSON.stringify(r)).not.toContain("dinner");
  });

  it("#20/#22 caregiver scope is forced; confirm=true never skips review", async () => {
    classifyResult = () => cls([hit(glasses, true)]);
    const r = await w.createMemory(ravi, { text: "x", scope: "family", confirm: true, confirm_supersedes: glasses.toString() });
    expect(r).toMatchObject({ scope: "caregiver", status: "unverified" });
    expect(byId(glasses).status).toBe("verified");
  });
});

describe("createMemory: failures and batches", () => {
  it("Margaret (person) gets 403 (A16)", async () => {
    await expect(w.createMemory(sess("margaret", "Margaret", "person"), { text: "x" })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("#27 validation errors are 400; Gemini down is 503", async () => {
    validateMock.mockRejectedValueOnce(new ValidationError("bad_request", "text is required"));
    await expect(w.createMemory(anna, { text: "" })).rejects.toMatchObject({ code: "bad_request" });
    validateMock.mockRejectedValueOnce(new ValidationError("unavailable", "down"));
    await expect(w.createMemory(anna, { text: "x" })).rejects.toMatchObject({ code: "unavailable" });
  });

  it("#29 Voyage down: 503, nothing saved", async () => {
    classifyMock.mockRejectedValueOnce(new VoyageError("timeout", "slow"));
    const n = f.store.memories.length;
    await expect(w.createMemory(anna, { text: "x" })).rejects.toMatchObject({ code: "unavailable" });
    expect(f.store.memories.length).toBe(n);
  });

  it("#30 a failed transaction saves nothing", async () => {
    facts = [{ text: "a" }, { text: "b" }];
    f.failNextInsert();
    const n = f.store.memories.length;
    await expect(w.createMemory(anna, { text: "x" })).rejects.toThrow("simulated write failure");
    expect(f.store.memories.length).toBe(n);
    expect(f.store.audit_log.length).toBe(0);
  });

  it("#26/A17 multi-fact, no conflicts: all saved in one batch", async () => {
    facts = [{ text: "Anna visits on Sat Nov 14", event_start: new Date("2026-11-14T05:00:00Z") }, { text: "Leo's birthday is Dec 3" }];
    const r = (await w.createMemory(anna, { text: "x" })) as import("@/lib/writes").BatchResult;
    expect(r).toMatchObject({ batch: true, saved: true });
    expect(r.facts.map((x) => x.text)).toEqual(["Anna visits on Sat Nov 14", "Leo's birthday is Dec 3"]);
    expect(r.facts[0].event_start).toBe("2026-11-14T05:00:00.000Z");
    expect(f.store.memories.length).toBe(5);
  });

  it("A17 multi-fact with a conflict saves nothing; the resend carries the split facts and is not re-split", async () => {
    facts = [{ text: "Dinner moved to 7pm" }, { text: "Leo's birthday is Dec 3" }];
    classifyResult = (t) => (t.startsWith("Dinner") ? cls([hit(dinner, true)]) : cls([]));
    const r = (await w.createMemory(anna, { text: "x" })) as import("@/lib/writes").BatchResult;
    expect(r).toMatchObject({ batch: true, saved: false });
    expect(r.facts[0].result).toMatchObject({ needs_confirmation: true, old: { memory_id: dinner.toString() } });
    expect(r.facts[1].result).toEqual({ saved: false, needs_confirmation: false });
    expect(f.store.memories.length).toBe(3);

    const again = (await w.createMemory(anna, { confirm: true, facts: [
      { text: "Dinner moved to 7pm", confirm_supersedes: dinner.toString() }, { text: "Leo's birthday is Dec 3" },
    ], facts_token: r.facts_token })) as import("@/lib/writes").BatchResult;
    expect(again.saved).toBe(true);
    expect(validateMock).toHaveBeenCalledTimes(1);
    expect(byId(dinner).status).toBe("superseded");
    expect(f.store.memories.length).toBe(5);
  });

  describe("A17 facts[] is only a signed confirm resend", () => {
    const ask = async () => {
      facts = [{ text: "Dinner moved to 7pm", event_start: new Date("2026-11-15T00:00:00Z") }, { text: "Leo's birthday is Dec 3" }];
      classifyResult = (t) => (t.startsWith("Dinner") ? cls([hit(dinner, true)]) : cls([]));
      const r = (await w.createMemory(anna, { text: "x" })) as import("@/lib/writes").BatchResult;
      expect(r.facts_token).toEqual(expect.any(String));
      validateMock.mockClear();
      return r;
    };
    const resend = (r: import("@/lib/writes").BatchResult) => r.facts.map((x, i) => ({
      text: x.text, event_start: x.event_start, event_end: x.event_end, ...(i === 0 && { confirm_supersedes: dinner.toString() }),
    }));
    const rejects = async (input: import("@/lib/writes").MemoryInput) => {
      await expect(w.createMemory(anna, input)).rejects.toMatchObject({ code: "bad_request" });
      expect(validateMock).not.toHaveBeenCalled();
      expect(f.store.memories.length).toBe(3);
    };

    it("first submit with facts[] and no confirm is 400; nothing saved, Gemini not called", async () => {
      validateMock.mockClear();
      await rejects({ facts: [{ text: "Anna visits on Sat Nov 14", event_start: "2030-01-01T00:00:00Z" }] });
    });
    it("confirm: true with facts[] but no token is 400 (can't skip validate by setting confirm)", async () => {
      validateMock.mockClear();
      await rejects({ confirm: true, facts: [{ text: "Anna visits on Sat Nov 14" }] });
    });
    it("a changed event date is 400", async () => {
      const r = await ask();
      const fs = resend(r); fs[0].event_start = "2030-01-01T00:00:00.000Z";
      await rejects({ confirm: true, facts: fs, facts_token: r.facts_token });
    });
    it("an invalid event date is 400", async () => {
      const r = await ask();
      const fs = resend(r); fs[0].event_start = "not a date";
      await rejects({ confirm: true, facts: fs, facts_token: r.facts_token });
    });
    it("changed text, a dropped fact, or text sent with facts is 400", async () => {
      const r = await ask();
      const fs = resend(r);
      await rejects({ confirm: true, facts: [{ ...fs[0], text: "Dinner cancelled" }, fs[1]], facts_token: r.facts_token });
      await rejects({ confirm: true, facts: [fs[0]], facts_token: r.facts_token });
      await rejects({ confirm: true, text: "x", facts: fs, facts_token: r.facts_token });
    });
    it("a tampered token is 400", async () => {
      const r = await ask();
      await rejects({ confirm: true, facts: resend(r), facts_token: r.facts_token?.replace(/^./, (c) => (c === "A" ? "B" : "A")) });
    });
    it("a resend with a different scope is 400 (the token covers scope)", async () => {
      const r = await ask();
      await rejects({ confirm: true, scope: "caregiver", facts: resend(r), facts_token: r.facts_token });
    });
    it("the unchanged resend saves with the dates validate returned", async () => {
      const r = await ask();
      const again = (await w.createMemory(anna, { confirm: true, facts: resend(r), facts_token: r.facts_token })) as import("@/lib/writes").BatchResult;
      expect(again.saved).toBe(true);
      expect(again.facts_token).toBeUndefined();
      expect(again.facts[0].event_start).toBe("2026-11-15T00:00:00.000Z");
      expect(validateMock).not.toHaveBeenCalled();
    });
  });
});

describe("reviewMemory", () => {
  const pending = (proposed: ObjectId | null) => {
    const _id = new ObjectId();
    f.store.memories.push(mem(_id, "Physio is every second Tuesday now", "caregiver", "ravi", {
      status: "unverified", flagged: true, review: { state: "pending", proposed_supersedes: proposed, candidates: [], decided_by: null, decided_at: null },
    }));
    return _id;
  };

  it("confirm with a proposal: new verified, old superseded, audit approve", async () => {
    const id = pending(physio);
    const r = await w.reviewMemory(anna, id.toString(), "confirm");
    expect(r).toMatchObject({ decision: "confirm", new_status: "verified", review_state: "approved", supersedes: physio.toString(), old_status: "superseded", audit_action: "approve", decided_by: "anna" });
    expect(byId(physio).status).toBe("superseded");
  });

  it("A12 David can confirm; no proposal is a plain verify", async () => {
    const r = await w.reviewMemory(david, pending(null).toString(), "confirm");
    expect(r).toMatchObject({ audit_action: "verify", supersedes: null, old_status: null, decided_by: "david" });
  });

  it("deny: retracted, old untouched, audit deny", async () => {
    const r = await w.reviewMemory(anna, pending(physio).toString(), "deny");
    expect(r).toMatchObject({ new_status: "retracted", review_state: "denied", old_status: "verified", audit_action: "deny" });
    expect(byId(physio).status).toBe("verified");
  });

  it("already decided is 409", async () => {
    const id = pending(null);
    await w.reviewMemory(anna, id.toString(), "deny");
    await expect(w.reviewMemory(anna, id.toString(), "confirm")).rejects.toMatchObject({ code: "conflict" });
  });

  it("#16 second confirm after the old memory was replaced: Ben's code verifies it without superseding", async () => {
    const first = pending(physio), second = pending(physio);
    await w.reviewMemory(anna, first.toString(), "confirm");
    const r = await w.reviewMemory(anna, second.toString(), "confirm");
    // Documented behaviour difference: EDGE-CASES #16 recommends 409 here.
    expect(r).toMatchObject({ new_status: "verified", supersedes: null, audit_action: "verify" });
  });

  it("caregivers get 403; bad decision is 400; unknown id is 404", async () => {
    const id = pending(null).toString();
    await expect(w.reviewMemory(ravi, id, "confirm")).rejects.toMatchObject({ code: "forbidden" });
    await expect(w.reviewMemory(ravi, id, "deny")).rejects.toMatchObject({ code: "forbidden" });
    await expect(w.reviewMemory(anna, id, "maybe")).rejects.toMatchObject({ code: "bad_request" });
    await expect(w.reviewMemory(anna, new ObjectId().toString(), "confirm")).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("correctMemory", () => {
  it("asks, then saves verified in the old scope (R20), re-embedded, old superseded", async () => {
    facts = [{ text: "Physio is every second Tuesday now, not every week" }];
    expect(await w.correctMemory(anna, physio.toString(), { text: "x" })).toMatchObject({ needs_confirmation: true, old: { memory_id: physio.toString() } });
    const r = (await w.correctMemory(anna, physio.toString(), { text: "x", confirm: true, confirm_supersedes: physio.toString() })) as import("@/lib/writes").SavedWrite;
    expect(r).toMatchObject({ saved: true, status: "verified", scope: "caregiver", supersedes: physio.toString(), audit_action: "approve", candidates: [] });
    expect(byId(physio).status).toBe("superseded");
    expect(byId(r.memory_id).embedding).toEqual([0.7]);
  });

  it("#24 caregivers get 403", async () => {
    await expect(w.correctMemory(ravi, glasses.toString(), { text: "x" })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("mismatched confirm_supersedes is 409 with a fresh needs_confirmation", async () => {
    const e = await reject(w.correctMemory(anna, physio.toString(), { text: "x", confirm: true, confirm_supersedes: dinner.toString() }));
    expect(e).toBeInstanceOf(w.ConfirmMismatch);
  });

  it("multi-fact correction is 400; Voyage down is 503 and nothing saved", async () => {
    facts = [{ text: "a" }, { text: "b" }];
    await expect(w.correctMemory(anna, physio.toString(), { text: "x" })).rejects.toMatchObject({ code: "bad_request" });
    facts = [{ text: "a" }];
    w.clearValidateCache(); // same text "x" as above, different mocked split
    embedMock.mockRejectedValueOnce(new Error("down"));
    await expect(w.correctMemory(anna, physio.toString(), { text: "x", confirm: true, confirm_supersedes: physio.toString() })).rejects.toMatchObject({ code: "unavailable" });
    expect(byId(physio).status).toBe("verified");
  });
});

describe("listReviews", () => {
  it("family sees pending reviews with the old memory looked up; caregivers get 403", async () => {
    const _id = new ObjectId();
    f.store.memories.push(mem(_id, "Glasses are on the bedside table now", "caregiver", "ravi", {
      status: "unverified", flagged: true, review: { state: "pending", proposed_supersedes: dinner, candidates: [{ memory_id: dinner, supersedes: true, rerank_score: 0.9 }], decided_by: null, decided_at: null },
    }));
    const reviews = await w.listReviews(david);
    expect(reviews[0]).toMatchObject({ id: _id.toString(), from: { name: "Ravi", role: "caregiver" }, message: "This will supersede Anna is bringing dinner on Saturday Nov 14 at 6pm" });
    await expect(w.listReviews(ravi)).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("Voyage failure after validate", () => {
  it("503 saves nothing; the user's retry reuses the validate result (no second Gemini call)", async () => {
    validateMock.mockClear();
    facts = [{ text: "Margaret likes ginger snaps" }];
    classifyMock.mockImplementationOnce(async () => { throw new VoyageError("http", "Voyage embeddings 429: rate limit", 429); });
    await expect(w.createMemory(anna, { text: "Margaret likes ginger snaps" })).rejects.toMatchObject({ code: "unavailable" });
    expect(f.store.memories.length).toBe(3);
    const r = await w.createMemory(anna, { text: "Margaret likes ginger snaps" });
    expect(r).toMatchObject({ saved: true });
    expect(validateMock).toHaveBeenCalledTimes(1);
    // A different note still runs validate.
    await w.createMemory(anna, { text: "Margaret likes tea" });
    expect(validateMock).toHaveBeenCalledTimes(2);
  });
});
