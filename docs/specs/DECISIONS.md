# Keepsake decision log

Maintained by Mica (tech lead review). Newest entries at the bottom of each section.

## Requirements (from hackathon brief)
- Event: MongoDB "Agents in Context" Toronto hackathon, Memory You Can Govern track. Submissions due Nov 14 2026, 5 pm ET.
- Required: ElevenLabs, the provisioned MongoDB Atlas cluster, a 1-minute demo video.
- Banned: Streamlit, dashboard as the main feature, medical advice, basic RAG.
- Product: voice agent for a person with early dementia (Margaret); family can verify, correct, scope and expire her memories.
- Demo flow (relayed by keepsake, Nov 14; restated by Daniel directly the same day): Margaret asks a question within the knowledge base and the voice answers; "How did it know this?" opens a trace screen with her question and the memory record (who added it, when, verification state); a caregiver adds information, the system checks it against existing memories (vector search + rerank-2.5, system labels supersedes/related/unrelated) and the conflicting fact shows up; the family admin sees "this memory will supersede the old one <old memory>" and confirms or denies. The admin never classifies.

## Source of truth
- main @ 68d851a is source of truth; user-service DB model stale (relayed by keepsake, Nov 14). The tests branch was merged into main (PR #3) and deleted. feat/memory-service is cut from main. user-service/ is used only for its API/token contract (JWT {user_id, name, role, person_id}, Bearer, Node/TS Fastify) and docs/memory-service-plan.md.
- Reported by keepsake, not verified: migration 002 has already run on the shared Atlas cluster (people stripped of role/person_id; households has no timezone).

## Stack
- MongoDB Atlas + Atlas Vector Search.
- Voyage AI: voyage-3.5 embeddings, rerank-2.5 reranking.
- ElevenLabs voice.
- Node/TypeScript backend.

## Fixed decisions (Daniel)
- D1: The SYSTEM classifies a new memory against existing ones as supersedes / related / unrelated.
- D2: The admin only grants or denies permission to override. The admin never classifies.
- D3: MVP has no leakage test.
- D4: MVP has no memory `kind` field.
- D5: Topic guidance is hardcoded in the prompt.
- D6: Deferred items go in NEXT_STEPS.md.
- D7: Follow MongoDB best practices.

## Review decisions
- R1 (source: REVIEW-001): The memory service builds on main's model: review subdoc, retracted status, schema_version: 1 on every insert. The JWT is trusted for user_id only; person_id, role and admin are resolved per request from households.members (whoami).
- R2 (source: REVIEW-001): Write/review endpoints: POST /memories (embed, candidate search, rerank-2.5, system classify, insert unverified + flagged + review pending, audit write); GET /reviews (pending queue with the proposed old memory joined); POST /reviews/:id/decision {confirm|deny}, admin only (members.admin).
- R3 (source: REVIEW-001): Confirm = new memory verified, review.state approved, supersedes set; old memory superseded; audit approve. Deny = new memory retracted, review.state denied; old untouched; audit deny. Confirm with no proposal = plain verify. Both run in one multi-document transaction. If the old memory is gone (TTL), treat as plain verify. New memory inherits the old memory's scope and, if it has none, its expires_at.
- R4 (source: REVIEW-001): Person-created memories: scope family, unverified, flagged, review pending; classifier labels honestly but proposed_supersedes is always null when source.role is person.
- R5 (source: REVIEW-001): /search returns unverified memories tagged with status (R10, R16). rerank-2.5 is always on with a calibrated RERANK_MIN; vector order only if the Voyage call fails.
- R6 (source: REVIEW-001): Add a `turns` collection {schema_version, person_id, user_id, conversation_id, at, question, results[{memory_id, status, score, rerank_score}], answer?}, index {person_id:1, at:-1}; /search writes it and returns turn_id; GET /turns/:id returns hydrated memories with display names. Time series stays in NEXT_STEPS.
- R7 (source: REVIEW-001): Do not port queries.js correct() or retrieveFallback() as is. Never store an empty embedding; never copy key or review onto a new doc; gate /search on the vector index being READY.
- R8 (source: REVIEW-001): Expiry: TTL index for deletion plus a $match on expires_at (null or > now) right after $vectorSearch.
- R9 (source: REVIEW-001): Scenario tests run against MONGODB_DB=keepsake_test with its own memory_vec index, never the demo DB. seed.py upserts demo logins into people.
- R10 (source: REVIEW-001): Audit actions: write on create, approve/deny for admin decisions; fix seed.py:154 (correct -> approve). Add person_id to audit_log with index {person_id:1, at:-1} via migration.
- R11 (source: REVIEW-001): review.state pending is the review queue's source of truth; flagged is a UI hint only.
- R12 (source: REVIEW-001): Python seed stays as dev tooling for the hackathon; embedding config (voyage-3.5, 1024 dims, cosine, input_type document/query) is one documented constant set. Services are Node/TS.
- R13 (source: REVIEW-001): Agent prompt (hardcoded, per D5) carries the husband rule, "you mentioned" phrasing for unverified memories, and no medical advice.
- R14 (source: REVIEW-001): Defaults pending Daniel: only the admin confirms/denies, no direct family "correct" endpoint in MVP (Q2); candidate search limited to the writer's readable scopes (Q3); admin's own superseding writes stay pending (Q6).

## Open questions for Daniel
- Q1 (source: REVIEW-001): Who labels candidates supersedes/related/unrelated: an LLM (which provider/model) on top of rerank-2.5, or rerank-2.5 with an instruction query and cutoffs only? Blocks the write path.
- Q2 (source: REVIEW-001): Admin-only confirm/deny (recommended) or any family member? Drop the direct "correct" endpoint for MVP so every supersede is system-proposed (recommended)?
- Q3 (source: REVIEW-001): Candidate search within the writer's readable scopes (recommended) or all scopes as write_path.json:2 says?
- Q4 (source: REVIEW-001): In the video, does Margaret speak (ElevenLabs Conversational AI speech in) or type with voice out only (NEXT_STEPS:51)?
- Q5 (source: REVIEW-001): Should the trace screen show the agent's answer text (needs capture from ElevenLabs) or only the question plus retrieved memories?
- Q6 (source: REVIEW-001): Admin's own superseding write (W09): pending for her to confirm (recommended) or auto-approved?

## Daniel's answers (Nov 14, 12:11 ET, direct)
- A1 (Q1): Classifier choice follows best practices; Mica to research (MongoDB/Voyage docs) and specify.
- A2 (Q2): `correct` stays as an endpoint.
- A3 (Q3): Conflict detection results are shown to the admin when verifying. A caregiver sees candidates only for memories they have permission to read. All non-admin entries are UNVERIFIED until admin verifies.
- A4 (Q4): Margaret speaks to the bot and hears the answer (voice in and out).
- A5 (Q5): Trace shows everything: question, retrieved memories with author/metadata, scores, and the answer text.
- A6 (Q6): When the admin writes a superseding fact, show "Are you sure? This will supersede <old>". On yes, it is approved immediately.
- A7: Add a minimum relevance score so out-of-knowledge questions return nothing.
- A8: Mica owns the project spec/requirements. ElevenLabs integration is built by another team member from our specs, so the recall tool contract must be complete and standalone.

## REVIEW-002 (main @ 2cdf56c, quick check, Nov 14 12:25 ET)
- main @ 2cdf56c is the current source of truth; snapshot at main-2cdf56c/.
- R15: Non-admin writes (dashboard addMemory, remember) must run classify and save as unverified + review pending. No direct "verified" insert except an admin after the A6 confirm.
- R16: Recall = $vectorSearch (pre-filtered) then rerank-2.5 then MIN_RERANK_SCORE cutoff (empty if below). Regex fallback only while the index is building.
- R17: Every recall writes a turns doc and returns turn_id; the client posts the answer text back to it.
- R18: Verify/deny require admin:true from households.members.
- Q7: Is expires_at in the MVP at all? If yes: excluded from recall after the date, kept for audit (no TTL delete).
- Q8: One home for memory logic: Next.js client (recommended) or keepsake's separate memory-service?
- Q9: topic_guidance collection (built) vs hardcoded prompt (D5)?

## Daniel's answers (Nov 14, 12:24 ET, direct)
- A9 (Q8): All memory logic lives in the Next.js client (client/lib + /api routes + dashboard actions). keepsake ports its turns, classifier and rerank work there; no separate memory-service.
- A10 (Q7): No expiry. Time-bound facts are stored with their dates in the text (e.g. "Anna is visiting Nov 12-16") so the agent can answer "is Anna visiting this week?". The prompt gets today's date. Optional event_start/event_end fields are allowed but recall never excludes by date. Drop expires_at from writes and recall; TTL index not used.
- A11 (Q9): Topic guidance hardcoded in the prompt (D5 stands). Recall stops reading the topic_guidance collection.

## Daniel's answers (Nov 14, 12:26 ET, direct)
- A12: Any family member (role family, including the admin) can verify, deny, confirm a supersede and correct. Caregivers cannot verify; their writes stay unverified until a family member reviews them. Supersedes R18 and the "admin-only confirm" parts of R14/A3/A6.
- A13: The admin's only extra power is managing household members (POST /users etc. in backend/, already requireFamilyAdmin).
- A6 restated under A12: when a family member writes or corrects a fact that supersedes another, show "Are you sure? This will supersede <old>"; on yes it is approved immediately.

## Daniel's answers (relayed by keepsake, Nov 14 12:35 ET)
- A14: Classification is binary: a new memory supersedes a candidate or it doesn't. related/unrelated are dropped. classify() returns {proposed_supersedes, candidates[{memory_id, supersedes: bool, rerank_score}]}. Amends D1. proposed_supersedes = top-ranked candidate with supersedes true, else null.
- Spec commits go on branch docs/memory-spec (reported by keepsake as pushed at 9640875; Daniel opens the PR).
