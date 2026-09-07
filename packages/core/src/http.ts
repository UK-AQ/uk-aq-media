export class HttpError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
export function json(value: unknown, status = 200, cache = 'no-store'): Response {
  return Response.json(value, { status, headers: {
    'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff',
  } });
}
export function boundedLimit(url: URL, defaultLimit = 20, maximum = 50): number {
  const raw = url.searchParams.get('limit');
  if (raw === null) return defaultLimit;
  if (!/^\d{1,6}$/.test(raw) || Number(raw) < 1) throw new HttpError(400, 'invalid_limit');
  return Math.min(Number(raw), maximum);
}
export function httpFailure(error: unknown): Response {
  if (error instanceof HttpError) return json({ error: error.message }, error.status);
  console.error(JSON.stringify({ event: 'media_request_failed' }));
  return json({ error: 'temporarily_unavailable' }, 503);
}
export async function bearerMatches(request: Request, secret: string | undefined): Promise<boolean> {
  if (!secret) return false;
  const header = request.headers.get('Authorization');
  if (!header || header.length > 4096 || !header.startsWith('Bearer ')) return false;
  const encoder = new TextEncoder();
  const [actual, expected] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(header.slice(7))),
    crypto.subtle.digest('SHA-256', encoder.encode(secret)),
  ]);
  return crypto.subtle.timingSafeEqual(actual, expected);
}
