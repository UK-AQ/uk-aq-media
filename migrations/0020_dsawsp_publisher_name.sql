UPDATE media_sources
SET name = 'DSAWSP',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE source_key = 'dsawsp';

UPDATE media_articles
SET publisher = 'DSAWSP',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE source_key = 'dsawsp';