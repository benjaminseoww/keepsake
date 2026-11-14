# Database

Setup, from the repo root, with `.env` filled in (see `.env.example`):

1. `pip install -r db/requirements.txt`
2. `set -a; source .env; set +a; mongosh "$MONGODB_URI/$MONGODB_DB" db/schema.js` creates collections, validation, TTL and indexes.
3. `mongosh "$MONGODB_URI/$MONGODB_DB" db/create_vector_index.js` creates the vector index. Re-run it after `schema.js`, because dropping `memories` drops its search indexes too.
4. `.venv/bin/python db/seed.py` resets demo data and embeds every memory with Voyage `voyage-3.5` (1024 dims).

To update an existing cluster without dropping data, run the scripts in `db/migrations/` in order.

`queries.js` holds reference versions of role-scoped retrieval, correction and forget.

Memory fields: `scope` is private, family or caregiver. `status` is unverified, verified, superseded or retracted.

Topic guidance (husband question) is hardcoded in the agent prompt for the MVP. See `NEXT_STEPS.md`.

Role read rules: person reads private, family and caregiver. Family reads family and caregiver. Caregiver reads caregiver only.

Voyage usage: `voyage-3.5` with `input_type="document"` for stored memories and `input_type="query"` for questions. `rerank-2.5` reorders the filtered vector hits before they reach the LLM.

## Memory states

- `verified`: trusted, used as fact.
- `unverified` + `review.state: pending`: waiting for the admin. `review.proposed_supersedes` is the memory it would replace (set by the system). `review.candidates` lists what the system found and how it labelled each one (`supersedes`, `related`, `unrelated`).
- `unverified` from the person: flagged, never proposes an override.
- `superseded`: replaced by a newer verified memory that points back to it with `supersedes`.
- `retracted`: admin denied it. Kept for audit, never retrieved.

The admin never classifies. They approve or deny the override the system proposed.
