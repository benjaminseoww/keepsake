// A15: memories.source and audit_log.actor require {user_id, name, role}.
// Backfill name from households.members, then tighten the validators.
// Run AFTER the backfill succeeds, never collMod first (strict validation
// would reject later updates to docs that still lack name).
//   mongosh "$MONGODB_URI/$MONGODB_DB" --quiet db/migrations/005_source_name.js
// Do not run this until that step is approved; existing Atlas docs have no name.

const names = {};
db.households.find().forEach(h => h.members.forEach(m => { names[m.user_id] = m.name; }));

function backfill(coll, field) {
  const missing = db[coll].find({ [field + ".name"]: { $exists: false } });
  let ok = 0, skipped = 0;
  missing.forEach(d => {
    const rec = field === "source" ? d.source : d.actor;
    const name = rec && names[rec.user_id];
    if (!name) { skipped++; return; }
    db[coll].updateOne({ _id: d._id }, { $set: { [field + ".name"]: name } });
    ok++;
  });
  print(`${coll}.${field}.name: set ${ok}, skipped ${skipped} (no matching household name)`);
  const still = db[coll].countDocuments({ [field + ".name"]: { $exists: false } });
  print(`${coll} still missing ${field}.name: ${still}`);
  return still;
}

const memLeft = backfill("memories", "source");
const audLeft = backfill("audit_log", "actor");
if (memLeft || audLeft) {
  print("Aborting collMod: backfill left docs without name. Fix those first.");
  quit(1);
}

function requireName(coll, path) {
  const info = db.getCollectionInfos({ name: coll })[0];
  const js = info.options.validator.$jsonSchema;
  const obj = path.split(".").reduce((o, k) => o.properties[k], js);
  obj.required = ["user_id", "name", "role"];
  obj.properties.name = { bsonType: "string" };
  db.runCommand({ collMod: coll, validator: { $jsonSchema: js }, validationLevel: "strict", validationAction: "error" });
  print(`${coll} validator now requires ${path}.name`);
}

requireName("memories", "source");
requireName("audit_log", "actor");
