# Database

Setup, from the repo root, with `.env` filled in (see the root `.env.example`; the app uses `client/.env`):

1. `pip install -r db/requirements.txt`
2. `set -a; source .env; set +a; mongosh "$MONGODB_URI/$MONGODB_DB" db/schema.js` creates collections, validation and indexes (no TTL).
3. `mongosh "$MONGODB_URI/$MONGODB_DB" db/create_vector_index.js` creates the vector index. Re-run it after `schema.js`, because dropping `memories` drops its search indexes too.
4. `.venv/bin/python db/seed.py` resets demo data and embeds every memory with Voyage `voyage-3.5` (1024 dims).

To update an existing cluster without dropping data, run the scripts in `db/migrations/` in order.

`queries.js` holds reference versions of role-scoped retrieval, correction and forget.

Memory fields: `scope` is `family` or `caregiver` (no `private` scope). `status` is unverified, verified, superseded or retracted.

Role read rules: the person (recall only) and family both read family and caregiver. A caregiver reads caregiver only.

Voyage usage: `voyage-3.5` with `input_type="document"` for stored memories and `input_type="query"` for questions. `rerank-2.5` reorders the filtered vector hits before they reach the LLM.

## Memory states

- `verified`: trusted, used as fact.
- `unverified` + `review.state: pending`: waiting for a family member. `review.proposed_supersedes` is the memory it would replace (set by the system). `review.candidates` lists what the system found and whether the new memory supersedes each one (`supersedes: true/false`).
- `superseded`: replaced by a newer verified memory that points back to it with `supersedes`.
- `retracted`: admin denied it. Kept for audit, never retrieved.

Family do not classify. They confirm or deny the override the system proposed. Caregivers cannot confirm or deny.

## Turns

`turns` holds one doc per recall: the question, a snapshot of the memories the agent was given (text, status, scope, author, scores), the cutoff in force, whether search degraded, and the agent's spoken answer. The trace screen reads it, newest first (`{person_id: 1, at: -1}`).

## Demo logins

After `seed.py`: `anna@keepsake.test` (family, admin), `ravi@keepsake.test` (caregiver), `margaret@keepsake.test` (person). Password: `keepsake`.

## Users and roles

- `people` is auth only: `user_id`, `name`, `email`, `password_hash`, with unique indexes on `user_id` and `email`. `schema.js` never drops it.
- `households` owns membership and roles: one doc per person, members embedded, unique index on `members.user_id`.
- Login reads `people` once. Every request after that resolves role through `households` (see `whoami` in `queries.js`).

## Schema versions

Every doc in `memories`, `households`, `people`, `audit_log` and `turns` has `schema_version` (int). The validators require it. A doc without it is v0, from before versioning.

All collections are on version 1. When a collection's shape changes:

1. Bump its number in `schema.js`, `seed.py` (`SCHEMA_VERSION`) and `queries.js`.
2. Add a migration in `db/migrations/` that upgrades old docs and runs `collMod`. Don't drop the collection, because that deletes the vector index.
3. Code that reads a doc checks `schema_version` and handles older versions until the migration has run.

Migrations so far: `001_review.js` (review subdoc), `002_people_auth.js` (people is auth only), `003_schema_version.js` (adds the field and stamps existing docs as v1), `004_binary_review_no_ttl.js` (binary supersedes, no TTL), `005_turns.js` (the turns collection), `006_source_name_no_private.js` (`source.name`, and scope is family or caregiver only).
