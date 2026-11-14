# Keepsake decision log

Current decisions, grouped by topic. Each item is what holds now. IDs in brackets are the original ones. Superseded items are at the end.

## Data model

- [R1] Every insert writes `schema_version: 1`. Memories use main's model plus a `review` subdoc and a `retracted` status.
- [A15] The author is stored as `source: {user_id, name, role}`, resolved from the session and `households.members`, never from the request body.
- [D4] Memories have no `kind` field.
- [A10] No expiry: do not write `expires_at`, and do not use a TTL index. Time-bound facts keep their dates in the text (for example "Anna is visiting Nov 12-16"). Optional `event_start` / `event_end` are allowed, but recall never filters on them.
- Status is one of `unverified`, `verified`, `superseded`, `retracted`. Scope is one of `private`, `family`, `caregiver`.
- [R11] `review.state: pending` is the review queue's source of truth; `flagged` is a UI hint only.
- [A14] Each review candidate is `{memory_id, supersedes: bool, rerank_score}`. `proposed_supersedes` is the top-ranked candidate with `supersedes: true`, or null.
- [R6] `turns` is `{schema_version, person_id, user_id, conversation_id, at, question, results[{memory_id, text, status, scope, author_name, author_role, created_at, vector_score, rerank_score}], answer}`, indexed `{person_id: 1, at: -1}`. Time-series turns stay in NEXT_STEPS.
- [R10] Audit actions: `write` on create; `approve` or `deny` on a review decision; `verify` when confirm has no proposed supersede. `audit_log` includes `person_id` and is indexed `{person_id: 1, at: -1}`.
- [R12] Embeddings are voyage-3.5, 1024 dims, cosine; `input_type` is `document` on write and `query` on recall. The Python seed stays as dev tooling, with this config in one documented constant set.
- [R7] Never store an empty embedding when the embed can run before the insert, and never copy `key` or `review` onto a new doc. Do not port `queries.js` `correct()` or `retrieveFallback()` as they are.

## Roles and permissions

- [R1] The JWT is trusted for `user_id` only. `person_id`, `role` and `admin` are resolved from `households.members` on every request.
- Readable scopes: the person reads `private`, `family` and `caregiver`; family reads `family` and `caregiver`; a caregiver reads `caregiver`.
- [R22] A writer's response never includes `proposed_supersedes`, `message`, or candidates for a memory outside that writer's readable scopes.
- [A12] Any family member (role `family`, including the admin) can verify, deny, confirm a supersede, and correct. Caregivers cannot; their writes stay unverified until a family member reviews them.
- [A13] The admin's only extra power is managing household members (`POST /users` in `backend/`, already `requireFamilyAdmin`).
- [D2] People never classify; they only confirm or deny. The system classifies.
- [A2] `correct` stays as an endpoint: a family member creates a new re-embedded memory that supersedes the old one; a caregiver correction goes through the normal unverified + review path.
- [A15] The `addMemory` response and each review card show the author as `from: {name, role}` (for example "from: Ravi (caregiver)").
- [A16] Margaret does not add memories in the MVP. The seed no longer includes memories she authored (`ring_private`, `ruth_unverified`, `maple_unverified`).

## Read path

- [R5] Recall includes unverified memories and tags each result with its status.
- [R16, A7] Recall is `$vectorSearch` (pre-filtered by `person_id`, readable scopes, and status in `[verified, unverified]`; `numCandidates` 100, limit 20), then rerank-2.5 (keep the top 5), then drop hits below `MIN_RERANK_SCORE` (a config constant, calibrated on the seed so out-of-knowledge questions return nothing). If none remain, return an empty list. Use vector order only if the Voyage call fails. The regex fallback runs only while the vector index is building.
- [R6, R17] Every recall writes a `turns` doc and returns `turn_id`. The client posts the spoken answer to `POST /api/turns/:id/answer`.
- [A5] The trace (`GET /api/turns`, newest first, and `GET /api/turns/:id`) shows the question, the answer, and for each memory who added it, when, its status and its scores.
- [D5, A11, R13] The agent prompt is hardcoded and includes today's date, the husband rule, "you mentioned" for unverified memories, no medical advice, and topic guidance written inline. Answer only from recall results; with none, say you are not sure and suggest asking family. Do not read the `topic_guidance` collection.

