export type PresentationImageSelection = {
  source_key: string;
  og_image_url: string | null;
  article_image_policy: string;
  source_image_policy: string;
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
  const publisherImage = article.og_image_url !== null &&
    article.article_image_policy === 'remote_preview' &&
    article.source_image_policy === 'remote_preview';
  return publisherImage || sourcePresentationPlaceholderPath(article) !== null;
}
