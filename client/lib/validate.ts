import "server-only";
import type { Session } from "./auth";
import { generateJson, GeminiError } from "./gemini";
import { TZ } from "./time";

// Validation layer (A17, A18). Runs before classify on every add and correct.
// Nothing is embedded or saved until this passes.

export const MAX_TEXT_LENGTH = 500;
export const MAX_FACTS = 10;

export type Fact = { text: string; event_start?: Date; event_end?: Date };
export type Validated = { facts: Fact[]; errors: string[] };

// code maps to the {error:{code,message}} shape: bad_request is 400, unavailable is 503.
export class ValidationError extends Error {
  constructor(public code: "bad_request" | "unavailable", message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

type RawFact = { text?: unknown; event_start?: unknown; event_end?: unknown };

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    facts: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          text: { type: "STRING" },
          event_start: { type: "STRING", description: "ISO 8601 with UTC offset, only when a specific date is clear" },
          event_end: { type: "STRING", description: "ISO 8601 with UTC offset, only for a range or an all-day event" },
        },
        required: ["text"],
        propertyOrdering: ["text", "event_start", "event_end"],
      },
    },
  },
  required: ["facts"],
};

// "Saturday, November 14, 2026, 1:45 PM" plus the current UTC offset, both in America/Toronto.
function todayLine(now: Date) {
  const local = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(now);
  const offset = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" })
    .formatToParts(now).find((p) => p.type === "timeZoneName")?.value.replace("GMT", "") || "+00:00";
  return { local, offset };
}

export function buildPrompt(text: string, now: Date) {
  const { local, offset } = todayLine(now);
  return `You prepare notes for a memory assistant used by a woman with early dementia (Margaret). Family and caregivers write the notes.

Now: ${local}, time zone ${TZ} (UTC offset ${offset}).

Rules:
1. Split the note into separate facts, one per item. If it is one fact, return it unchanged as a single fact.
2. Keep the writer's wording. Do not add, drop or soften information. Do not answer or comment.
3. Replace relative date words with the absolute date, with weekday, month and day: "tomorrow" becomes "on Sun Nov 15", "yesterday" becomes "on Fri Nov 13", "today" becomes "on Sat Nov 14". Remove the relative word. Keep times as written ("at 6pm").
4. A date with no year means its next occurrence on or after today.
5. Set event_start when a specific day is clear. Use ISO 8601 with the ${TZ} offset, e.g. 2026-11-15T18:00:00${offset}. With no time, use 00:00 of that day.
6. Set event_end only for a range (end of the last day, 23:59:59) or a clear end time.
7. Recurring facts ("every Tuesday", "on Tuesdays", "Physio is on Tuesday") get no date fields and keep their wording.
8. Vague dates ("sometime next month", "around Christmas") get no date fields and keep their wording. Never guess a day.
9. Past events ("visited yesterday") still get the absolute date in the text and in event_start.

Note:
"""${text}"""`;
}

function toDate(v: unknown): Date | undefined {
  if (typeof v !== "string" || !v.trim()) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

// Turns Gemini's raw output into facts. Drops empty facts and unparseable dates.
export function normalizeFacts(raw: { facts?: RawFact[] } | null | undefined): Fact[] {
  const facts: Fact[] = [];
  for (const f of raw?.facts ?? []) {
    const text = typeof f.text === "string" ? f.text.trim() : "";
    if (!text) continue;
    const fact: Fact = { text: text.slice(0, MAX_TEXT_LENGTH) };
    const start = toDate(f.event_start);
    const end = toDate(f.event_end);
    if (start) fact.event_start = start;
    if (start && end && end >= start) fact.event_end = end;
    facts.push(fact);
  }
  return facts;
}

// Gemini sometimes gets the year wrong ("yesterday" came back as 2025-11-13 on 2026-11-14).
// If the note has no explicit year and a date is more than ~6 months from today, move it (and its
// end) by whole years to the year nearest today, keeping the Toronto wall-clock time.
const HALF_YEAR_MS = 183 * 24 * 3600_000;
const tzOffsetMs = (d: Date) => {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" }).formatToParts(d)
    .find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) * 60_000 : 0;
};
function shiftYears(d: Date, years: number): Date {
  const out = new Date(d);
  out.setUTCFullYear(out.getUTCFullYear() + years);
  return new Date(out.getTime() + tzOffsetMs(d) - tzOffsetMs(out));
}
export function fixYears(facts: Fact[], note: string, now: Date): Fact[] {
  if (/\b(19|20)\d{2}\b/.test(note)) return facts; // the writer gave a year; trust it
  return facts.map((f) => {
    if (!f.event_start || Math.abs(f.event_start.getTime() - now.getTime()) <= HALF_YEAR_MS) return f;
    const years = Math.round((now.getTime() - f.event_start.getTime()) / (365.25 * 24 * 3600_000));
    const fixed: Fact = { ...f, event_start: shiftYears(f.event_start, years) };
    if (f.event_end) fixed.event_end = shiftYears(f.event_end, years);
    console.warn("validate: moved a date by", years, "year(s); the note gave no year");
    return fixed;
  });
}

// The input checks that need no model.
export function checkText(text: unknown): string {
  if (typeof text !== "string" || !text.trim()) throw new ValidationError("bad_request", "text is required");
  const t = text.trim();
  if (t.length > MAX_TEXT_LENGTH) throw new ValidationError("bad_request", `text is longer than ${MAX_TEXT_LENGTH} characters`);
  return t;
}

export type ValidateDeps = { now?: Date; generate?: typeof generateJson };

// validate(text, session): empty and length checks, then Gemini splits the note into facts
// and resolves dates against today in America/Toronto. session is unused for now; it's
// here so per-household time zones can come from it later.
export async function validate(text: unknown, _session: Session | null, deps: ValidateDeps = {}): Promise<Validated> {
  const t = checkText(text);
  const now = deps.now ?? new Date();
  const generate = deps.generate ?? generateJson;
  let raw: { facts?: RawFact[] };
  try {
    raw = await generate<{ facts?: RawFact[] }>(buildPrompt(t, now), RESPONSE_SCHEMA);
  } catch (e) {
    const kind = e instanceof GeminiError ? e.kind : "unknown";
    console.error("validate: Gemini failed", kind, e instanceof GeminiError ? e.message.slice(0, 40) : "");
    throw new ValidationError("unavailable", "Could not check this note right now. Please try again.");
  }
  const facts = fixYears(normalizeFacts(raw), t, now);
  if (!facts.length) throw new ValidationError("unavailable", "Could not read this note. Please rephrase and try again.");
  if (facts.length > MAX_FACTS) throw new ValidationError("bad_request", `Too many facts in one note (max ${MAX_FACTS})`);
  return { facts, errors: [] };
}

// For a confirm resend: the client sends back the split facts, so nothing is re-split.
// Only the cheap checks run again.
export function revalidateFacts(input: unknown): Fact[] {
  if (!Array.isArray(input) || !input.length) throw new ValidationError("bad_request", "facts must be a non-empty array");
  if (input.length > MAX_FACTS) throw new ValidationError("bad_request", `Too many facts in one note (max ${MAX_FACTS})`);
  return input.map((f: RawFact) => {
    const fact: Fact = { text: checkText(f?.text) };
    const start = toDate(f?.event_start);
    const end = toDate(f?.event_end);
    if (start) fact.event_start = start;
    if (start && end && end >= start) fact.event_end = end;
    return fact;
  });
}
