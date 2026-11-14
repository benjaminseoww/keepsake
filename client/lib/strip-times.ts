// Times and dates out of a note, for classify (Q1). rerank-2.5 scores "Anna calls every evening
// around 7" almost as high against "dinner moved to 7pm" as the old dinner memory does, because the
// times dominate. With times and dates replaced by <TIME>/<DATE>, the score is about the topic, and
// a different time or date between the two originals is what makes it a replacement.

const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const WEEKDAY = "(?:mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)day";
const WD_SHORT = "(?:mon|tue|wed|thu|fri|sat|sun)";
const ORD = "(?:st|nd|rd|th)?";

type Rule = { re: RegExp; tag: "<DATE>" | "<TIME>"; key?: (m: string, ...g: string[]) => string };
const R = (src: string) => new RegExp(src, "gi");

// Order matters: longer and more specific patterns first.
const RULES: Rule[] = [
  { re: R(`\\b\\d{4}-\\d{2}-\\d{2}(?:t[\\d:.]+z?)?\\b`), tag: "<DATE>" },
  // "Sun Nov 15", "Saturday, November 14th, 2026", "Nov 12-16", "14 Nov"
  { re: R(`\\b(?:${WEEKDAY}|${WD_SHORT})\\.?,?\\s+${MONTH}\\.?\\s+\\d{1,2}${ORD}(?:\\s*[-–]\\s*\\d{1,2}${ORD})?(?:,?\\s+\\d{4})?\\b`), tag: "<DATE>" },
  { re: R(`\\b${MONTH}\\.?\\s+\\d{1,2}${ORD}(?:\\s*[-–]\\s*\\d{1,2}${ORD})?(?:,?\\s+\\d{4})?\\b`), tag: "<DATE>" },
  { re: R(`\\b\\d{1,2}${ORD}\\s+(?:of\\s+)?${MONTH}\\b(?:,?\\s+\\d{4})?`), tag: "<DATE>" },
  { re: R(`\\b\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?\\b`), tag: "<DATE>" },
  // "every second Tuesday", "next Monday", "on Saturdays", "weekday mornings" stays topic-neutral below
  { re: R(`\\b(?:(?:every|each|next|this|last|on)\\s+)?(?:(?:other|second|third|alternate)\\s+)?${WEEKDAY}s?\\b`), tag: "<DATE>" },
  { re: R(`\\b(?:every|each)\\s+(?:(?:other|second|third)\\s+)?(?:day|week|month|year|weekend)\\b`), tag: "<DATE>" },
  { re: R(`\\b(?:daily|weekly|biweekly|fortnightly|monthly|yearly)\\b`), tag: "<DATE>" },
  { re: R(`\\b(?:next|this|last)\\s+(?:week|month|year|weekend)\\b`), tag: "<DATE>" },
  { re: R(`\\b(?:today|tomorrow|yesterday|tonight)\\b`), tag: "<DATE>" },
  // Times: "7pm", "6:30 p.m.", "18:00", "noon", "in the evening", "every evening", "at 7"
  { re: R(`\\b(\\d{1,2})(?::(\\d{2}))?\\s*([ap])\\.?m\\.?(?![a-z])`), tag: "<TIME>",
    key: (_m, h, min, ap) => hhmm((Number(h) % 12) + (ap.toLowerCase() === "p" ? 12 : 0), min) },
  { re: R(`\\b(\\d{1,2}):(\\d{2})\\b`), tag: "<TIME>", key: (_m, h, min) => hhmm(Number(h), min) },
  { re: R(`\\b(?:noon|midday|midnight)\\b`), tag: "<TIME>" },
  { re: R(`\\b(?:(?:in\\s+the|this|every|each|on)\\s+)?(?:morning|afternoon|evening|night)s?\\b`), tag: "<TIME>" },
  // A bare hour after a time word: "at 7", "around 7", "not 6". Only the number is replaced.
  { re: R(`\\b(at|around|about|by|until|till|from|not|before|after)\\s+(\\d{1,2})\\b(?![:/\\d])`), tag: "<TIME>", key: (_m, _w, h) => `${h}` },
];
const hhmm = (h: number, min?: string) => `${String(h).padStart(2, "0")}:${min ?? "00"}`;

export type Stripped = { text: string; keys: string[] };

// Returns the text with placeholders, and the normalized time/date mentions that were removed.
export function stripTimes(input: string): Stripped {
  let text = input;
  const keys: string[] = [];
  for (const rule of RULES) {
    text = text.replace(rule.re, (...args) => {
      const m = args[0] as string;
      const groups = args.slice(1, -2) as string[];
      keys.push(rule.key ? rule.key(m, ...groups) : m.toLowerCase().replace(/[.,]/g, "").replace(/\s+/g, " ").trim());
      // the bare-hour rule keeps its leading word
      if (rule.key && /^[a-z]/i.test(m)) return `${groups[0]} ${rule.tag}`;
      return rule.tag;
    });
  }
  text = text.replace(/(<(?:DATE|TIME)>)(?:[\s,]+\1)+/g, "$1").replace(/\s+/g, " ").trim();
  return { text, keys: [...new Set(keys)].sort() };
}

// True when the two notes name a different time or date: different removed mentions, or both have
// an event_start and they differ. A note with no time or date of its own never counts.
export function timesDiffer(a: Stripped, b: Stripped, aStart?: Date | null, bStart?: Date | null): boolean {
  if (aStart && bStart && aStart.getTime() !== bStart.getTime()) return true;
  if (!a.keys.length) return false;
  return a.keys.join("|") !== b.keys.join("|");
}
