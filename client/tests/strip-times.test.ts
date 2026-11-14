import { describe, expect, it } from "vitest";
import { stripTimes, timesDiffer } from "@/lib/strip-times";

const s = (t: string) => stripTimes(t).text;

describe("stripTimes", () => {
  it("replaces clock times, bare hours after a time word, and parts of the day", () => {
    expect(s("Leo now coming tomorrow at 7pm, not 6pm")).toBe("Leo now coming <DATE> at <TIME>, not <TIME>");
    expect(s("Anna is bringing dinner at 7pm today, not 6")).toBe("Anna is bringing dinner at <TIME> <DATE>, not <TIME>");
    expect(s("Anna calls every evening around 7")).toBe("Anna calls <TIME> around <TIME>");
    expect(s("Meet at 6:30 p.m. or 18:00")).toBe("Meet at <TIME> or <TIME>");
    expect(s("Lunch at noon")).toBe("Lunch at <TIME>");
  });
  it("replaces dates, weekday names, recurrences and relative day words", () => {
    expect(s("Anna is bringing dinner on Saturday Nov 14 at 6pm")).toBe("Anna is bringing dinner on <DATE> at <TIME>");
    expect(s("Leo is coming on Sun Nov 15 at 6pm")).toBe("Leo is coming on <DATE> at <TIME>");
    expect(s("Physio visit is every Tuesday at 2pm")).toBe("Physio visit is <DATE> at <TIME>");
    expect(s("Physio is every second Tuesday now, not every week")).toBe("Physio is <DATE> now, not <DATE>");
    expect(s("Anna is visiting Nov 12-16")).toBe("Anna is visiting <DATE>");
    expect(s("Due 2026-11-20 or 11/20")).toBe("Due <DATE> or <DATE>");
    expect(s("Ruth visited yesterday")).toBe("Ruth visited <DATE>");
    expect(s("Leo visits next week")).toBe("Leo visits <DATE>");
  });
  it("leaves notes without times alone, and doesn't eat ordinary words", () => {
    expect(stripTimes("Margaret's favourite biscuits are ginger snaps")).toEqual({ text: "Margaret's favourite biscuits are ginger snaps", keys: [] });
    expect(s("The sun is out; may I have tea at 3pm?")).toBe("The sun is out; may I have tea at <TIME>?");
  });
  it("normalizes times so 7pm, 7 p.m. and 19:00 are the same", () => {
    expect(stripTimes("at 7pm").keys).toEqual(stripTimes("at 19:00").keys);
    expect(stripTimes("at 7 p.m.").keys).toEqual(["19:00"]);
  });
});

describe("timesDiffer", () => {
  const d = (a: string, b: string) => timesDiffer(stripTimes(a), stripTimes(b));
  it("true for a changed time or date", () => {
    expect(d("Leo now coming tomorrow at 7pm, not 6pm", "Leo is coming tomorrow at 6pm")).toBe(true);
    expect(d("Physio is every second Tuesday now, not every week", "Physio visit is every Tuesday at 2pm")).toBe(true);
  });
  it("false for the same time (a near-duplicate is left to the plain cutoff), or a new note with no time", () => {
    expect(d("Leo is coming tomorrow at 6pm", "Leo comes tomorrow at 6 p.m.")).toBe(false);
    expect(d("Leo likes chess", "Leo is coming tomorrow at 6pm")).toBe(false);
  });
  it("true when both have an event_start and they differ", () => {
    const a = stripTimes("Leo is coming"), b = stripTimes("Leo is coming");
    expect(timesDiffer(a, b, new Date("2026-11-15T23:00:00Z"), new Date("2026-11-16T00:00:00Z"))).toBe(true);
  });
});
