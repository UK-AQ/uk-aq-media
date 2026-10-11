-- UK AQ Media research catalogue and shared, editorially managed topics.
-- Additive migration only: preserve media_articles, its legacy topics_json and status.
-- 0043 is reserved for the research-news publisher PR; no source data is rewritten here.

CREATE TABLE research_papers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  canonical_title TEXT NOT NULL CHECK (length(trim(canonical_title)) BETWEEN 1 AND 1000),
  abstract TEXT,
  authors_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(authors_json) AND json_type(authors_json) = 'array'),
  subjects_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(subjects_json) AND json_type(subjects_json) = 'array'),
  countries_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(countries_json) AND json_type(countries_json) = 'array'),
  canonical_paper_url TEXT,
  open_access_url TEXT,
  first_published_at TEXT,
  editorial_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (editorial_status IN ('pending','approved','rejected','hidden')),
  discovered_from TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX research_papers_publication_order
  ON research_papers(editorial_status, first_published_at DESC, id DESC);

CREATE TABLE research_paper_publications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id INTEGER NOT NULL REFERENCES research_papers(id) ON DELETE RESTRICT,
  version_type TEXT NOT NULL CHECK (version_type IN ('preprint','accepted','final')),
  doi_normalized TEXT COLLATE NOCASE UNIQUE
    CHECK (doi_normalized IS NULL OR (doi_normalized = lower(doi_normalized) AND doi_normalized GLOB '10.*/*')),
  publication_url TEXT NOT NULL,
  venue TEXT,
  publisher TEXT,
  first_online_date TEXT,
  issue_date TEXT,
  source_name TEXT,
  discovered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX research_paper_publications_paper
  ON research_paper_publications(paper_id, first_online_date DESC, id DESC);

CREATE TABLE topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (slug = lower(slug) AND length(slug) BETWEEN 1 AND 100),
  name TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(trim(name)) BETWEEN 1 AND 150),
  description TEXT,
  parent_topic_id INTEGER REFERENCES topics(id) ON DELETE RESTRICT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (parent_topic_id IS NULL OR parent_topic_id <> id)
);
CREATE INDEX topics_active_order ON topics(is_active, display_order, name);
CREATE INDEX topics_parent ON topics(parent_topic_id);
-- D1 migrations do not reliably handle semicolons within CREATE TRIGGER bodies.
-- Parent cycles are prevented by the atomic recursive guard in the admin API,
-- while the table CHECK constraint continues to block direct self-parenting.
-- Never issue hierarchy mutations outside that guarded API.


-- Old merged URLs remain addressable without becoming selectable topics.
CREATE TABLE topic_slug_aliases (
  slug TEXT PRIMARY KEY COLLATE NOCASE,
  topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX topic_slug_aliases_target ON topic_slug_aliases(topic_id);

CREATE TABLE media_article_topics (
  article_id INTEGER NOT NULL REFERENCES media_articles(id) ON DELETE CASCADE,
  topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE RESTRICT,
  assignment_source TEXT NOT NULL DEFAULT 'manual' CHECK (assignment_source IN ('manual','discovery','ai')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (article_id, topic_id)
);
CREATE INDEX media_article_topics_by_topic ON media_article_topics(topic_id, article_id);

CREATE TABLE research_paper_topics (
  paper_id INTEGER NOT NULL REFERENCES research_papers(id) ON DELETE CASCADE,
  topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE RESTRICT,
  assignment_source TEXT NOT NULL DEFAULT 'manual' CHECK (assignment_source IN ('manual','discovery','ai')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (paper_id, topic_id)
);
CREATE INDEX research_paper_topics_by_topic ON research_paper_topics(topic_id, paper_id);

CREATE TABLE media_article_research_papers (
  article_id INTEGER NOT NULL REFERENCES media_articles(id) ON DELETE CASCADE,
  paper_id INTEGER NOT NULL REFERENCES research_papers(id) ON DELETE RESTRICT,
  relationship TEXT NOT NULL DEFAULT 'reports_on'
    CHECK (relationship IN ('reports_on','cites','discusses','critiques')),
  provenance TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (article_id, paper_id)
);
CREATE INDEX media_article_research_papers_by_paper
  ON media_article_research_papers(paper_id, article_id);
