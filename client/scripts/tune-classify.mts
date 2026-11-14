// Prints real rerank-2.5 scores for the demo supersede pairs, plain and time-stripped, and the
// STRIPPED_CUTOFF range that separates them. No DB, no writes; Voyage only. Never prints the key.
// Run from client/: npx tsx --env-file=../.env scripts/tune-classify.mts
// Voyage's free tier is 3 requests/min; this makes 2 per query (8 total). Set TUNE_DELAY_MS=21000 there.
import { rerank } from "../lib/voyage";
import { stripTimes, timesDiffer } from "../lib/strip-times";

const DINNER_OLD = "Anna is bringing dinner on Saturday Nov 14 at 6pm";
const CALLS = "Anna calls every evening around 7";
const PHYSIO_OLD = "Physio visit is every Tuesday at 2pm";
const RAVI = "Ravi visits on weekday mornings at 10";
const LEO_OLD = "Leo is coming on Sun Nov 15 at 6pm";

// want: true = must supersede, false = must not.
const CASES: { query: string; docs: { text: string; want: boolean }[] }[] = [
  { query: "Leo now coming tomorrow at 7pm, not 6pm", docs: [{ text: LEO_OLD, want: true }, { text: CALLS, want: false }, { text: DINNER_OLD, want: false }] },
  { query: "Physio is every second Tuesday now, not every week", docs: [{ text: PHYSIO_OLD, want: true }, { text: RAVI, want: false }] },
  // The dinner change as typed, and as validate rewrites it.
  { query: "Anna is bringing dinner at 7pm today, not 6", docs: [{ text: DINNER_OLD, want: true }, { text: CALLS, want: false }] },
  { query: "Anna is bringing dinner at 7pm on Sat Nov 14, not 6", docs: [{ text: DINNER_OLD, want: true }, { text: CALLS, want: false }, { text: LEO_OLD, want: false }] },
];

const delay = Number(process.env.TUNE_DELAY_MS ?? 0);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let calls = 0;
async function score(q: string, docs: string[]): Promise<number[]> {
  if (calls++ && delay) await sleep(delay);
  const r = await rerank(q, docs, docs.length, 10_000);
  const out = docs.map(() => NaN);
  for (const x of r) out[x.index] = x.relevance_score;
  return out;
}

const rows: { want: boolean; plain: number; stripped: number; differs: boolean }[] = [];
for (const c of CASES) {
  const q = stripTimes(c.query);
  const ds = c.docs.map((d) => stripTimes(d.text));
  const plain = await score(c.query, c.docs.map((d) => d.text));
  const stripped = await score(q.text, ds.map((d) => d.text));
  console.log(`\nQUERY   ${c.query}\nSTRIPPED ${q.text}`);
  c.docs.forEach((d, i) => {
    const differs = timesDiffer(q, ds[i]);
    rows.push({ want: d.want, plain: plain[i], stripped: stripped[i], differs });
    console.log(`  ${d.want ? "MUST    " : "MUST NOT"} plain ${plain[i].toFixed(3)}  stripped ${stripped[i].toFixed(3)}  times differ ${differs ? "yes" : "no "}  ${d.text}  ->  ${ds[i].text}`);
  });
}

const range = (key: "plain" | "stripped", usesDiffer: boolean) => {
  const yes = rows.filter((r) => r.want).map((r) => r[key]);
  const no = rows.filter((r) => !r.want && (!usesDiffer || r.differs)).map((r) => r[key]);
  const lo = Math.max(...no), hi = Math.min(...yes);
  return hi > lo ? `separable: any cutoff in (${lo.toFixed(3)}, ${hi.toFixed(3)}], e.g. ${((lo + hi) / 2).toFixed(3)}` : `not separable (highest must-not ${lo.toFixed(3)} >= lowest must ${hi.toFixed(3)})`;
};
console.log(`\nSUPERSEDE_CUTOFF (plain):           ${range("plain", false)}`);
console.log(`STRIPPED_CUTOFF (with times differ): ${range("stripped", true)}`);
console.log(`Every must-supersede pair has times differ: ${rows.filter((r) => r.want).every((r) => r.differs) ? "yes" : "NO"}`);
