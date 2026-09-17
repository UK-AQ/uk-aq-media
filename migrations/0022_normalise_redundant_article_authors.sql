-- A publication name is not useful article-byline metadata. This is metadata
-- normalisation only, so preserve editorial state, revisions, events and timestamps.
UPDATE media_articles
SET author = NULL
WHERE author IS NOT NULL
  AND lower(trim(author)) = lower(trim(publisher));
