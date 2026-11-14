// Opt-in live Gemini smoke test for validate(). Needs GEMINI_API_KEY. Prints facts only, never the key.
//   npx tsx --conditions=react-server scripts/smoke-validate.mts
import { validate } from "../lib/validate";
import { GEMINI_MODEL } from "../lib/gemini";

const now = new Date("2026-11-14T13:45:00-05:00");
const only = process.argv.slice(2);
const all = [
  "Leo is coming tomorrow.",
  "Anna is visiting Nov 12-16.",
  "Dinner on Jan 3",
  "Physio is on Tuesday.",
  "Anna is bringing dinner at 7pm today, not 6",
  "Ruth visited yesterday",
  "Leo is visiting sometime next month",
  "Anna visits Saturday and Leo's birthday is Dec 3",
  "   ",
];
const cases = only.length ? only : all;
console.log("model:", GEMINI_MODEL);
for (const c of cases) {
  try {
    const t0 = Date.now();
    const r = await validate(c, null, { now });
    console.log(JSON.stringify({ input: c, ms: Date.now() - t0, facts: r.facts }));
  } catch (e) {
    console.log(JSON.stringify({ input: c, error: (e as Error).name, code: (e as { code?: string }).code, message: (e as Error).message }));
  }
}
