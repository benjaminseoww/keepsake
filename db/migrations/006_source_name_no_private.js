// A15 + A17: memories.source and audit_log.actor require {user_id, name, role};
// scope is family | caregiver (no private).
// Run after Ben's 005. Do not depend on anything that migration adds.
// Order: backfill names, refuse to proceed if any name is still missing or any
// memory has scope "private" (abort with counts; do not convert private docs),
// then collMod both validators. Safe to re-run.
//   mongosh "$MONGODB_URI/$MONGODB_DB" --quiet db/migrations/006_source_name_no_private.js

const names = {};
db.households.find().forEach(h => h.members.forEach(m => { names[m.user_id] = m.name; }));

function backfill(coll, field) {
  const filter = {};
  filter[field + ".name"] = { $exists: false };
  let ok = 0, skipped = 0;
  db[coll].find(filter).forEach(d => {
    const rec = field === "source" ? d.source : d.actor;
    const name = rec && names[rec.user_id];
    if (!name) { skipped++; return; }
    const set = {};
    set[field + ".name"] = name;
    db[coll].updateOne({ _id: d._id }, { $set: set });
    ok++;
  });
  const stillFilter = {};
  stillFilter[field + ".name"] = { $exists: false };
  const still = db[coll].countDocuments(stillFilter);
  print(`${coll}.${field}.name: set ${ok}, skipped ${skipped} (no matching household name), still missing ${still}`);
  return still;
}

const memLeft = backfill("memories", "source");
const audLeft = backfill("audit_log", "actor");
const privateCount = db.memories.countDocuments({ scope: "private" });
if (privateCount) {
  print(`Aborting collMod: ${privateCount} memories still have scope "private". This migration will not convert them. Delete or re-scope them first.`);
}
if (memLeft || audLeft) {
  print("Aborting collMod: backfill left docs without name. Fix those first.");
}
if (memLeft || audLeft || privateCount) {
  quit(1);
}

function applyValidators() {
  const mem = db.getCollectionInfos({ name: "memories" })[0].options.validator.$jsonSchema;
  mem.properties.scope.enum = ["family", "caregiver"];
  const src = mem.properties.source;
  src.required = ["user_id", "name", "role"];
  src.properties.name = { bsonType: "string" };
  // Optional dates from validate.ts (A17/A18), same as db/schema.js. Not required.
  mem.properties.event_start = { bsonType: "date" };
  mem.properties.event_end = { bsonType: "date" };
  db.runCommand({ collMod: "memories", validator: { $jsonSchema: mem }, validationLevel: "strict", validationAction: "error" });
  print("memories validator: scope is family|caregiver; source requires name; event_start/event_end are dates");

  const aud = db.getCollectionInfos({ name: "audit_log" })[0].options.validator.$jsonSchema;
  const actor = aud.properties.actor;
  actor.required = ["user_id", "name", "role"];
  actor.properties.name = { bsonType: "string" };
  db.runCommand({ collMod: "audit_log", validator: { $jsonSchema: aud }, validationLevel: "strict", validationAction: "error" });
  print("audit_log validator: actor requires name");
}

applyValidators();
