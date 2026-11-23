CREATE TABLE corpus_publication_guard (
  corpus_id TEXT PRIMARY KEY NOT NULL,
  generation INTEGER NOT NULL CHECK(generation > 0),
  target_commit TEXT,
  target_date TEXT,
  vector_mutation TEXT,
  completion_json TEXT,
  CHECK((target_commit IS NULL) = (target_date IS NULL)),
  CHECK(target_commit IS NOT NULL OR vector_mutation IS NULL),
  CHECK(vector_mutation IS NOT NULL OR completion_json IS NULL)
);
