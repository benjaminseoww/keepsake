// Run with: mongosh "$MONGODB_URI/keepsake" db/schema.js
// Creates collections, schema validation and regular indexes.
// The vector index is created separately in Atlas (see vector_index.json).

const drop = (name) => { if (db.getCollectionNames().includes(name)) db[name].drop(); };
["memories", "people", "audit_log", "replay_runs"].forEach(drop);

db.createCollection("memories", {
  validator: { $jsonSchema: {
    bsonType: "object",
    required: ["person_id", "text", "scope", "status", "source", "created_at"],
    properties: {
      person_id:  { bsonType: "string" },
      text:       { bsonType: "string" },
      scope:      { enum: ["private", "family", "caregiver"] },
      status:     { enum: ["unverified", "verified", "superseded", "retracted"] },
      source: {
        bsonType: "object",
        required: ["role", "user_id"],
        properties: {
          role:    { enum: ["person", "family", "caregiver"] },
          user_id: { bsonType: "string" }
        }
      },
      supersedes: { bsonType: ["objectId", "null"] },
      flagged:    { bsonType: "bool" },
      expires_at: { bsonType: ["date", "null"] },
      embedding:  { bsonType: "array" },      // voyage-3.5, 1024 dims
      created_at: { bsonType: "date" }
    }
  }},
  validationAction: "error"
});

// TTL: deletes a memory once expires_at passes. Docs with null expires_at are ignored.
db.memories.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
db.memories.createIndex({ person_id: 1, status: 1, flagged: 1 });

db.createCollection("people");
db.people.createIndex({ user_id: 1 }, { unique: true });

// audit_log has no text field, so forgotten content never lands here.
db.createCollection("audit_log", {
  validator: { $jsonSchema: {
    bsonType: "object",
    required: ["memory_id", "action", "actor", "at"],
    properties: {
      action: { enum: ["write", "verify", "correct", "forget", "expire", "rescope"] },
      actor: {
        bsonType: "object",
        required: ["role", "user_id"],
        properties: {
          role:    { enum: ["person", "family", "caregiver", "system"] },
          user_id: { bsonType: "string" }
        }
      },
      old_id: { bsonType: ["objectId", "null"] },
      new_id: { bsonType: ["objectId", "null"] },
      at:     { bsonType: "date" }
    }
  }}
});
db.audit_log.createIndex({ memory_id: 1, at: -1 });

db.createCollection("replay_runs");
db.replay_runs.createIndex({ scenario_id: 1 });

print("Schema ready.");
