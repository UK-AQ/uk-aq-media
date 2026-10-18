import { remotePreviewUrl, type PublisherDomainIdentity } from '@uk-aq-media/core';

export type EmailPreviewSelection = PublisherDomainIdentity & {
  status:string;
  og_image_url:string|null;
  article_image_policy:string;
  source_image_policy:string;
};

// Composition-time selection from this article's stored publisher metadata only.
// Email clients fetch the URL directly; no Media proxy, local copy or image fetch.
export function emailPreviewImageUrl(article:EmailPreviewSelection):string|null {
  if(article.status!=='approved' || article.article_image_policy!=='remote_preview' ||
    article.source_image_policy!=='remote_preview') return null;
  return remotePreviewUrl(article.og_image_url,article);
}
