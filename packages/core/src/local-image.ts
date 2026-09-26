export const MAX_LOCAL_IMAGE_BYTES = 5 * 1024 * 1024;

export const LOCAL_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type LocalImageContentType = typeof LOCAL_IMAGE_TYPES[number];
export type LocalImageAcquisitionMethod = 'publisher_fetch' | 'admin_upload';

export type LocalImageRow = {
  article_id: number;
  object_key: string;
  source_image_url: string;
  source_image_url_hash: string;
  content_sha256: string;
  content_type: LocalImageContentType;
  byte_size: number;
  acquisition_method: LocalImageAcquisitionMethod;
  stored_at: string;
  updated_at: string;
};

export type LocalImagePolicyIdentity = {
  og_image_url: string | null;
  article_image_policy: string;
  source_image_policy: string;
};

export type ValidatedLocalImage = {
  bytes: Uint8Array;
  contentType: LocalImageContentType;
  extension: 'jpg' | 'png' | 'webp';
  contentSha256: string;
};

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
}

export async function sha256(value: string | BufferSource): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}

export function normaliseLocalImageContentType(value: string | null): LocalImageContentType | null {
  const type = value?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return (LOCAL_IMAGE_TYPES as readonly string[]).includes(type)
    ? type as LocalImageContentType : null;
}

function detectedImageType(bytes: Uint8Array): LocalImageContentType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e &&
      bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a &&
      bytes[7] === 0x0a) return 'image/png';
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 &&
      bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 &&
      bytes[11] === 0x50) return 'image/webp';
  return null;
}

export async function validateLocalImageBytes(bytes: Uint8Array,
  declaredContentType: string | null): Promise<ValidatedLocalImage> {
  if (bytes.byteLength < 1) throw new Error('image_empty');
  if (bytes.byteLength > MAX_LOCAL_IMAGE_BYTES) throw new Error('image_too_large');
  const contentType = normaliseLocalImageContentType(declaredContentType);
  if (!contentType) throw new Error('invalid_image_content_type');
  const detected = detectedImageType(bytes);
  if (!detected || detected !== contentType) throw new Error('image_signature_mismatch');
  const extension = detected === 'image/jpeg' ? 'jpg'
    : detected === 'image/png' ? 'png' : 'webp';
  return { bytes, contentType: detected, extension,
    contentSha256: await sha256(bytes) };
}

export function localImageObjectKey(articleId: number, image: ValidatedLocalImage): string {
  return `article-images/${articleId}/${image.contentSha256}.${image.extension}`;
}

export function localCopyPolicyPermitted(identity: LocalImagePolicyIdentity): boolean {
  return identity.article_image_policy === 'local_copy_permitted' &&
    identity.source_image_policy === 'local_copy_permitted' && identity.og_image_url !== null;
}

export function currentLocalImage(identity: LocalImagePolicyIdentity,
  row: LocalImageRow | null): LocalImageRow | null {
  return localCopyPolicyPermitted(identity) && row &&
    row.source_image_url === identity.og_image_url ? row : null;
}

