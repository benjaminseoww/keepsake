# Keepsake memory spec (MVP)

Source of truth for memory behaviour. Decisions are logged in DECISIONS.md, and the work split is in WORKSPLIT.md. Base: main @ 2cdf56c.

## Roles and permissions
Roles come from `households.members` on every request. The JWT is trusted for user_id only.

| Action | person (Margaret) | caregiver | family | family admin |
|---|---|---|---|---|
| Ask the voice agent (recall) | yes | no | no | no |
| Add a memory | yes, by voice (remember) | yes, saved unverified | yes | yes |
| Verify / deny / confirm a supersede | no | **no** | yes | yes |
| Correct a memory | no | goes to review | yes | yes |
| View the trace | no | own scopes | yes | yes |
| Manage household members | no | no | no | **yes** |

- The system classifies a new memory against existing ones as supersedes, related or unrelated. People only confirm or deny (D1, D2).
- Readable scopes: person reads private, family and caregiver; family reads family and caregiver; caregiver reads caregiver.

## Memory document
main's schema plus `review`:
`{schema_version:1, person_id, text, scope, status, source:{role,user_id}, supersedes, flagged, embedding[1024], created_at, review?:{state: pending|approved|denied, proposed_supersedes, candidates[{memory_id, label, rerank_score}], decided_by, decided_at}}`
- status: unverified | verified | superseded | retracted. Recall reads verified and unverified.
- No `kind` field. No `expires_at`. Time-bound facts keep their dates in the text ("Anna is visiting Nov 12-16"). Optional `event_start`/`event_end` are allowed, but recall never filters on them.
- Embeddings: voyage-3.5, 1024 dims, cosine; input_type `document` on write and `query` on recall.

## Recall (demo steps 1-2)
1. `$vectorSearch` on `memory_vec`, pre-filtered by person_id, readable scopes and status in [verified, unverified]; numCandidates 100, limit 20.
2. rerank-2.5 over the hits with the question as the query; keep the top 5.
3. Drop results below `MIN_RERANK_SCORE` (config; calibrate on the seed data so out-of-knowledge questions return nothing). If none are left, return an empty list.
4. The regex fallback runs only while the vector index is building.
5. Write a `turns` doc and return `{turn_id, memories:[{text, status}]}`.

## Turns and trace
`turns: {schema_version:1, person_id, user_id, conversation_id, at, question, results[{memory_id, text, status, scope, author_name, author_role, created_at, vector_score, rerank_score}], answer}`. Index `{person_id:1, at:-1}`.
- `POST /api/turns/:id/answer {answer}`: the voice client posts the agent's spoken answer.
- `GET /api/turns` (newest first) and `GET /api/turns/:id`. The trace screen shows the question, the answer, and for each memory who added it, when, its status and its scores.

## Write and review (demo steps 3-4)
classify(text, person_id): embed as a document, then `$vectorSearch` candidates across all scopes for this person, then rerank-2.5, then label each one supersedes, related or unrelated. Return `{proposed_supersedes, candidates}`. It sits behind one function so the method can change (Q1 research pending; start with a rerank cutoff).

- **Caregiver adds:** the memory is saved unverified with review pending, proposed_supersedes and candidates set, and flagged true. The caregiver's response lists only candidates in the caregiver's readable scopes.
- **Margaret adds (remember):** saved with scope family, unverified, review pending. Its proposed_supersedes is always null (R4). Private wishes stay private and verified, as main already does.
- **Family adds or corrects:** if classify proposes a supersede, the response is `{needs_confirmation: true, old:{memory_id, text, author_name, created_at}}`. The UI shows "Are you sure? This will supersede <old>". Resending with `confirm: true` saves it verified, marks the old memory superseded and writes audit approve, all in one transaction. With no supersede, the memory is saved verified.
- **Review queue (family only):** all pending reviews, each with the old memory looked up (text, author, date) so the card can say "This will supersede <old>". Every candidate is visible here.
- **Confirm (family):** in one transaction, the new memory becomes verified with review approved and supersedes set; the old one becomes superseded; audit approve. With no proposal, it's a plain verify.
- **Deny (family):** the new memory becomes retracted with review denied; the old one is untouched; audit deny.
- Caregivers calling verify, deny, confirm or correct get 403. A caregiver's correction is saved as a new unverified memory with review pending.
- Multi-document changes use `session.withTransaction`. A memory is never stored with an empty embedding when the embed can run before the insert.

## Voice agent contract (for the ElevenLabs teammate)
- Client tools: `recall {query}` returns `{turn_id, memories[{text, status}]}`; `remember {text, private?}` returns `{saved, needs_family_review}`.
- After the agent answers, call `POST /api/turns/:turn_id/answer`.
- Hardcoded prompt: today's date; answer only from recall results; with no results, say you're not sure and suggest asking family; use "you mentioned" for unverified memories; no medical advice; topic guidance written inline (D5). The `topic_guidance` collection is no longer read.

## Household members
Only the family admin adds or removes members (backend `POST /users`, requireFamilyAdmin). That is the admin's only extra power.

## Out of scope (NEXT_STEPS)
Leakage test, `kind` field, live push notifications (change streams), an LLM classifier if Q1 lands on rerank-only, time-series turns.
