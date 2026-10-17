import { versionedArticleImageUrl } from './image-cache-version';
import { sourcePresentationPlaceholderPath, type PresentationImageSelection } from './presentation-image';

export type PublicPreviewSelection = PresentationImageSelection & { id: number };

export function permittedStoredImageUrl(article: PresentationImageSelection): string | null {
  return article.article_image_policy === 'remote_preview' &&
    article.source_image_policy === 'remote_preview' ? article.og_image_url : null;
}

export function currentLocalImageVersion(article: Pick<PresentationImageSelection, 'og_image_url' |
  'article_image_policy' | 'source_image_policy' | 'local_image_source_url' |
  'local_image_content_sha256'>): string | null {
  return article.article_image_policy === 'local_copy_permitted' &&
    article.source_image_policy === 'local_copy_permitted' &&
    article.og_image_url !== null && article.local_image_source_url === article.og_image_url &&
    article.local_image_content_sha256
    ? article.local_image_content_sha256.slice(0, 32) : null;
}

/** Ordinary public image URL, independent of subscriber identity. */
export async function publicPreviewImageUrl(origin: string,
  article: PublicPreviewSelection): Promise<string | null> {
  const publisherImageUrl = permittedStoredImageUrl(article);
  if (publisherImageUrl) return versionedArticleImageUrl(origin, article.id, publisherImageUrl);
  const localVersion = currentLocalImageVersion(article);
  if (localVersion) {
    const url = new URL(`/article-images/${article.id}`, origin);
    url.searchParams.set('v', localVersion);
    return url.href;
  }
  const placeholderPath = sourcePresentationPlaceholderPath(article);
  return placeholderPath ? new URL(placeholderPath, origin).href : null;
}