export async function readBoundedImageResponse(response: Pick<Response, 'headers' | 'body'>): Promise<Uint8Array> {
  const declared = response.headers.get('Content-Length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_LOCAL_IMAGE_BYTES) {
    await response.body?.cancel();
    throw new Error('image_too_large');
  }
  if (!response.body) throw new Error('image_missing_body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_LOCAL_IMAGE_BYTES) throw new Error('image_too_large');
      chunks.push(value);
    }
  } finally {
    try { await reader.cancel(); } catch { /* best effort */ }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export async function storeLocalImage(db: D1Database, bucket: R2Bucket,
  input: { articleId: number; articleRevision: number; sourceImageUrl: string;
    articleImagePolicy: string; sourceImagePolicy: string; image: ValidatedLocalImage;
    acquisitionMethod: LocalImageAcquisitionMethod; requestKey?: string }): Promise<LocalImageRow> {
  if (!localCopyPolicyPermitted({ og_image_url: input.sourceImageUrl,
    article_image_policy: input.articleImagePolicy,
    source_image_policy: input.sourceImagePolicy })) throw new Error('local_copy_not_permitted');
  const objectKey = localImageObjectKey(input.articleId, input.image);
  const sourceHash = await sha256(input.sourceImageUrl);
  const previous = await db.prepare(`SELECT * FROM media_article_local_images WHERE article_id = ?`)
    .bind(input.articleId).first<LocalImageRow>();
  const existingObject = await bucket.head(objectKey);
  if (!existingObject) {
    await bucket.put(objectKey, input.image.bytes, { httpMetadata: { contentType: input.image.contentType },
      customMetadata: { content_sha256: input.image.contentSha256 } });
  }
  const now = new Date().toISOString();
  const guards = `SELECT a.id, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM media_articles a
    JOIN media_sources s ON s.source_key = a.source_key
    WHERE a.id = ? AND a.revision = ? AND a.og_image_url = ?
      AND a.image_policy = 'local_copy_permitted'
      AND s.image_policy = 'local_copy_permitted'`;
  const pointer = db.prepare(`INSERT INTO media_article_local_images
      (article_id, object_key, source_image_url, source_image_url_hash, content_sha256,
       content_type, byte_size, acquisition_method, stored_at, updated_at)
    ${guards}
    ON CONFLICT(article_id) DO UPDATE SET object_key = excluded.object_key,
      source_image_url = excluded.source_image_url,
      source_image_url_hash = excluded.source_image_url_hash,
      content_sha256 = excluded.content_sha256, content_type = excluded.content_type,
      byte_size = excluded.byte_size, acquisition_method = excluded.acquisition_method,
      stored_at = excluded.stored_at, updated_at = excluded.updated_at`)
    .bind(objectKey, input.sourceImageUrl, sourceHash, input.image.contentSha256,
      input.image.contentType, input.image.bytes.byteLength, input.acquisitionMethod, now, now,
      input.articleId, input.articleRevision, input.sourceImageUrl);
  const statements: D1PreparedStatement[] = [];
  if (input.requestKey) {
    statements.push(db.prepare(`INSERT INTO media_article_local_image_operations
        (request_key, article_id, operation, article_revision, source_image_url_hash,
         content_sha256, created_at)
      ${`SELECT ?, a.id, 'upload', a.revision, ?, ?, ? FROM media_articles a
        JOIN media_sources s ON s.source_key = a.source_key
        WHERE a.id = ? AND a.revision = ? AND a.og_image_url = ?
          AND a.image_policy = 'local_copy_permitted'
          AND s.image_policy = 'local_copy_permitted'`}`)
      .bind(input.requestKey, sourceHash, input.image.contentSha256, now,
        input.articleId, input.articleRevision, input.sourceImageUrl));
  }
  statements.push(pointer);
  statements.push(db.prepare(`UPDATE media_articles SET revision = revision + 1, updated_at = ?
    WHERE id = ? AND revision = ? AND EXISTS (
      SELECT 1 FROM media_article_local_images
      WHERE article_id = ? AND object_key = ? AND source_image_url = ?)`)
    .bind(now, input.articleId, input.articleRevision, input.articleId, objectKey,
      input.sourceImageUrl));
  await db.batch(statements);
  if (input.requestKey) {
    const operation = await db.prepare(`SELECT request_key
      FROM media_article_local_image_operations WHERE request_key = ?`)
      .bind(input.requestKey).first();
    if (!operation) throw new Error('local_image_stale_write');
  }
  const stored = await db.prepare(`SELECT * FROM media_article_local_images
    WHERE article_id = ? AND object_key = ? AND source_image_url = ?
      AND EXISTS (SELECT 1 FROM media_articles WHERE id = ? AND revision = ?)`)
    .bind(input.articleId, objectKey, input.sourceImageUrl, input.articleId,
      input.articleRevision + 1).first<LocalImageRow>();
  if (!stored) throw new Error('local_image_stale_write');
  if (previous && previous.object_key !== objectKey) {
    try { await bucket.delete(previous.object_key); }
    catch { /* unreachable orphan is safe after the pointer changes */ }
  }
  return stored;
}
