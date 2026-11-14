// Adds schema_version to every collection without dropping anything (keeps the vector index).
// Run: mongosh "$MONGODB_URI/$MONGODB_DB" --quiet db/migrations/003_schema_version.js
// Docs without schema_version are v0. This stamps them as v1, then makes the field required.
// memories, households and audit_log get replaced by seed.py anyway; people keeps its logins.
const SV = { bsonType: ["int", "long"], minimum: 1 };
["memories", "households", "audit_log", "people"].forEach((name) => {
  const res = db[name].updateMany({ schema_version: { $exists: false } }, { $set: { schema_version: NumberInt(1) } });
  const info = db.getCollectionInfos({ name })[0];
  const js = info.options.validator.$jsonSchema;
  if (!js.required.includes("schema_version")) js.required.unshift("schema_version");
  js.properties.schema_version = SV;
  db.runCommand({ collMod: name, validator: { $jsonSchema: js }, validationLevel: "strict", validationAction: "error" });
  print(`${name}: stamped ${res.modifiedCount}, required = ${js.required.join(", ")}`);
});
