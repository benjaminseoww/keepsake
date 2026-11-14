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

  it("the judge only adds supersedes, never removes one; a failing judge falls back to the cutoff", async () => {
    const f = fakeDb();
    f.onAggregate(() => [{ _id: a, text: "t", scope: "family" }]);
    const base = { db: f.db, embed: async () => [[0]], rerank: async () => [{ index: 0, relevance_score: 0.99 }] };
    expect((await classify("x", "m", writer, { ...base, judge: async () => [false] })).proposed_supersedes!.equals(a)).toBe(true);
    expect((await classify("x", "m", writer, { ...base, judge: async () => { throw new Error("down"); } })).proposed_supersedes!.equals(a)).toBe(true);
  });

  it("the judge catches a contradiction below the cutoff, and skips candidates under JUDGE_MIN", async () => {
    const f = fakeDb();
    f.onAggregate(() => [{ _id: a, text: "Margaret has two grandchildren, Leo and Maya", scope: "family" }, { _id: b, text: "Anna calls every evening around 7", scope: "family" }]);
    const seen: string[][] = [];
    const r = await classify("Margaret has no grandkids", "m", writer, {
      db: f.db, embed: async () => [[0]], rerank: async () => [{ index: 0, relevance_score: 0.648 }, { index: 1, relevance_score: 0.249 }],
      judge: async (_t, c) => { seen.push(c.map((x) => x.text)); return c.map(() => true); },
    });
    expect(r.proposed_supersedes!.equals(a)).toBe(true);
    expect(seen).toEqual([["Margaret has two grandchildren, Leo and Maya"]]);
    expect(r.candidates[1].supersedes).toBe(false);
  });

  describe("time-stripped check", () => {
    const docs = [
      { _id: a, text: "Anna is bringing dinner on Saturday Nov 14 at 6pm", scope: "family" },
      { _id: b, text: "Anna calls every evening around 7", scope: "family" },
    ];
    // Plain scores like Ben's measurements: neither clears the 0.8 cutoff.
    const plain = [{ index: 0, relevance_score: 0.569 }, { index: 1, relevance_score: 0.548 }];
    const run = async (stripped: { index: number; relevance_score: number }[], opts = {}) => {
      const f = fakeDb();
      f.onAggregate(() => docs);
      const queries: string[] = [];
      const rerank = vi.fn(async (q: string, d: string[]) => { queries.push(q, ...d); return queries.length === d.length + 1 ? plain : stripped; });
      const r = await classify("Anna is bringing dinner at 7pm on Sat Nov 14, not 6", "m", writer, { db: f.db, embed: async () => [[0]], rerank, stripped_cutoff: 0.85, ...opts });
      return { r, rerank, queries };
    };
    it("reranks the stripped texts; a high stripped score with a different time supersedes", async () => {
      const { r, rerank, queries } = await run([{ index: 0, relevance_score: 0.93 }, { index: 1, relevance_score: 0.4 }]);
      expect(rerank).toHaveBeenCalledTimes(2);
      expect(queries).toContain("Anna is bringing dinner at <TIME> on <DATE>, not <TIME>");
      expect(queries).toContain("Anna calls <TIME> around <TIME>");
      expect(r.candidates.map((c) => c.supersedes)).toEqual([true, false]);
      expect(r.candidates.map((c) => c.stripped_score)).toEqual([0.93, 0.4]);
      expect(r.proposed_supersedes!.equals(a)).toBe(true);
    });
    it("a low stripped score doesn't supersede; the plain cutoff stays as the fallback", async () => {
      const { r } = await run([{ index: 0, relevance_score: 0.6 }, { index: 1, relevance_score: 0.5 }]);
      expect(r.proposed_supersedes).toBeNull();
    });
    it("a stripped rerank failure falls back to the plain cutoff instead of failing the write", async () => {
      const f = fakeDb();
      f.onAggregate(() => docs);
      let n = 0;
      vi.spyOn(console, "error").mockImplementation(() => {});
      const r = await classify("Dinner moved to 7pm", "m", writer, { db: f.db, embed: async () => [[0]], stripped_cutoff: 0.85,
        rerank: async () => { if (n++) throw new Error("down"); return [{ index: 0, relevance_score: 0.9 }]; } });
      expect(r.proposed_supersedes!.equals(a)).toBe(true);
    });
    it("skips the extra call when the new note has no time or date, or the check is off", async () => {
      const f = fakeDb();
      f.onAggregate(() => docs);
      const rerank = vi.fn(async () => plain);
      await classify("Margaret likes ginger snaps", "m", writer, { db: f.db, embed: async () => [[0]], rerank, stripped_cutoff: 0.85 });
      expect(rerank).toHaveBeenCalledTimes(1);
      const off = await run([{ index: 0, relevance_score: 0.99 }, { index: 1, relevance_score: 0.99 }], { stripped_cutoff: null });
      expect(off.rerank).toHaveBeenCalledTimes(1);
      expect(off.r.proposed_supersedes).toBeNull();
    });
  });

  it("#29: a Voyage failure propagates (the write service turns it into 503)", async () => {
    const f = fakeDb();
    await expect(classify("x", "m", writer, { db: f.db, embed: async () => { throw new Error("voyage down"); } })).rejects.toThrow();
  });
});
