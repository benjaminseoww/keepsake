// Restore family-governed topic guidance without dropping legacy documents.
// Run: mongosh "$MONGODB_URI/$MONGODB_DB" db/migrations/007_topic_guidance.js
const guidanceValidator = { $jsonSchema: {
  bsonType: "object",
  required: ["schema_version", "person_id", "topic", "guidance", "set_by", "updated_at"],
  properties: {
    schema_version: { bsonType: ["int", "long"], minimum: 1 },
    person_id: { bsonType: "string" },
    topic: { bsonType: "string", minLength: 1, maxLength: 100 },
    guidance: { bsonType: "string", minLength: 1, maxLength: 2000 },
    set_by: { bsonType: "object", required: ["user_id", "name"], properties: {
      user_id: { bsonType: "string" }, name: { bsonType: "string" }
    } },
    updated_at: { bsonType: "date" }
  }
} };
if (!db.getCollectionNames().includes("topic_guidance")) {
  db.createCollection("topic_guidance");
}
// Update old records individually, preserving their guidance and provenance where present.
db.topic_guidance.find().forEach((g) => {
  const h = db.households.findOne({ person_id: g.person_id });
  const userId = typeof g.set_by === "string" ? g.set_by : g.set_by?.user_id;
  // Not `h?.members.find(...)`: mongosh loses `this` on optional-chained method calls ("this" is null).
  const member = (h ? h.members : []).find((m) => m.user_id === userId);
  const topic = typeof g.topic === "string" ? g.topic.trim().toLowerCase() : g.topic;
  const updated = db.topic_guidance.updateOne({ _id: g._id }, { $set: {
    schema_version: 1, topic,
    set_by: { user_id: userId ?? "", name: g.set_by?.name ?? member?.name ?? "Family" },
    updated_at: g.updated_at instanceof Date ? g.updated_at : new Date()
  } }, { bypassDocumentValidation: true });
  if (!updated.acknowledged) throw new Error("Could not migrate guidance");
});
// Duplicate topics stop migration for manual resolution rather than deleting family guidance.
db.topic_guidance.createIndex({ person_id: 1, topic: 1 }, { unique: true });
const guidanceResult = db.runCommand({ collMod: "topic_guidance", validator: guidanceValidator, validationLevel: "strict", validationAction: "error" });
if (!guidanceResult.ok) throw new Error("Could not set guidance validator");
const auditValidator = db.getCollectionInfos({ name: "audit_log" })[0].options.validator;
const actions = auditValidator.$jsonSchema.properties.action.enum;
if (!actions.includes("guidance")) actions.push("guidance");
const auditResult = db.runCommand({ collMod: "audit_log", validator: auditValidator });
if (!auditResult.ok) throw new Error("Could not enable guidance audit action");
print("Family topic guidance ready.");
