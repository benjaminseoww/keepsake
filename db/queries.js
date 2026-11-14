// Reference queries for the memory service.

// Which scopes each role may read. Applied inside $vectorSearch, never after.
const SCOPES = {
  person:    ["private", "family", "caregiver"],
  family:    ["family", "caregiver"],
  caregiver: ["caregiver"]
};

// Role-scoped retrieval. qv is the query embedding (1024 dims).
function retrieve(personId, role, qv, limit = 8) {
  return db.memories.aggregate([
    { $vectorSearch: {
        index: "memory_vec",
        path: "embedding",
        queryVector: qv,
        numCandidates: 100,
        limit,
        filter: {
          person_id: personId,
          scope:  { $in: SCOPES[role] },
          status: { $in: ["verified", "unverified"] }
        }
    }},
    { $project: { text: 1, scope: 1, status: 1, score: { $meta: "vectorSearchScore" } } }
  ]).toArray();
}

// Fallback while the vector index builds: same filter, text match instead of vectors.
function retrieveFallback(personId, role, q) {
  return db.memories.find({
    person_id: personId,
    scope:  { $in: SCOPES[role] },
    status: { $in: ["verified", "unverified"] },
    text:   { $regex: q, $options: "i" }
  }).toArray();
}

// Versioned correction: new doc points to the old one, old one drops out of retrieval.
function correct(oldId, newText, actor) {
  const old = db.memories.findOne({ _id: oldId });
  const { _id, ...rest } = old;
  const newId = db.memories.insertOne({
    ...rest, text: newText, status: "verified", supersedes: oldId,
    source: actor, flagged: false, embedding: [], created_at: new Date()
  }).insertedId;
  db.memories.updateOne({ _id: oldId }, { $set: { status: "superseded" } });
  db.audit_log.insertOne({ memory_id: newId, action: "correct", actor, old_id: oldId, new_id: newId, at: new Date() });
  return newId;
}

// Forget: delete content and embedding, keep a content-free audit row.
function forget(id, actor) {
  db.memories.deleteOne({ _id: id });
  db.audit_log.insertOne({ memory_id: id, action: "forget", actor, old_id: id, new_id: null, at: new Date() });
}
