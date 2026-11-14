// Run with: mongosh "$MONGODB_URI/keepsake" db/schema.js
// Creates collections, schema validation and regular indexes.
// The vector index is created separately in Atlas (see vector_index.json).
//
// Schema versioning: every doc carries schema_version (int). Docs without it are v0 (pre-versioning).
// Bump the number here, in seed.py and in queries.js when a collection's shape changes,
// and add a migration under db/migrations that upgrades old docs.
// Current: memories 1, people 1, households 1, audit_log 1, turns 1.
const SV = { bsonType: ["int", "long"], minimum: 1 };

const drop = (name) => { if (db.getCollectionNames().includes(name)) db[name].drop(); };
// people is not dropped: it holds logins (auth only).
["memories", "households", "audit_log", "replay_runs", "turns"].forEach(drop);

db.createCollection("memories", {
  validator: { $jsonSchema: {
    bsonType: "object",
    required: ["schema_version", "person_id", "text", "scope", "status", "source", "created_at"],
    properties: {
      schema_version: SV,
      person_id:  { bsonType: "string" },
      text:       { bsonType: "string" },
      scope:      { enum: ["family", "caregiver"] },
      status:     { enum: ["unverified", "verified", "superseded", "retracted"] },
      source: {
        bsonType: "object",
        required: ["user_id", "name", "role"],
        properties: {
          user_id: { bsonType: "string" },
          name:    { bsonType: "string" },
          role:    { enum: ["person", "family", "caregiver"] }
        }
      },
      supersedes: { bsonType: ["objectId", "null"] },
      flagged:    { bsonType: "bool" },
      expires_at: { bsonType: ["date", "null"] },  // legacy, no longer written (no expiry)
      // Optional dates resolved by validate.ts (A17/A18). Recall never filters on them (A10).
      event_start: { bsonType: "date" },
      event_end:   { bsonType: "date" },
      embedding:  { bsonType: "array" },      // voyage-3.5, 1024 dims
      key:        { bsonType: "string" },   // stable seed key, used by tests
      review: {
        // Present on anything that needs a family decision.
        bsonType: "object",
        required: ["state"],
        properties: {
          state: { enum: ["pending", "approved", "denied"] },
          // The memory this one would replace. Set by the system, not by a person.
          proposed_supersedes: { bsonType: ["objectId", "null"] },
          // What the system found, and whether the new memory supersedes each candidate.
          candidates: {
            bsonType: "array",
            maxItems: 10,
            items: {
              bsonType: "object",
              required: ["memory_id", "supersedes"],
              properties: {
                memory_id:    { bsonType: "objectId" },
                supersedes:   { bsonType: "bool" },
                rerank_score: { bsonType: ["double", "int", "null"] }
              }
            }
          },
          decided_by: { bsonType: ["string", "null"] },
          decided_at: { bsonType: ["date", "null"] }
        }
      },
      created_at: { bsonType: "date" }
    }
  }},
  validationAction: "error"
});

// No TTL index: memories don't expire. Time-bound facts carry their date in the text.
db.memories.createIndex({ person_id: 1, status: 1, flagged: 1 });
// Family review queue: pending items for a household, newest first.
db.memories.createIndex({ person_id: 1, "review.state": 1, created_at: -1 });

// people: auth only. Roles live in households.members, so the two can't disagree.
// Created only if missing, so re-running this file keeps existing logins.
if (!db.getCollectionNames().includes("people")) {
  db.createCollection("people", {
    validator: { $jsonSchema: {
      bsonType: "object",
      required: ["schema_version", "user_id", "email", "password_hash"],
      properties: {
        schema_version: SV,
        user_id:       { bsonType: "string" },
        name:          { bsonType: "string" },
        email:         { bsonType: "string" },
        password_hash: { bsonType: "string" }
      }
    }},
    validationAction: "error"
  });
}
db.people.createIndex({ user_id: 1 }, { unique: true });
db.people.createIndex({ email: 1 }, { unique: true });

// One doc per household: the person plus everyone who helps them.
// Read together with every role check, so stored together.
db.createCollection("households", {
  validator: { $jsonSchema: {
    bsonType: "object",
    required: ["schema_version", "person_id", "members"],
    properties: {
      schema_version: SV,
      person_id: { bsonType: "string" },
      members: {
        bsonType: "array",
        minItems: 1,
        maxItems: 50,   // bounded array
        items: {
          bsonType: "object",
          required: ["user_id", "name", "role"],
          properties: {
            user_id: { bsonType: "string" },
            name:    { bsonType: "string" },
            role:    { enum: ["person", "family", "caregiver"] },
            admin:   { bsonType: "bool" }
          }
        }
      }
    }
  }},
  validationAction: "error"
});
// One household per person.
db.households.createIndex({ person_id: 1 }, { unique: true });
// Login lookup: user_id -> household + role. Unique so a user can't sit in two households.
db.households.createIndex({ "members.user_id": 1 }, { unique: true });

// audit_log has no text field, so forgotten content never lands here.
db.createCollection("audit_log", {
  validator: { $jsonSchema: {
    bsonType: "object",
    required: ["schema_version", "memory_id", "action", "actor", "at"],
    properties: {
      schema_version: SV,
      action: { enum: ["write", "verify", "correct", "approve", "deny", "forget", "expire", "rescope"] },
      actor: {
        bsonType: "object",
        required: ["user_id", "name", "role"],
        properties: {
          user_id: { bsonType: "string" },
          name:    { bsonType: "string" },
          role:    { enum: ["person", "family", "caregiver", "system"] }
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

// turns: one doc per recall, read by the trace screen. Validator and index live in the migration.
load("db/migrations/005_turns.js");
load("db/migrations/007_topic_guidance.js");

print("Schema ready.");
