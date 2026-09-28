-- Mums for Lungs pages do not display article bylines, so discovery must not retain
-- RSS creator values for this source. The discovery code enforces the same source rule
-- for all future observations. Preserve editorial state and timestamps while normalising
-- existing rows.
UPDATE media_articles
SET author = NULL
WHERE source_key = 'mums-for-lungs'
  AND author IS NOT NULL;
