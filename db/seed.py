"""Reset Keepsake demo data and embed every memory with Voyage AI.

Run from the repo root:  .venv/bin/python db/seed.py
Needs MONGODB_URI, MONGODB_DB and VOYAGE_API_KEY in .env.
All people and data are invented.

Memory states in this seed:
  verified                  trusted, used as fact
  unverified + pending      waiting for admin; may propose an override (review.proposed_supersedes)
  unverified (from person)  something Margaret said; flagged, never proposes an override
  superseded                replaced by a newer verified memory (history for the trace screen)
  retracted                 admin denied it; kept for audit, never retrieved
"""
import os
from datetime import datetime, timedelta, timezone

import voyageai
from dotenv import load_dotenv
from pymongo import MongoClient

load_dotenv()

SCHEMA_VERSION = 1  # keep in step with db/schema.js
EMBED_MODEL = "voyage-3.5"  # 1024 dims, matches db/vector_index.json

db = MongoClient(os.environ["MONGODB_URI"])[os.environ.get("MONGODB_DB", "keepsake")]
vo = voyageai.Client()  # reads VOYAGE_API_KEY

now = datetime.now(timezone.utc)
ago = lambda **kw: now - timedelta(**kw)
local_tonight = datetime.now().astimezone().replace(hour=21, minute=0, second=0, microsecond=0)

anna = {"role": "family", "user_id": "anna"}
ravi = {"role": "caregiver", "user_id": "ravi"}
marg = {"role": "person", "user_id": "margaret"}

for name in ["memories", "households", "audit_log", "replay_runs"]:
    db[name].delete_many({})

db.households.insert_one({
    "schema_version": SCHEMA_VERSION,
    "person_id": "margaret",
    "members": [
        {"user_id": "margaret", "name": "Margaret", "role": "person"},
        {"user_id": "anna", "name": "Anna", "role": "family", "relation": "daughter", "admin": True},
        {"user_id": "ravi", "name": "Ravi", "role": "caregiver", "shift": "weekday mornings"},
    ],
})

V = "verified"
U = "unverified"

# Each entry: key, text, scope, status, source, plus optional fields.
# "_supersedes" / "_proposes" / "_candidates" use keys and get turned into ObjectIds after insert.
memories = [
    # ---------- verified: routines and schedule ----------
    {"key": "ravi_weekdays", "text": "Ravi visits on weekday mornings at 10", "scope": "caregiver", "status": V, "source": anna,
     "_supersedes": "ravi_9am_old", "created_at": ago(days=20)},
    {"key": "tea", "text": "Margaret takes her morning tea with milk, no sugar, around 8", "scope": "caregiver", "status": V, "source": anna},
    {"key": "anna_calls", "text": "Anna calls every evening around 7", "scope": "family", "status": V, "source": anna},
    {"key": "physio_weekly", "text": "Physio visit is every Tuesday at 2pm", "scope": "caregiver", "status": V, "source": anna,
     "note": "Wrong on purpose: the demo corrects it to every second week."},
    {"key": "garbage_day", "text": "Garbage and recycling go out Wednesday night", "scope": "caregiver", "status": V, "source": anna},
    {"key": "ravi_holidays", "text": "Ravi does not come on statutory holidays", "scope": "caregiver", "status": V, "source": anna},

    # ---------- verified: events (expire) ----------
    {"key": "anna_dinner", "text": "Anna is bringing dinner today at 6pm", "scope": "family", "status": V, "source": anna,
     "expires_at": local_tonight},
    {"key": "joan_books", "text": "Neighbour Joan is dropping off library books this morning", "scope": "caregiver", "status": V, "source": anna,
     "expires_at": now + timedelta(minutes=5), "note": "Expires during the demo."},
    {"key": "leo_birthday", "text": "Grandson Leo's birthday party is next Saturday", "scope": "family", "status": V, "source": anna,
     "expires_at": now + timedelta(days=8)},

    # ---------- verified: facts ----------
    {"key": "husband", "text": "Margaret's husband George passed away in 2022", "scope": "family", "status": V, "source": anna},
    {"key": "address", "text": "Margaret has lived at 14 Elm Street since 2019", "scope": "family", "status": V, "source": anna},
    {"key": "spare_key", "text": "Spare house key is in the blue bowl by the front door", "scope": "caregiver", "status": V, "source": anna},
    {"key": "glasses", "text": "Reading glasses are usually on the kitchen windowsill", "scope": "caregiver", "status": V, "source": ravi},
    {"key": "phone_charger", "text": "Margaret's phone charger is in the top kitchen drawer", "scope": "caregiver", "status": V, "source": ravi},
    {"key": "grandkids", "text": "Margaret has two grandchildren, Leo and Maya", "scope": "family", "status": V, "source": anna},

    # ---------- verified: preferences ----------
    {"key": "lisbon_album", "text": "Margaret likes looking at the photo album from the 1998 Lisbon trip", "scope": "caregiver", "status": V, "source": anna},
    {"key": "radio", "text": "Margaret prefers the radio on CBC Music in the afternoon", "scope": "caregiver", "status": V, "source": ravi},

    # ---------- verified: private and family-only ----------
    {"key": "ring_private", "text": "I want to give my mother's ring to Leo, not to Anna", "scope": "private", "status": V, "source": marg},
    {"key": "assisted_living", "text": "Anna and her brother are discussing whether Margaret should move to assisted living", "scope": "family", "status": V, "source": anna},

    # ---------- unverified, pending, PROPOSES an override (caregiver) ----------
    {"key": "glasses_bedside_pending", "text": "Margaret's reading glasses are now kept on the bedside table", "scope": "caregiver", "status": U, "source": ravi,
     "flagged": True, "_proposes": "glasses",
     "_candidates": [("glasses", "supersedes"), ("phone_charger", "unrelated")], "created_at": ago(hours=20)},
    {"key": "radio_classical_pending", "text": "Margaret switched to classical music on the radio in the afternoons", "scope": "caregiver", "status": U, "source": ravi,
     "flagged": True, "_proposes": "radio",
     "_candidates": [("radio", "supersedes"), ("lisbon_album", "unrelated")], "created_at": ago(hours=6)},

    # ---------- unverified, pending, does NOT propose an override (caregiver) ----------
    {"key": "ravi_newspaper_pending", "text": "Ravi brings the newspaper with him on Monday visits", "scope": "caregiver", "status": U, "source": ravi,
     "flagged": True, "_proposes": None,
     "_candidates": [("ravi_weekdays", "related")], "created_at": ago(hours=30),
     "note": "Related to the visit routine but adds to it."},
    {"key": "cardigan_pending", "text": "Margaret's favourite cardigan is the green one in the hall closet", "scope": "caregiver", "status": U, "source": ravi,
     "flagged": True, "_proposes": None, "_candidates": [], "created_at": ago(hours=3),
     "note": "Nothing related found."},
    {"key": "garbage_neighbour_pending", "text": "Joan's son takes the garbage bins to the curb for Margaret", "scope": "caregiver", "status": U, "source": ravi,
     "flagged": True, "_proposes": None,
     "_candidates": [("garbage_day", "related")], "created_at": ago(hours=2),
     "note": "Same topic, different detail: who, not when."},

    # ---------- unverified, from Margaret (never proposes an override) ----------
    {"key": "ruth_unverified", "text": "Margaret said her sister Ruth visited yesterday", "scope": "family", "status": U, "source": marg,
     "flagged": True, "_proposes": None, "_candidates": [], "expires_at": now + timedelta(days=3), "created_at": ago(hours=18)},
    {"key": "maple_unverified", "text": "Margaret said she lives on Maple Avenue", "scope": "family", "status": U, "source": marg,
     "flagged": True, "_proposes": None,
     "_candidates": [("address", "related")], "created_at": ago(hours=26),
     "note": "Contradicts a verified fact, but a person's statement never overrides family-verified memory."},

    # ---------- history: approved override (old one superseded) ----------
    {"key": "ravi_9am_old", "text": "Ravi visits on weekday mornings at 9", "scope": "caregiver", "status": "superseded", "source": anna,
     "created_at": ago(days=40)},

    # ---------- history: denied proposal ----------
    {"key": "key_doormat_denied", "text": "The spare key is under the front doormat", "scope": "caregiver", "status": "retracted", "source": ravi,
     "_proposes": "spare_key", "_candidates": [("spare_key", "supersedes")], "_decision": ("denied", "anna", ago(days=5)),
     "created_at": ago(days=6)},
]

