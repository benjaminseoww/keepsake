# Keepsake memory spec (MVP)

Source of truth for memory behaviour. Decisions are logged in DECISIONS.md, and the work split is in WORKSPLIT.md. Base: main @ 2cdf56c.

## Roles and permissions
Roles come from `households.members` on every request. The JWT is trusted for user_id only.

| Action | person (Margaret) | caregiver | family | family admin |
|---|---|---|---|---|
| Ask the voice agent (recall) | yes | no | no | no |
| Add a memory | no (MVP, A16) | yes, saved unverified | yes | yes |
| Verify / deny / confirm a supersede | no | **no** | yes | yes |
| Correct a memory | no | goes to review | yes | yes |
| View the trace | no | no (MVP, D-A2) | yes | yes |
| Manage household members | no | no | no | **yes** |

- The system decides, for each existing candidate memory, whether the new memory supersedes it (yes or no; A14). People only confirm or deny (D1, D2).
- Readable scopes (A17): Margaret (recall only) and family both read family and caregiver; a caregiver reads caregiver. There is no private scope.

## Memory document
main's schema plus `review`:
`{schema_version:1, person_id, text, scope, status, source:{user_id, name, role}, supersedes, flagged, embedding[1024], created_at, review?:{state: pending|approved|denied, proposed_supersedes, candidates[{memory_id, supersedes: bool, rerank_score}], decided_by, decided_at}}`
- status: unverified | verified | superseded | retracted. Scope: family | caregiver. Recall reads verified only (D-A1). There is no private scope (A17).
- No `kind` field. No `expires_at`. Time-bound facts keep their dates in the text ("Anna is visiting Nov 12-16"). Optional `event_start`/`event_end` are allowed, but recall never filters on them.
- Embeddings: voyage-3.5, 1024 dims, cosine; input_type `document` on write and `query` on recall.

## Recall (demo steps 1-2)
Code: `client/lib/recall.ts`. HTTP contract: `docs/api-reads.yaml`.
1. Embed the question (`input_type` query). If the embed fails, return an empty list (`degraded: embed_error`).
2. `$vectorSearch` on `memory_vec`, pre-filtered by person_id, readable scopes (family and caregiver, A17) and `status: verified`; numCandidates 100, limit 20. Unverified memories never reach the agent until family verifies them (D-A1).
3. rerank-2.5 over the hits with the question as the query; keep the top 5.
4. Drop results below `MIN_RERANK_SCORE` (0.5; env override; calibrated with `client/scripts/calibrate-recall.mts`: in-knowledge 0.646-0.882, out-of-knowledge 0.256-0.371). If none are left, return an empty list.
5. If rerank fails (timeout, 429, 5xx, any error), fall back to vector order with a `MIN_VECTOR_SCORE` floor (0.7; `degraded: rerank_timeout | rerank_error`). Timeouts: 3s embed, 2s rerank, no retries (D-A6).
6. The keyword fallback runs only when `$vectorSearch` throws (index building or missing; `degraded: regex`).
7. Write a `turns` doc, including empty ones (D-A7), and return `{turn_id, memories:[{text, status, added_on, source:{role, name}}]}` (D-A4).

## Turns and trace
`turns: {schema_version:1, person_id, user_id, conversation_id, at, question, results[{memory_id, text, status, scope, author_name, author_role, created_at, vector_score, rerank_score}], top_rerank_score, min_rerank_score, degraded, answer}`. Index `{person_id:1, at:-1}`. Created by `db/migrations/005_turns.js`.
- results is a snapshot at question time. `top_rerank_score` is the best score even if the cutoff dropped it, and `min_rerank_score` is the cutoff in force, so the trace can explain an empty answer.
- `POST /api/turns/:id/answer {answer}`: the voice client posts everything the agent said after that recall, as one string, each time it grows. Only the person who asked can post; anyone else gets 404.
- `GET /api/turns` (newest first) and `GET /api/turns/:id`, family only (D-A2). The trace screen shows the question, the answer, and for each memory who added it, when, its status, its current status and its scores.

