"""Reset Keepsake demo data and embed every memory with Voyage AI.

Run from the repo root:  python db/seed.py
Needs MONGODB_URI, MONGODB_DB and VOYAGE_API_KEY in .env.
All people and data are invented.
"""
import os
from datetime import datetime, timedelta, timezone

import voyageai
from dotenv import load_dotenv
from pymongo import MongoClient

load_dotenv()

EMBED_MODEL = "voyage-3.5"  # 1024 dims, matches db/vector_index.json

db = MongoClient(os.environ["MONGODB_URI"])[os.environ.get("MONGODB_DB", "keepsake")]
vo = voyageai.Client()  # reads VOYAGE_API_KEY

now = datetime.now(timezone.utc)
local_tonight = datetime.now().astimezone().replace(hour=21, minute=0, second=0, microsecond=0)

anna = {"role": "family", "user_id": "anna"}
ravi = {"role": "caregiver", "user_id": "ravi"}
marg = {"role": "person", "user_id": "margaret"}

for name in ["memories", "people", "audit_log", "replay_runs"]:
    db[name].delete_many({})

db.people.insert_many([
    {"user_id": "margaret", "name": "Margaret", "role": "person", "person_id": "margaret"},
    {"user_id": "anna", "name": "Anna", "role": "family", "person_id": "margaret", "relation": "daughter", "admin": True},
    {"user_id": "ravi", "name": "Ravi", "role": "caregiver", "person_id": "margaret", "shift": "weekday mornings"},
])

memories = [
    {"text": "Ravi visits on weekday mornings at 10", "scope": "caregiver", "status": "verified", "source": anna},
    {"text": "Margaret takes her morning tea with milk, no sugar, around 8", "scope": "caregiver", "status": "verified", "source": anna},
    {"text": "Anna calls every evening around 7", "scope": "family", "status": "verified", "source": anna},
    # the wrong one: corrected in the demo to every second week
    {"text": "Physio visit is every Tuesday at 2pm", "scope": "caregiver", "status": "verified", "source": anna, "demo_tag": "physio_wrong"},

    {"text": "Anna is bringing dinner today at 6pm", "scope": "family", "status": "verified", "source": anna, "expires_at": local_tonight},
    # expires a few minutes after seeding so TTL removes it during the demo
    {"text": "Neighbour Joan is dropping off library books this morning", "scope": "caregiver", "status": "verified", "source": anna,
     "expires_at": now + timedelta(minutes=5), "demo_tag": "expiring"},
    {"text": "Grandson Leo's birthday party is next Saturday", "scope": "family", "status": "verified", "source": anna,
     "expires_at": now + timedelta(days=8)},

    {"text": "Margaret's husband George passed away in 2022", "scope": "family", "status": "verified", "source": anna, "demo_tag": "husband"},
    {"text": "Margaret has lived at 14 Elm Street since 2019", "scope": "family", "status": "verified", "source": anna},
    {"text": "Spare house key is in the blue bowl by the front door", "scope": "caregiver", "status": "verified", "source": anna},
    {"text": "Reading glasses are usually on the kitchen windowsill", "scope": "caregiver", "status": "verified", "source": ravi},

    {"text": "Margaret likes looking at the photo album from the 1998 Lisbon trip", "scope": "caregiver", "status": "verified", "source": anna},
    {"text": "Margaret prefers the radio on CBC Music in the afternoon", "scope": "caregiver", "status": "verified", "source": ravi},

    # private: family and caregiver can't see it
    {"text": "I want to give my mother's ring to Leo, not to Anna", "scope": "private", "status": "verified", "source": marg, "demo_tag": "private"},
    # family-only note Ravi must not see
    {"text": "Anna and her brother are discussing whether Margaret should move to assisted living", "scope": "family", "status": "verified",
     "source": anna, "demo_tag": "family_only"},

    # unverified, from Margaret, already flagged
    {"text": "Margaret said her sister Ruth visited yesterday", "scope": "family", "status": "unverified", "flagged": True, "source": marg,
     "expires_at": now + timedelta(days=3)},
]

# One Voyage call embeds every memory. input_type="document" for stored text;
# the backend uses input_type="query" for questions.
vectors = vo.embed([m["text"] for m in memories], model=EMBED_MODEL, input_type="document").embeddings

docs = [
    {"person_id": "margaret", "supersedes": None, "flagged": False, "expires_at": None, "created_at": now, **m, "embedding": v}
    for m, v in zip(memories, vectors)
]
db.memories.insert_many(docs)

print(f"Seeded {len(docs)} memories with {EMBED_MODEL} embeddings ({len(vectors[0])} dims).")
