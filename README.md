# Keepsake

Family-governed memory for a person with early dementia.

## Problem

Built for the **Memory You Can Govern** track at [Agents in Context Toronto](https://cerebralvalley.ai/e/mongodb-toronto-hackathon) (MongoDB, 14 Nov 2026).

The official public event page does not publish the named track briefs. This is the track text as the team copied it from the event [details](https://cerebralvalley.ai/e/mongodb-toronto-hackathon/details) page:

> What an agent remembers is data someone has to answer for. Build an agent using MongoDB Atlas and Vector Search to persist and retrieve memory, so that memory changes what it does on the next run, with rules for who can read each memory, how long it lives, and how it gets corrected or forgotten.
>
> How do you keep one client's or team's memory from leaking into another's?
> How does the agent fix or drop a memory that turns out wrong or expired?
> How do you prove a memory changed the agent's behavior and didn't just fill the prompt?

Keepsake answers that with a voice agent whose memory family can verify, correct, scope and supersede. Every vector search is pre-filtered by person and by the caller's role. Recall uses verified memories only, so a correction changes the next answer. The brief also asked about expiry; the MVP does not expire memories.

For a 3-minute talk, walk this page in order: Problem, Flow 1, Flow 2, Governance. Diagrams: [docs/architecture.md](docs/architecture.md). Write-path demo script: [docs/demo.md](docs/demo.md).

## What it does

A person talks to the agent by voice (ElevenLabs). The agent answers only from memories family has verified.

Family add, correct, verify, deny and forget memories. A caregiver can add a note; it stays unverified until family review. The caregiver briefing and "Ask about" box see only caregiver-scope memories.

Demo household (invented): Margaret (person), Anna (family, admin), David (family), Ravi (caregiver). The app is not hardcoded to those names.

## Flow 1: write

Family or a caregiver adds a note (`POST /api/memories`, or a correction).

1. Gemini (`gemini-3.5-flash-lite`) splits the note into facts and resolves dates (`America/Toronto`). A date more than about six months out, when the note gave no year, is moved to the nearer year.
2. Each fact is embedded with Voyage `voyage-3.5` (`input_type: document`).
3. Atlas `$vectorSearch` on `memory_vec` (`numCandidates` 100, `limit` 20), filtered to that person, `status: verified`, scope `family` or `caregiver`.
4. Voyage `rerank-2.5` keeps the top 10. Rerank scores **relevance to the new note**, not contradiction.
5. A candidate is proposed as a supersede if:
   - the plain rerank score is at least **0.8**, or
   - a time-stripped rerank (times and dates replaced by placeholders) scores at least **0.55** and the time or date differs, or
   - the Gemini judge marks it as a replacement or contradiction. On `main` the judge is on by default (`CLASSIFY_GEMINI=0` turns it off). It only looks at candidates scoring at least **0.5** that the rules did not already mark, and it can only add a supersede, never remove one.

Family: a proposed supersede returns 200 and saves nothing until they confirm. Caregiver: the note is always saved `unverified` with review pending. Family then confirm or deny.

**Rerank example.** "Leo is now coming tomorrow at 7pm, not 6pm" vs the 6pm Leo visit scored 0.785 plain and 0.818 with times stripped, so the time-stripped rule catches the reschedule. "Margaret has no grandkids" vs "Margaret has two grandchildren, Leo and Maya" scored 0.648: related, but under 0.8, so the judge is what flags the contradiction. "Anna calls every evening around 7" scored 0.249 against that grandkids memory and stays out.

A later change on `fix/classify-contradiction` (`ce2e0f8`, not on `main` yet) lowers the judge floor to 0.4 and counts implied contradictions, such as "has no kids" vs "has two grandchildren".

## Flow 2: read

The person asks by voice. ElevenLabs calls the client's `recall` tool, which posts `POST /api/recall`. The caregiver "Ask about" box uses the same route.

1. Embed the question with `voyage-3.5` (`input_type: query`).
2. `$vectorSearch` on `memory_vec` (`numCandidates` 100, `limit` 20), filtered to that person, `status: verified` only, and the scopes the caller's role may see.
3. `rerank-2.5` keeps the top 5, then drops hits below **0.5**.
4. Those memories are returned and written to `turns`. The voice agent answers only from that list. If nothing passes, it says it is not sure and suggests asking family.

If rerank fails, recall falls back to vector order (floor 0.7). If the vector index is missing, it falls back to a keyword find. An embed failure returns no memories.

## Governance

| Role | Read | Write |
|---|---|---|
| Person | Verified `family` and `caregiver`, via the voice agent only | None in the MVP |
| Family | `family` and `caregiver` | Add (saved verified, or after confirm if it would replace one), correct, verify, deny, forget, see `/trace` |
| Caregiver | `caregiver` only | Add a note (always unverified, always caregiver scope, waiting for family) |

There is no `private` scope. The login cookie is trusted for `user_id` only. Name, role and household are re-read from `households.members` on every request.

A superseded memory drops out of recall because search is verified-only. Forget deletes the memory. Each reply logs the memory ids it used (`turns`); family can open `/trace`.

Expiry is not built (decision A10). Time-bound facts keep their dates in the text, with optional `event_start` / `event_end` that recall does not filter on.

## Stack

- MongoDB Atlas and Atlas Vector Search (`memory_vec`: 1024 dims, cosine, filters on `person_id`, `scope`, `status`)
- Voyage AI: `voyage-3.5` embeddings, `rerank-2.5`
- Google Gemini: `gemini-3.5-flash-lite` (validate, caregiver ask, classify judge)
- ElevenLabs Conversational AI (voice)
- LangSmith (optional traces and recall evals)
- One Next.js app (`client/`): UI, login, and all API routes. The old Fastify user service is gone.

Accounts live in `people`; roles live in `households`. See [docs/architecture.md](docs/architecture.md).

## Run locally

```bash
cd client
cp .env.example .env   # fill in keys; never commit .env
npm install
node --env-file=.env scripts/setup-vectors.mjs   # vector index + missing embeddings
npm run dev
```

Database setup is in [db/README.md](db/README.md). Root `.env.example` has the keys the db scripts need (`MONGODB_URI`, `MONGODB_DB`, `VOYAGE_API_KEY`, `AUTH_SECRET`, `GEMINI_API_KEY`). Use `client/.env` for the app (those plus ElevenLabs and optional LangSmith).

Demo logins, after seed: `anna@keepsake.test` (family, admin), `ravi@keepsake.test` (caregiver), `margaret@keepsake.test` (person). Password: `keepsake`.

### ElevenLabs (one time)

The prompt and first message live in `client/lib/prompt.ts` and are sent as session overrides. In the ElevenLabs dashboard:

1. API key with the ElevenLabs Agents permission set to write (`convai_write`), in `ELEVENLABS_API_KEY`. Without it the app can only connect to a public agent.
2. Agent → Security → Overrides: enable System prompt and First message.
3. Agent → Tools → Add tool → Client, with Wait for response on and a 10s timeout:
   - `recall`: look up what Keepsake knows. Parameter `query` (string, required). The browser posts `POST /api/recall`.

`recall` is the only tool. The person does not add memories by voice in the MVP (A16). `{{name}}` and `{{today}}` are filled from the signed-in user at session start.

### LangSmith (optional)

Set `LANGSMITH_TRACING=true`, `LANGSMITH_API_KEY`, and optionally `LANGSMITH_PROJECT` (default `keepsake`) in `client/.env`.

- Traces (`client/lib/tracing.ts`). Every `POST /api/recall` writes a `recall` run (question, vector and rerank scores, cutoff). The spoken or written answer is traced from `POST /api/turns/:id/answer` once the text has settled. Tagged `voice` or `caregiver`/`family`, plus `no-memories` or `degraded:*` when search is empty or Voyage fails. Traces send memory text to LangSmith; that is fine for the demo data.
- Evals (`client/scripts/eval-recall.mts`) run `tests/scenarios/read_path.json` and record a LangSmith experiment. On Voyage's free tier, use a delay: `EVAL_DELAY_MS=40000 npx tsx --env-file=$PWD/.env scripts/eval-recall.mts`.

## Next steps

Deferred from the MVP. One list; do not add more copies in other docs.

- Merge `fix/classify-contradiction` (`ce2e0f8`): judge floor 0.4, and implied contradictions such as "has no kids" vs "has two grandchildren".
- Leakage test: a second household; queries for one person must return none of the other's memory ids.
- Voice `remember` tool (`POST /api/talk/remember` was removed). The person cannot add memories in the MVP (A16).
- Family admin add/remove household members. The old user-service `POST /users` was dropped and has not been rebuilt in Next.js.
- Unverified memories expire if family do not verify them (the brief asked about expiry; A10 left it out).
- Change streams on `memories`: audit log and live flags in the family view, no refresh.
- Hybrid search: Atlas Search on `text`, merged with vector via `$rankFusion` if the cluster version allows it. Helps exact names.
- Replay: run the same questions before and after a correction, and compare replies and cited ids. An LLM judge on that pair is extra; cited id diff is the proof.
- Time-series `turns` and a retention rule (no TTL on turns today).
- Caregiver trace access: show a caregiver a turn only when every result is caregiver scope (D-A2).
- A `timezone` on households, used by `client/lib/time.ts` instead of `America/Toronto` (D-A5).
- Optional `kind` on memories (routine, event, fact, preference), if the prompt or UI needs it.
- Related / unrelated labels on classify candidates. The system only decides supersede true or false (A14).
- Remove unused `@langchain/core` and `@langchain/mongodb` from `client/package.json`.
