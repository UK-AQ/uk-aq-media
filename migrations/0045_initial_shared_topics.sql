-- Initial, deliberately small shared topic catalogue approved 11/10/2026.
-- Used by News and Research. This migration does not classify existing articles
-- or alter their legacy topics_json metadata.
-- Stable slugs are part of the public topic-filter API.
INSERT INTO topics (slug, name, description, display_order)
VALUES
  ('uk', 'UK', 'News and research primarily concerning the United Kingdom.', 1),
  ('worldwide', 'Worldwide', 'News and research concerning countries outside the UK or international developments.', 2),
  ('health', 'Health', 'Health effects and public-health impacts of air pollution.', 3),
  ('wood-burning', 'Wood Burning', 'Domestic wood combustion, wood-burning stoves and wood smoke.', 4),
  ('wildfires', 'Wildfires', 'Wildfires and the air-quality impacts of wildfire smoke.', 5),
  ('traffic', 'Traffic', 'Road traffic emissions and associated air pollution.', 6),
  ('monitoring', 'Monitoring', 'Air-quality monitoring, measurements, monitoring networks and sensors.', 7),
  ('research', 'Research', 'Scientific studies, research findings and new evidence about air quality.', 8),
  ('legislation', 'Legislation', 'Air-quality laws, regulation, government policy and enforcement.', 9),
  ('industry', 'Industry', 'Industrial emissions, industrial pollution and related air-quality impacts.', 10)
ON CONFLICT(slug) DO NOTHING;