## Write path

- [A15] There is one add endpoint, `addMemory`, for every writer (family and caregiver). The person cannot add a memory in the MVP ([A16]).
- [R15] A caregiver add runs classify and saves the memory as `unverified` with `review.state: pending`, `flagged: true`, and an audit `write`.
- Family writes with no proposed supersede are saved `verified` immediately.
- [A6, A12] When a family member writes or corrects a fact that would supersede another, the API returns `{needs_confirmation: true, old:{memory_id, text, author_name, created_at}}` and saves nothing. The UI shows "Are you sure? This will supersede <old>".
- [R21] A confirm resend carries `confirm: true` and `confirm_supersedes` set to the old `memory_id` that was shown. The server saves only if classify still proposes that id (for `correct`, the target is that id) and the old memory is still `verified`; otherwise it returns 409 with a fresh needs-confirmation payload, and nothing is saved. On a match, the new memory is saved `verified`, the old one is marked `superseded`, and audit `approve` is written, in one transaction.
- [R20] `correct` inherits the old memory's scope; `addMemory` uses the scope the writer chose (caregiver writes are always `caregiver`).
- [A3] The writer's response lists only candidates in that writer's readable scopes ([R22]). The family review queue shows every candidate the family may read, including ones the original writer could not see.
- [R23] The review queue is `GET /api/reviews`, backed by `listReviews(session)` in `client/lib`, which `page.tsx` may also call directly. It returns every memory with `review.state: pending`, each with the proposed old memory looked up (text, author, date) so the card can say "This will supersede <old>". Family only; caregivers get 403.
- [R3] Confirm and deny run in one `session.withTransaction`. Confirm: the new memory becomes `verified`, `review.state` `approved`, `supersedes` set; the old memory becomes `superseded`; audit `approve`. With no proposal, it is a plain verify (audit `verify`). Deny: the new memory becomes `retracted`, `review.state` `denied`; the old memory is untouched; audit `deny`. `verifyMemory` still supersedes a proposed old memory even if the confirmer cannot read it.

## Classification

- [A14] Classification is binary: the new memory either supersedes a candidate or it does not. `classify` returns `{proposed_supersedes, candidates[{memory_id, supersedes: bool, rerank_score}]}`.
- [R19] Classify candidates are `verified` memories only.
- [R24] Classify excludes `private`-scope memories unless the writer is the person, so Margaret's private memories never surface in a family or caregiver review.
- [A1] The method follows MongoDB and Voyage best practices. Until Q1 is closed, keep a rerank-2.5 cutoff behind one `classify` function so the method can be swapped.

## Voice and agent

- Product: a voice agent for Margaret (early dementia). Family can verify, correct and scope her memories.
- Demo: Margaret asks a question in the knowledge base and the voice answers; "How did it know this?" opens a trace of the question, the answer and each memory (who added it, when, status, scores); a caregiver adds a fact; the system finds conflicts (vector search + rerank-2.5, binary supersede); any family member sees "this memory will supersede the old one <old>" and confirms or denies.
- [A4] Margaret speaks to the bot and hears the answer (voice in and out through ElevenLabs).
- [A8, A16] The interface to the ElevenLabs teammate is `recall {query}`, which returns `{turn_id, memories[{text, status}]}`. There is no `remember` tool in the MVP. After the agent answers, call `POST /api/turns/:turn_id/answer`.

## Process

