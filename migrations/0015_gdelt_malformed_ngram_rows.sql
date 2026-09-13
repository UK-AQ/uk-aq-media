ALTER TABLE media_gdelt_files
  ADD COLUMN malformed_ngram_rows INTEGER NOT NULL DEFAULT 0 CHECK (malformed_ngram_rows >= 0);
