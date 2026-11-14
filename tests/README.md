# Test scenarios

Spec for search and supersede behaviour. Code must pass all of these. No harness yet.

- `scenarios/memories.json`: short keys for the seed memories in `db/seed.py`.
- `scenarios/read_path.json`: someone asks a question. Checks scope filtering, status filtering, and that rerank keeps the right memories and drops off-topic ones. Readable scopes (A17): Margaret (recall only) and family both read family and caregiver; a caregiver reads caregiver. There is no private scope.
- `scenarios/write_path.json`: someone adds a memory. The system finds candidate memories and decides for each one whether the new memory supersedes it. A supersede creates a pending override.
- `scenarios/admin_review.json`: a family member grants or refuses permission to override. Family members never classify, and caregivers can't confirm or deny.

Each test run should reseed with `python db/seed.py` first. Pick rerank and similarity thresholds from the scores these cases produce.
