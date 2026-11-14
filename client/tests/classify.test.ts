import { describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import { classify, SUPERSEDE_CUTOFF } from "@/lib/classify";
import { fakeDb } from "./fake-db";

vi.mock("@/lib/db", () => ({ getDb: async () => { throw new Error("no real db in tests"); }, getClient: async () => null }));

const writer = { user_id: "anna", name: "Anna", role: "family" };
const a = new ObjectId(), b = new ObjectId();

describe("classify", () => {
  it("#15/R19/R24: searches verified family+caregiver memories of this person only", async () => {
    const f = fakeDb();
    f.onAggregate(() => []);
    await classify("x", "margaret", writer, { db: f.db, embed: async () => [[0.1]], rerank: async () => [] });
    const vs = f.pipelines[0][0].$vectorSearch as { filter: Record<string, unknown> };
    expect(vs.filter).toEqual({ person_id: "margaret", status: "verified", scope: { $in: ["family", "caregiver"] } });
  });

  it("A14: binary per candidate by the rerank cutoff; proposed is the top-ranked true one", async () => {
    const f = fakeDb();
    f.onAggregate(() => [
      { _id: a, text: "Dinner Sat Nov 14 at 6pm", scope: "family", source: { name: "Anna" }, created_at: new Date() },
      { _id: b, text: "Physio Sat at 10am", scope: "caregiver", source: { name: "Ravi" } },
    ]);
    const r = await classify("Dinner moved to 7pm", "margaret", writer, {
      db: f.db, embed: async () => [[0.1]],
      rerank: async () => [{ index: 0, relevance_score: SUPERSEDE_CUTOFF + 0.05 }, { index: 1, relevance_score: SUPERSEDE_CUTOFF - 0.3 }],
    });
    expect(r.candidates.map((c) => c.supersedes)).toEqual([true, false]);
    expect(r.proposed_supersedes!.equals(a)).toBe(true);
    expect(r.candidates[0].author_name).toBe("Anna");
    expect(r.embedding).toEqual([0.1]);
  });

  it("#12: nothing above the cutoff means no proposal", async () => {
    const f = fakeDb();
    f.onAggregate(() => [{ _id: a, text: "Leo likes chess", scope: "family" }]);
    const r = await classify("Leo also likes soccer", "margaret", writer, {
      db: f.db, embed: async () => [[0]], rerank: async () => [{ index: 0, relevance_score: 0.4 }],
    });
    expect(r.proposed_supersedes).toBeNull();
  });

  it("an optional judge can override the cutoff; a failing judge falls back to the cutoff", async () => {
    const f = fakeDb();
    f.onAggregate(() => [{ _id: a, text: "t", scope: "family" }]);
    const base = { db: f.db, embed: async () => [[0]], rerank: async () => [{ index: 0, relevance_score: 0.99 }] };
    expect((await classify("x", "m", writer, { ...base, judge: async () => [false] })).proposed_supersedes).toBeNull();
    expect((await classify("x", "m", writer, { ...base, judge: async () => { throw new Error("down"); } })).proposed_supersedes!.equals(a)).toBe(true);
  });

  it("#29: a Voyage failure propagates (the write service turns it into 503)", async () => {
    const f = fakeDb();
    await expect(classify("x", "m", writer, { db: f.db, embed: async () => { throw new Error("voyage down"); } })).rejects.toThrow();
  });
});
