export const HOMEPAGE_LATEST_SIX_SCOPE = 'homepage_latest_6';

export type HomepageLatestSixState = {
  generation: number;
  snapshot_json: string;
  updated_at: string;
};

export type HomepageLatestSixSnapshotRow = {
  id: number;
  canonical_url: string;
  title: string;
  display_title: string | null;
  publisher: string;
  published_at: string | null;
  preview_image_url: string | null;
};

export function homepageLatestSixSnapshot(rows: readonly HomepageLatestSixSnapshotRow[]): string {
  return JSON.stringify(rows.map(row => ({
    id: row.id,
    canonical_url: row.canonical_url,
    title: row.title,
    display_title: row.display_title,
    publisher: row.publisher,
    published_at: row.published_at,
    preview_image_url: row.preview_image_url,
  })));
}

export function reconciledHomepageLatestSixState(previous: HomepageLatestSixState,
  rows: readonly HomepageLatestSixSnapshotRow[], updatedAt: string): HomepageLatestSixState {
  const snapshot_json = homepageLatestSixSnapshot(rows);
  return snapshot_json === previous.snapshot_json ? previous : {
    generation: previous.generation + 1,
    snapshot_json,
    updated_at: updatedAt,
  };
}

const HOMEPAGE_SNAPSHOT_CTE = `
  WITH latest_six AS (
    SELECT a.id, a.canonical_url, a.title, a.display_title, a.publisher, a.published_at, a.feed_sort_at,
      CASE WHEN a.image_policy = 'remote_preview' AND s.image_policy = 'remote_preview'
        THEN a.og_image_url ELSE NULL END AS preview_image_url
    FROM media_articles a JOIN media_sources s ON s.source_key = a.source_key
    WHERE a.status = 'approved'
    ORDER BY a.feed_sort_at DESC, a.id DESC LIMIT 6
  ), snapshot AS (
    SELECT coalesce(json_group_array(json_object(
      'id', id,
      'canonical_url', canonical_url,
      'title', title,
      'display_title', display_title,
      'publisher', publisher,
      'published_at', published_at,
      'preview_image_url', preview_image_url
    )), '[]') AS snapshot_json
    FROM (SELECT * FROM latest_six ORDER BY feed_sort_at DESC, id DESC)
  )`;

const RECONCILE_HOMEPAGE_LATEST_SIX_SQL = `${HOMEPAGE_SNAPSHOT_CTE}
  INSERT INTO media_public_feed_state (scope, generation, snapshot_json, updated_at)
  SELECT '${HOMEPAGE_LATEST_SIX_SCOPE}', 1, snapshot_json, ? FROM snapshot
  ON CONFLICT(scope) DO UPDATE SET
    generation = media_public_feed_state.generation + 1,
    snapshot_json = excluded.snapshot_json,
    updated_at = excluded.updated_at
  WHERE media_public_feed_state.snapshot_json IS NOT excluded.snapshot_json`;

export async function homepageLatestSixState(db: D1Database): Promise<HomepageLatestSixState> {
  const state = await db.prepare(`SELECT generation, snapshot_json, updated_at
    FROM media_public_feed_state WHERE scope = ?`).bind(HOMEPAGE_LATEST_SIX_SCOPE)
    .first<HomepageLatestSixState>();
  if (!state || !Number.isSafeInteger(state.generation) || state.generation < 1) {
    throw new Error('homepage_latest_six_state_unavailable');
  }
  return state;
}

// SQLite obtains the write lock before this conditional UPSERT evaluates its snapshot CTE.
// The statement therefore cannot commit an older snapshot over a newer reconciliation.
export async function reconcileHomepageLatestSix(db: D1Database): Promise<HomepageLatestSixState> {
  await db.prepare(RECONCILE_HOMEPAGE_LATEST_SIX_SQL).bind(new Date().toISOString()).run();
  return homepageLatestSixState(db);
}
