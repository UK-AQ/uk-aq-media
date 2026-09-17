export function normaliseArticleAuthorForStorage(author: string | null | undefined,
  publisher: string): string | null {
  if (author == null) return null;
  const trimmedAuthor = author.trim();
  if (!trimmedAuthor) return null;
  return trimmedAuthor.toLocaleLowerCase('en-GB') === publisher.trim().toLocaleLowerCase('en-GB')
    ? null : trimmedAuthor;
}
