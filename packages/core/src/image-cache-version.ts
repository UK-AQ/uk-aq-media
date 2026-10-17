const IMAGE_VERSION_BYTES = 16;

export async function imageCacheVersion(storedImageUrl: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(storedImageUrl));
  return Array.from(new Uint8Array(digest).slice(0, IMAGE_VERSION_BYTES), byte =>
    byte.toString(16).padStart(2, '0')).join('');
}

export async function versionedArticleImageUrl(origin: string, articleId: number,
  storedImageUrl: string): Promise<string> {
  const url = new URL(`/article-images/${articleId}`, origin);
  url.searchParams.set('v', await imageCacheVersion(storedImageUrl));
  return url.href;
}
