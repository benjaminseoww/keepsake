// people becomes auth only: user_id, name, email, password_hash.
// Roles and household membership live in households.members. Keeps existing logins.
// Run with: mongosh "$MONGODB_URI/$MONGODB_DB" db/migrations/002_people_auth.js

const PEOPLE_VALIDATOR = {
  $jsonSchema: {
    bsonType: "object",
    required: ["user_id", "email", "password_hash"],
    properties: {
      user_id:       { bsonType: "string" },
      name:          { bsonType: "string" },
      email:         { bsonType: "string" },
      password_hash: { bsonType: "string" }
    }
  }
};

if (!db.getCollectionNames().includes("people")) {
  db.createCollection("people", { validator: PEOPLE_VALIDATOR, validationAction: "error" });
} else {
  const r = db.people.updateMany({}, { $unset: { role: "", person_id: "", relation: "", admin: "", shift: "" } });
  print(`Stripped role fields from ${r.modifiedCount} people docs.`);
  db.runCommand({ collMod: "people", validator: PEOPLE_VALIDATOR, validationAction: "error" });
}

// Unique logins. Drop non-unique versions first if a teammate created them.
for (const field of ["user_id", "email"]) {
  const existing = db.people.getIndexes().find(i => i.name === `${field}_1`);
  if (existing && !existing.unique) db.people.dropIndex(`${field}_1`);
  db.people.createIndex({ [field]: 1 }, { unique: true });
}

printjson(db.people.getIndexes().map(i => ({ name: i.name, unique: !!i.unique })));
printjson(db.people.find({}, { password_hash: 0 }).toArray());
