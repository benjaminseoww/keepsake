// Run with: mongosh "$MONGODB_URI/$MONGODB_DB" db/create_vector_index.js
// Re-run after schema.js: dropping memories also drops its search indexes.
const f = JSON.parse(fs.readFileSync("db/vector_index.json", "utf8"));
if (!db.memories.getSearchIndexes().some(i => i.name === f.name)) {
  db.memories.createSearchIndex({ name: f.name, type: f.type, definition: f.definition });
}
printjson(db.memories.getSearchIndexes().map(i => ({ name: i.name, status: i.status })));