- Event: MongoDB "Agents in Context" Toronto hackathon, Memory You Can Govern track. Submissions due Nov 14 2026, 5 pm ET. Required: ElevenLabs, the provisioned MongoDB Atlas cluster, a 1-minute demo video. Banned: Streamlit, dashboard as the main feature, medical advice, basic RAG.
- Source of truth: `main` at 2cdf56c (REVIEW-002). Behaviour is specified in `SPEC-memory.md`; this file logs the decisions; the work split is in `WORKSPLIT.md`.
- [A9] All memory logic lives in the Next.js client (`client/lib`, `/api` routes, dashboard actions). There is no separate memory-service.
- Stack: MongoDB Atlas + Atlas Vector Search; Voyage AI (voyage-3.5, rerank-2.5); ElevenLabs; the user service in `backend/` is Node/TypeScript (Fastify).
- [A8] Mica owns the project spec. The ElevenLabs integration is built by another teammate from the spec, so the tool contract above must stay complete and standalone.
- [R9] Scenario tests run against `MONGODB_DB=keepsake_test` with its own `memory_vec` index, never the demo DB. `seed.py` upserts demo logins into `people`.
- [D3] The MVP has no leakage test.
- [D6] Deferred items go in `docs/NEXT_STEPS.md` (see also the "Out of scope" section of `SPEC-memory.md`): Margaret's `remember` tool ([A16]), leakage test, `kind`, live push notifications, an LLM classifier if Q1 lands on rerank-only, related/unrelated labels, time-series turns.
- [D7] Follow MongoDB best practices.

## Open questions

- [Q1] How should `classify` decide `supersedes` true or false for each candidate: an LLM (which provider and model?) on top of rerank-2.5, or rerank-2.5 alone with cutoff scores? This is the remaining blocker for the classifier. Until it is answered, use a rerank cutoff behind one function ([A1]).

## Superseded

- [D1] The system classified each candidate as supersedes / related / unrelated. Replaced by [A14].
- [D2] "The admin only grants or denies permission to override." The admin-only part was replaced by [A12]. People still never classify.
- [R8] Expiry used a TTL index plus a `$match` on `expires_at` after `$vectorSearch`. Replaced by [A10].
- [R3] The clauses "if the old memory is gone (TTL), treat as plain verify" and "the new memory inherits the old memory's `expires_at`" were dropped with [A10]. The confirm/deny state changes in [R3] still stand.
- [R14] Temporary defaults: admin-only confirm/deny, no direct `correct` in the MVP, candidate search limited to the writer's readable scopes, and the admin's own superseding writes stay pending. Replaced by [A2], [A3], [A6] and [A12].
- [R18] Verify/deny required `admin: true` from `households.members`. Replaced by [A12].
- [A3] "All non-admin entries are UNVERIFIED until admin verifies" and "conflict results are shown to the admin." Replaced by [A12] (any family member reviews; a family write with no supersede is saved verified). The candidate-visibility rule in [A3] still stands.
- [A6] Originally applied only to the admin's own superseding write. Restated under [A12] for any family member.
- [R15] "No direct verified insert except an admin after the A6 confirm" and "every non-admin write is unverified." Replaced by [A12] and the family-write rule in `SPEC-memory.md`.
- [R1, R2] A separate memory-service built from `main` at 68d851a, with `POST /memories`, `GET /reviews` and `POST /reviews/:id/decision`. Replaced by REVIEW-002 (`main` at 2cdf56c) and [A9] (logic lives in the Next.js client).
- [Q2]–[Q6] Answered by [A2]–[A6], with [A12] amending the admin-only parts of [A3] and [A6].
- [Q7] Answered by [A10]: no expiry.
- [Q8] Answered by [A9]: all memory logic is in the Next.js client.
- [Q9] Answered by [A11]: topic guidance is hardcoded in the prompt ([D5] stands).
- The brief and early demo flow said family can "expire" memories, the system labels "supersedes/related/unrelated", and only the family admin confirms. Replaced by [A10], [A14] and [A12].
- [R4] Memories Margaret created herself had scope `family`, were unverified and flagged, never proposed a supersede, and private wishes stayed private and verified. Replaced by [A16] (Margaret does not add memories in the MVP).
- [A8] The voice contract included a `remember {text, private?}` tool. Replaced by [A16]; `remember` moves to `docs/NEXT_STEPS.md`.
