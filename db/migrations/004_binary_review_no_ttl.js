// Binary supersede decision (A14) and no expiry (A10). Keeps the vector index.
// Run: mongosh "$MONGODB_URI/$MONGODB_DB" --quiet db/migrations/004_binary_review_no_ttl.js
// 1. review.candidates[].label -> review.candidates[].supersedes (bool)
// 2. drop the TTL index on expires_at and the field on existing memories

// New validator first, at "moderate" so old-shape docs can still be converted.
const js = db.getCollectionInfos({ name: "memories" })[0].options.validator.$jsonSchema;
const items = js.properties.review.properties.candidates.items;
items.required = ["memory_id", "supersedes"];
delete items.properties.label;
items.properties.supersedes = { bsonType: "bool" };
items.properties.rerank_score = { bsonType: ["double", "int", "null"] };
db.runCommand({ collMod: "memories", validator: { $jsonSchema: js }, validationLevel: "moderate", validationAction: "error" });
print("validator updated");

const res = db.memories.updateMany(
  { "review.candidates.label": { $exists: true } },
  [{ $set: { "review.candidates": { $map: {
      input: "$review.candidates", as: "c",
      in: { memory_id: "$$c.memory_id", supersedes: { $eq: ["$$c.label", "supersedes"] }, rerank_score: { $ifNull: ["$$c.rerank_score", null] } }
  } } } }]
);
print(`candidates converted on ${res.modifiedCount} memories`);

db.runCommand({ collMod: "memories", validationLevel: "strict" });
print("validation back to strict");

db.memories.getIndexes().filter(i => i.expireAfterSeconds !== undefined).forEach(i => { db.memories.dropIndex(i.name); print(`dropped TTL index ${i.name}`); });
const un = db.memories.updateMany({ expires_at: { $exists: true } }, { $unset: { expires_at: "" } });
print(`expires_at removed from ${un.modifiedCount} memories`);