# One Voyage call embeds every memory. input_type="document" for stored text;
# the backend uses input_type="query" for questions and conflict checks.
vectors = vo.embed([m["text"] for m in memories], model=EMBED_MODEL, input_type="document").embeddings

PRIVATE = {"_supersedes", "_proposes", "_candidates", "_decision"}
docs = []
for m, v in zip(memories, vectors):
    d = {"schema_version": SCHEMA_VERSION, "person_id": "margaret", "supersedes": None, "flagged": False, "expires_at": None, "created_at": now}
    d.update({k: val for k, val in m.items() if k not in PRIVATE})
    d["embedding"] = v
    docs.append(d)

res = db.memories.insert_many(docs)
ids = {m["key"]: _id for m, _id in zip(memories, res.inserted_ids)}

# Second pass: turn key references into ObjectIds.
for m in memories:
    _id = ids[m["key"]]
    if m.get("_supersedes"):
        db.memories.update_one({"_id": _id}, {"$set": {
            "supersedes": ids[m["_supersedes"]],
            "review": {"state": "approved", "proposed_supersedes": ids[m["_supersedes"]],
                       "candidates": [{"memory_id": ids[m["_supersedes"]], "label": "supersedes"}],
                       "decided_by": "anna", "decided_at": ago(days=20)},
        }})
        db.audit_log.insert_one({"schema_version": SCHEMA_VERSION, "memory_id": _id, "action": "correct", "actor": anna,
                                 "old_id": ids[m["_supersedes"]], "new_id": _id, "at": ago(days=20)})
    if "_proposes" in m:
        state, by, at = m.get("_decision", ("pending", None, None))
        db.memories.update_one({"_id": _id}, {"$set": {"review": {
            "state": state,
            "proposed_supersedes": ids[m["_proposes"]] if m["_proposes"] else None,
            "candidates": [{"memory_id": ids[k], "label": lbl} for k, lbl in m.get("_candidates", [])],
            "decided_by": by, "decided_at": at,
        }}})
        if state == "denied":
            db.audit_log.insert_one({"schema_version": SCHEMA_VERSION, "memory_id": _id, "action": "deny", "actor": {"role": "family", "user_id": by},
                                     "old_id": None, "new_id": None, "at": at})

counts = {s: db.memories.count_documents({"status": s}) for s in ["verified", "unverified", "superseded", "retracted"]}
pending = db.memories.count_documents({"review.state": "pending"})
proposing = db.memories.count_documents({"review.state": "pending", "review.proposed_supersedes": {"$ne": None}})
print(f"Seeded {len(docs)} memories with {EMBED_MODEL} ({len(vectors[0])} dims): {counts}")
old = sum(db[c].count_documents({"schema_version": {"$ne": SCHEMA_VERSION}}) for c in ["memories", "households", "audit_log", "people"])
print(f"Docs not on schema_version {SCHEMA_VERSION}: {old}")
print(f"Review queue: {pending} pending, {proposing} propose an override.")
