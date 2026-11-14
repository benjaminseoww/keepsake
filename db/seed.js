// Run with: mongosh "$MONGODB_URI/keepsake" db/seed.js
// Resets demo data. Embeddings are left empty; the backend fills them in.
// All people and data are invented.

const now = new Date();
const inMinutes = (m) => new Date(now.getTime() + m * 60 * 1000);
const tonight = new Date(now); tonight.setHours(21, 0, 0, 0);

const anna = { role: "family", user_id: "anna" };
const ravi = { role: "caregiver", user_id: "ravi" };
const marg = { role: "person", user_id: "margaret" };
const sam  = { role: "family", user_id: "sam" };

["memories", "people", "topic_guidance", "audit_log", "replay_runs"].forEach(c => db[c].deleteMany({}));

// Every demo login uses password "keepsake" (bcrypt hash below). Email is <user_id>@keepsake.test.
const password_hash = "$2b$10$OwUnGqFauqbAzW8RROu5M.1cVcMbd1ZrVxJvdXg13n74VvWsoys9m";
db.people.insertMany([
  { user_id: "margaret", name: "Margaret", role: "person",    person_id: "margaret" },
  { user_id: "anna",     name: "Anna",     role: "family",    person_id: "margaret", relation: "daughter", admin: true },
  { user_id: "ravi",     name: "Ravi",     role: "caregiver", person_id: "margaret", shift: "weekday mornings" },
  // second household for the leakage test
  { user_id: "harold",   name: "Harold",   role: "person",    person_id: "harold" },
  { user_id: "sam",      name: "Sam",      role: "family",    person_id: "harold", admin: true }
].map(p => ({ ...p, email: `${p.user_id}@keepsake.test`, password_hash })));

const base = (m) => ({ supersedes: null, flagged: false, expires_at: null, embedding: [], created_at: now, ...m });

const margaret = [
  // routines
  { text: "Ravi visits on weekday mornings at 10", kind: "routine", scope: "caregiver", status: "verified", source: anna },
  { text: "Margaret takes her morning tea with milk, no sugar, around 8", kind: "routine", scope: "caregiver", status: "verified", source: anna },
  { text: "Anna calls every evening around 7", kind: "routine", scope: "family", status: "verified", source: anna },
  // the wrong one: corrected in the demo to every second week
  { text: "Physio visit is every Tuesday at 2pm", kind: "routine", scope: "caregiver", status: "verified", source: anna, demo_tag: "physio_wrong" },

  // events
  { text: "Anna is bringing dinner today at 6pm", kind: "event", scope: "family", status: "verified", source: anna, expires_at: tonight },
  // expires a few minutes after seeding so TTL removes it during the demo
  { text: "Neighbour Joan is dropping off library books this morning", kind: "event", scope: "caregiver", status: "verified", source: anna, expires_at: inMinutes(5), demo_tag: "expiring" },
  { text: "Grandson Leo's birthday party is next Saturday", kind: "event", scope: "family", status: "verified", source: anna, expires_at: inMinutes(60 * 24 * 8) },

  // facts
  { text: "Margaret's husband George passed away in 2022", kind: "fact", scope: "family", status: "verified", source: anna, demo_tag: "husband" },
  { text: "Margaret has lived at 14 Elm Street since 2019", kind: "fact", scope: "family", status: "verified", source: anna },
  { text: "Spare house key is in the blue bowl by the front door", kind: "fact", scope: "caregiver", status: "verified", source: anna },
  { text: "Reading glasses are usually on the kitchen windowsill", kind: "fact", scope: "caregiver", status: "verified", source: ravi },

  // preferences
  { text: "Margaret likes looking at the photo album from the 1998 Lisbon trip", kind: "preference", scope: "caregiver", status: "verified", source: anna },
  { text: "Margaret prefers the radio on CBC Music in the afternoon", kind: "preference", scope: "caregiver", status: "verified", source: ravi },

  // private: family and caregiver can't see it
  { text: "I want to give my mother's ring to Leo, not to Anna", kind: "preference", scope: "private", status: "verified", source: marg, demo_tag: "private" },

  // family-only note Ravi must not see
  { text: "Anna and her brother are discussing whether Margaret should move to assisted living", kind: "fact", scope: "family", status: "verified", source: anna, demo_tag: "family_only" },

  // unverified, from Margaret, already flagged
  { text: "Margaret said her sister Ruth visited yesterday", kind: "event", scope: "family", status: "unverified", flagged: true, source: marg, expires_at: inMinutes(60 * 24 * 3) }
].map(m => base({ person_id: "margaret", ...m }));

const harold = [
  { text: "Harold's son Sam visits on Sunday afternoons", kind: "routine", scope: "family", status: "verified", source: sam },
  { text: "Harold's physio is on Thursdays at 11am", kind: "routine", scope: "caregiver", status: "verified", source: sam },
  { text: "Harold keeps his hearing aids in the bedside drawer", kind: "fact", scope: "caregiver", status: "verified", source: sam }
].map(m => base({ person_id: "harold", ...m }));

const ids = db.memories.insertMany([...margaret, ...harold]).insertedIds;
const husband = db.memories.findOne({ demo_tag: "husband" });

db.topic_guidance.insertOne({
  person_id: "margaret",
  topic: "husband",
  guidance: "Answer factually and gently from her memories: George passed away in 2022. Keep it short, don't add details, then offer the Lisbon photo album.",
  related_memory_ids: [husband._id],
  set_by: "anna",
  updated_at: now
});

print(`Seeded ${Object.keys(ids).length} memories.`);
