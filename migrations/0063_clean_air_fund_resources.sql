-- Add Clean Air Fund Resources as a second, bounded index route.
-- Guard the update so operator-modified source configuration remains authoritative.
UPDATE media_sources
SET discovery_config_json = json_set(discovery_config_json, '$.routes',
    json_array(
      json_object('route_key', 'clean-air-fund-news',
        'url', 'https://www.cleanairfund.org/news/', 'max_items', 20),
      json_object('route_key', 'clean-air-fund-resources',
        'url', 'https://www.cleanairfund.org/resources/', 'max_items', 20)
    )),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE source_key = 'clean-air-fund'
  AND json_valid(discovery_config_json)
  AND json_array_length(discovery_config_json, '$.routes') = 1
  AND json_extract(discovery_config_json, '$.routes[0].route_key') = 'clean-air-fund-news'
  AND json_extract(discovery_config_json, '$.routes[0].url') = 'https://www.cleanairfund.org/news/'
  AND json_extract(discovery_config_json, '$.routes[0].max_items') = 20
  AND json_extract(discovery_config_json, '$.retain_excerpt') = 0;
