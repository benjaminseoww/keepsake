# Database

Setup, from the repo root, with `.env` filled in (see `.env.example`):

1. `pip install -r db/requirements.txt`
2. `set -a; source .env; set +a; mongosh "$MONGODB_URI/$MONGODB_DB" db/schema.js` creates collections, validation, TTL and indexes.
3. Create the vector index: `mongosh "$MONGODB_URI/$MONGODB_DB" --eval 'const f = JSON.parse(fs.readFileSync("db/vector_index.json","utf8")); db.memories.createSearchIndex({name: f.name, type: f.type, definition: f.definition})'` (or paste `vector_index.json` into the Atlas UI JSON editor).
4. `python db/seed.py` resets demo data and embeds every memory with Voyage `voyage-3.5` (1024 dims).

`queries.js` holds reference versions of role-scoped retrieval, correction and forget.

Memory fields: `scope` is private, family or caregiver. `status` is unverified, verified, superseded or retracted.

Role read rules: person reads private, family and caregiver. Family reads family and caregiver. Caregiver reads caregiver only.

Voyage usage: `voyage-3.5` with `input_type="document"` for stored memories and `input_type="query"` for questions. `rerank-2.5` reorders the filtered vector hits before they reach the LLM.
