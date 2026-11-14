# Memory work split (two people, parallel)

All code in client/ (A9). Each track owns its files; the shared contract below changes only by agreement.

## Shared contract (agree first, ~10 min)
- `client/lib/memories.ts` keeps: SCOPES, visibleTo, SCHEMA_VERSION, actor, audit, embed. Add `canVerify(session)` (role family, includes the admin) and `isAdmin(session)` (`admin: true` in households.members).
- Memory doc: main's schema + review {state, proposed_supersedes, candidates[{memory_id, supersedes: bool, rerank_score}], decided_by, decided_at}. No kind, no expires_at (A10).
- `client/lib/voyage.ts`: `embed(texts, input_type)` and `rerank(query, docs, top_k)` (rerank-2.5). Track A writes it first; B imports it.
- Status values: unverified | verified | superseded | retracted. Recall reads verified + unverified.

## Track A: read path + trace (demo steps 1-2)
Files: client/lib/recall.ts, client/app/api/talk/recall/route.ts, client/app/api/turns/**, client/app/trace/**, the hardcoded agent prompt.
1. recall: $vectorSearch pre-filtered (person_id, scope, status), numCandidates 100, limit 20, then rerank-2.5 top 5, drop below MIN_RERANK_SCORE (config), empty list if none. Regex fallback only while the index is building.
2. turns collection {schema_version, person_id, user_id, conversation_id, at, question, results[{memory_id, text, status, scope, author_name, author_role, created_at, vector_score, rerank_score}], answer}. Index {person_id:1, at:-1}. recall writes it and returns turn_id with the memories.
3. POST /api/turns/:id/answer: the client posts the agent's spoken answer (from the ElevenLabs transcript event in voice.tsx).
4. GET /api/turns and /api/turns/:id plus the trace screen: question, answer, each memory with who added it, when, status, scores.
5. Prompt: today's date; answer only from recall; empty means "I'm not sure, let's ask your family"; "you mentioned" for unverified; no medical advice. Topic guidance is loaded from `topic_guidance` in `/api/talk/session` and passed as `{{topic_guidance}}`.
Interface to the ElevenLabs teammate: recall tool request {query}, response {turn_id, memories[{text, status}]}; answer callback above.

## Track B: write path + review (demo steps 3-4)
Files: client/lib/classify.ts, client/app/dashboard/actions.ts, the dashboard review UI, client/app/api/talk/remember/route.ts.
1. classify(newText, person_id, writerSession): embed as document, $vectorSearch candidates (all scopes, for the admin view), rerank-2.5, decide supersedes true/false per candidate (A14; method per the A1 research; start with a rerank cutoff placeholder behind this one function), return {proposed_supersedes, candidates[{memory_id, supersedes, rerank_score}]}.
2. Add (`POST /api/memories`) by a caregiver: run classify, save unverified + review pending. The writer's response shows only candidates in their readable scopes (A3).
3. Family write that supersedes (family can verify, so they confirm their own): return needs_confirmation {old memory text, author, date}; on confirm=true approve immediately (A6).
4. Review queue: pending reviews with the old memory looked up (text, author, date) -> "This will supersede <old>". Confirm/deny by any family member (canVerify; caregivers get 403), in one transaction (withTransaction). Confirm: new verified, old superseded, audit approve. Deny: new retracted, audit deny.
5. correct (A2): a family member creates a new re-embedded memory superseding the old, in one transaction (the A6-style confirm when it supersedes). A caregiver correction goes through the normal unverified + review path.

## Order
Shared contract -> A builds voyage.ts first (about 20 min) -> both tracks run in parallel. Integration test: the demo script end to end on the demo DB after both merge.
