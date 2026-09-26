export type PresentationImageSelection = {
  source_key: string;
  og_image_url: string | null;
  article_image_policy: string;
  source_image_policy: string;
  local_image_source_url?: string | null;
  local_image_content_sha256?: string | null;
};

const SOURCE_PLACEHOLDER_PATHS: Readonly<Record<string, string>> = {
  'communities-against-woodsmoke':
    '/source-images/communities-against-woodsmoke-default.png',
};

/** Selects a first-party presentation fallback, never publisher image metadata. */
export function sourcePresentationPlaceholderPath(
  article: PresentationImageSelection,
): string | null {
  if (article.og_image_url !== null ||
      article.article_image_policy !== 'remote_preview' ||
      article.source_image_policy !== 'remote_preview') return null;
  return SOURCE_PLACEHOLDER_PATHS[article.source_key] ?? null;
}

export function hasPermittedPresentationImage(
  article: PresentationImageSelection,
): boolean {
  const remotePublisherImage = article.og_image_url !== null &&
    article.article_image_policy === 'remote_preview' &&
    article.source_image_policy === 'remote_preview';
  const localPublisherImage = article.og_image_url !== null &&
    article.article_image_policy === 'local_copy_permitted' &&
    article.source_image_policy === 'local_copy_permitted' &&
    article.local_image_source_url === article.og_image_url &&
    Boolean(article.local_image_content_sha256);
  return remotePublisherImage || localPublisherImage ||
    sourcePresentationPlaceholderPath(article) !== null;
}
