import { describe, expect, it, vi } from "vitest";
import { buildPrompt, validate, revalidateFacts, fixYears, MAX_TEXT_LENGTH } from "@/lib/validate";
import { GeminiError } from "@/lib/gemini";

// Gemini is mocked: these test the plumbing around the model (checks, parsing, dates, errors).
// The model's own behaviour is covered by the live smoke script (scripts/smoke-validate.mts).
const now = new Date("2026-11-14T13:45:00-05:00");
const gen = (facts: unknown) => vi.fn(async () => ({ facts }) as never);

describe("validate", () => {
  it("#27 rejects empty, whitespace and over-long text without calling Gemini", async () => {
    const g = gen([]);
    await expect(validate("", null, { now, generate: g })).rejects.toMatchObject({ code: "bad_request" });
    await expect(validate("   \n ", null, { now, generate: g })).rejects.toMatchObject({ code: "bad_request" });
    await expect(validate("x".repeat(MAX_TEXT_LENGTH + 1), null, { now, generate: g })).rejects.toMatchObject({ code: "bad_request" });
    await expect(validate(42, null, { now, generate: g })).rejects.toMatchObject({ code: "bad_request" });
    expect(g).not.toHaveBeenCalled();
  });

  it("passes today's date and America/Toronto in the prompt (#5)", () => {
    const p = buildPrompt("Leo is coming tomorrow.", now);
    expect(p).toContain("Saturday, November 14, 2026");
    expect(p).toContain("America/Toronto");
    expect(p).toContain("-05:00");
  });

  it("#1 keeps the rewritten absolute text and stores event_start as a Date", async () => {
    const r = await validate("Leo is coming tomorrow.", null, {
      now, generate: gen([{ text: "Leo is coming on Sun Nov 15.", event_start: "2026-11-15T00:00:00-05:00" }]),
    });
    expect(r.facts).toHaveLength(1);
    expect(r.facts[0].text).toBe("Leo is coming on Sun Nov 15.");
    expect(r.facts[0].event_start).toBeInstanceOf(Date);
    expect(r.facts[0].event_start!.toISOString()).toBe("2026-11-15T05:00:00.000Z");
  });

  it("#2 a range gets event_start and event_end", async () => {
    const r = await validate("Anna is visiting Nov 12-16.", null, {
      now, generate: gen([{ text: "Anna is visiting Thu Nov 12 - Mon Nov 16", event_start: "2026-11-12T00:00:00-05:00", event_end: "2026-11-16T23:59:59-05:00" }]),
    });
    expect(r.facts[0].event_end!.toISOString()).toBe("2026-11-17T04:59:59.000Z");
  });

  it("#4 and #8: recurring and vague facts have no date fields", async () => {
    const r = await validate("Physio is on Tuesday.", null, { now, generate: gen([{ text: "Physio is on Tuesday." }]) });
    expect(r.facts[0]).toEqual({ text: "Physio is on Tuesday." });
  });

  it("drops dates Gemini got wrong instead of storing garbage, and an end before the start", async () => {
    const r = await validate("x", null, {
      now, generate: gen([{ text: "a", event_start: "not a date" }, { text: "b", event_start: "2026-11-15T00:00:00Z", event_end: "2026-11-14T00:00:00Z" }]),
    });
    expect(r.facts[0].event_start).toBeUndefined();
    expect(r.facts[1].event_start).toBeInstanceOf(Date);
    expect(r.facts[1].event_end).toBeUndefined();
  });

  it("#26 splits a multi-fact note into separate facts", async () => {
    const r = await validate("Anna visits Saturday and Leo's birthday is Dec 3", null, {
      now, generate: gen([{ text: "Anna visits on Sat Nov 14" }, { text: "Leo's birthday is Dec 3" }]),
    });
    expect(r.facts.map((f) => f.text)).toEqual(["Anna visits on Sat Nov 14", "Leo's birthday is Dec 3"]);
  });

  it("a Gemini failure is a clear 'unavailable' error, not a crash", async () => {
    const g = vi.fn(async () => { throw new GeminiError("http", "Gemini 503: high demand"); });
    await expect(validate("Leo is coming tomorrow.", null, { now, generate: g })).rejects.toMatchObject({ code: "unavailable" });
  });

  it("empty Gemini output is 'unavailable'", async () => {
    await expect(validate("hi", null, { now, generate: gen([]) })).rejects.toMatchObject({ code: "unavailable" });
  });

  it("revalidateFacts re-checks resent facts without re-splitting", () => {
    expect(revalidateFacts([{ text: "a", event_start: "2026-11-15T00:00:00Z" }])[0].event_start).toBeInstanceOf(Date);
    expect(() => revalidateFacts([])).toThrow();
    expect(() => revalidateFacts([{ text: " " }])).toThrow();
  });
});

describe("year sanity check (Gemini returned 2025 for 'yesterday')", () => {
  it("moves a date a year off to the nearest year when the note has no year, keeping Toronto time", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await validate("Ruth visited yesterday.", null, { now, generate: gen([{ text: "Ruth visited on Fri Nov 13", event_start: "2025-11-13T00:00:00-05:00" }]) });
    expect(r.facts[0].event_start?.toISOString()).toBe("2026-11-13T05:00:00.000Z");
  });
  it("moves the end with the start", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const [f] = fixYears([{ text: "x", event_start: new Date("2025-11-12T05:00:00Z"), event_end: new Date("2025-11-16T05:00:00Z") }], "Anna is visiting Nov 12-16", now);
    expect([f.event_start?.toISOString(), f.event_end?.toISOString()]).toEqual(["2026-11-12T05:00:00.000Z", "2026-11-16T05:00:00.000Z"]);
  });
  it("keeps the wall-clock time across a DST difference (Nov 3 2027 is EDT, Nov 3 2026 is EST)", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const [f] = fixYears([{ text: "x", event_start: new Date("2027-11-03T22:00:00Z") }], "dinner Nov 3 at 6pm", new Date("2026-11-14T12:00:00-05:00"));
    expect(f.event_start?.toISOString()).toBe("2026-11-03T23:00:00.000Z"); // 6pm EDT stays 6pm EST
  });
  it("leaves dates within 6 months, and any date when the note states a year", () => {
    const near = [{ text: "x", event_start: new Date("2027-01-03T05:00:00Z") }];
    expect(fixYears(near, "recital on Jan 3", now)).toEqual(near);
    const far = [{ text: "x", event_start: new Date("2025-06-01T04:00:00Z") }];
    expect(fixYears(far, "Margaret moved in June 2025", now)).toEqual(far);
  });
});

describe("generateJson retry", () => {
  it("retries a 503 and then succeeds; does not retry a 400", async () => {
    vi.resetModules();
    process.env.GEMINI_API_KEY = "test-key";
    const ok = { candidates: [{ content: { parts: [{ text: '{"facts":[]}' }] } }] };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(ok), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { generateJson } = await import("@/lib/gemini");
    await expect(generateJson("p", {})).resolves.toEqual({ facts: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockReset().mockImplementation(async () => new Response("bad", { status: 400 }));
    await expect(generateJson("p", {})).rejects.toMatchObject({ kind: "http" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockReset().mockImplementation(async () => new Response("busy", { status: 503 }));
    await expect(generateJson("p", {})).rejects.toMatchObject({ kind: "http" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    vi.unstubAllGlobals();
  });
});
