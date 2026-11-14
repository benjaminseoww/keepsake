# Next steps / extra features

MVP first. These after.

## Topic guidance

Family write rules on the dashboard. They live in the `topic_guidance` collection (one doc per person + topic, unique index `{ person_id: 1, topic: 1 }`). Fields: `person_id`, `topic`, `guidance`, `related_memory_ids`, `set_by`, `updated_at`.

`/api/talk/session` loads that person's rows and passes them to the voice agent as the `{{topic_guidance}}` dynamic variable (one `- topic: guidance` line per row, or `None.`). Dashboard edits apply on the next session.

Later: embed the topics array in the `households` doc (Mongo: read together, store together). Few topics per person, bounded array.

## Leakage test (second household)

Second person, Harold. Son Sam. Few memories.
Every Margaret query return zero Harold ids. Script check it. Prove scope filter work.

## Memory kind

Removed `kind` (routine, event, fact, preference). Maybe back if agent need it for prompt or UI grouping. Not need for demo.

## Unverified memories expire

Margaret say thing, family not verify in N days, memory gone. Set `expires_at` on write for unverified. TTL do rest.

## Change stream

Watch `memories`. Write `audit_log`. Push flags to family view live, no refresh.

## Time series for logs

`audit_log` or new `turns` log as time series collection. Append only, time main axis. Not `memories` (need update, delete, vector search, per-doc TTL).

## Hybrid search

Atlas Search text index on `text`. Merge with vector via `$rankFusion` (check cluster version). Help exact names: Ravi, physio.

## Replay judge

LLM score before/after replies. Cited id diff is main proof, judge is extra.

## Speech in

ElevenLabs speech-to-text for Margaret. MVP: voice out only, text in fallback.

## LangSmith

Trace each turn and replay run. Judges not see in 1 min video. Last.

## Mongo best practices to keep

- store together what read together
- index every filter field (`person_id`, `scope`, `status` in vector index)
- schema validation on enums
- bounded arrays only, no unbounded growth in one doc
- no secrets in repo, `.env` ignored