## Write and review (demo steps 3-4)
classify(text, person_id): embed as a document, then `$vectorSearch` candidates across all scopes for this person, then rerank-2.5, then decide for each candidate whether the new memory supersedes it (true/false). Return `{proposed_supersedes, candidates:[{memory_id, supersedes, rerank_score}]}`. Candidates are `verified` memories only (R19). proposed_supersedes is the top-ranked candidate with supersedes true, or null. It sits behind one function so the method can change (Q1 research pending; start with a rerank cutoff).

- **Caregiver adds:** the memory is saved unverified with review pending, proposed_supersedes and candidates set, and flagged true. The caregiver's response lists only candidates in the caregiver's readable scopes.
- **One add endpoint (A15):** family and caregiver adds both go through `POST /api/memories`. The author (`source: {user_id, name, role}`) comes from the session and `households.members`, never from the request body (R1). The response and the review card show who added it ("from: Ravi (caregiver)").
- **The person does not add memories in the MVP (A16).** No remember tool. See Next steps in the root README.
- **Family adds or corrects:** if classify proposes a supersede, the response is `{needs_confirmation: true, old:{memory_id, text, author_name, created_at}}`. The UI shows "Are you sure? This will supersede <old>". Resending with `confirm: true` and `confirm_supersedes: <old memory_id>` saves it verified (the server rejects with 409 if classify no longer proposes that id or the old memory is no longer verified; R21), marks the old memory superseded and writes audit approve, all in one transaction. With no supersede, the memory is saved verified.
- **Review queue (family only):** all pending reviews, each with the old memory looked up (text, author, date) so the card can say "This will supersede <old>". Every candidate is visible here (family can read both remaining scopes).
- **Confirm (family):** in one transaction, the new memory becomes verified with review approved and supersedes set; the old one becomes superseded; audit approve. With no proposal, it's a plain verify.
- **Deny (family):** the new memory becomes retracted with review denied; the old one is untouched; audit deny.
- Scope: a correction (`POST /api/memories/:id/corrections`) inherits the old memory's scope; an add uses the scope the writer chose (R20).
- A writer's response never reveals a memory outside their readable scopes: `proposed_supersedes`, `message` and candidates are omitted when the old memory isn't readable by the writer (R22).
- The review queue is `GET /api/reviews` backed by `listReviews(session)` in `client/lib/writes.ts`, which the dashboard may also call directly (R23). Confirm and deny are `POST /api/memories/:id/review {decision}`; forget is `DELETE /api/memories/:id`.
- The write path is REST (D-A9): HTTP routes in `client/app/api/memories/**` and `client/app/api/reviews`, contract in `docs/api-writes.yaml`. The logic lives in `client/lib/writes.ts`, and the dashboard's server actions call the same functions.
- Caregivers calling verify, deny, confirm or correct get 403. A caregiver's correction is saved as a new unverified memory with review pending.
- Multi-document changes use `session.withTransaction`. A memory is never stored with an empty embedding when the embed can run before the insert.

## Voice agent contract (for the ElevenLabs teammate)
- Client tool: `recall {query}` (the client adds `conversation_id`) returns `{turn_id, memories[{text, status, added_on, source:{role, name}}]}`. There is no `remember` tool in the MVP (A16). Full contract: `docs/api-reads.yaml`.
- After the agent answers, call `POST /api/turns/:turn_id/answer` (done in `client/app/talk/voice.tsx`).
- Prompt: `client/lib/prompt.ts`. Today's date (`{{today}}`, America/Toronto, from `/api/talk/session`; D-A5); answer only from recall results; read "today" in a memory against its `added_on`; attribute facts with `source.name`; with no results, say you're not sure and suggest asking family; no medical advice. Family-editable topic guidance is stored in `topic_guidance`, loaded separately on each voice recall, and snapshotted on turns. It controls tone and redirection, never establishes personal facts or overrides safety. Family edits use `saveGuidance` in `lib/writes.ts`; caregivers have no guidance access. See migration 007 and `docs/testing-sensitive-conversations.md`.

## Household members
Only the family admin adds or removes members (not built yet: the old `backend/` `POST /users` was removed when the user service moved into Next.js). That is the admin's only extra power.

## Out of scope

Deferred work is listed once, under Next steps in the root README.
