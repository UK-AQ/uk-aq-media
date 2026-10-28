// Shared deployment/runtime validation. No environment defaults or identity guesses.
export function httpsOrigin(value, name) {
  if (typeof value !== 'string' || !/^https:\/\/[^/?#@\\\s\u0000-\u001f\u007f%*<>"'`]+\/?$/.test(value)) {
    throw new Error(`Missing or invalid HTTPS origin: ${name}`);
  }
  let url;
  try { url = new URL(value); }
  catch { throw new Error(`Invalid HTTPS origin: ${name}`); }
  if (url.protocol !== 'https:' || !url.hostname || url.port === '0' || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash ||
      (!url.hostname.startsWith('[') && (url.hostname.length > 253 ||
        !url.hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))) ||
      (value !== url.origin && value !== `${url.origin}/`)) {
    throw new Error(`Expected a canonical HTTPS origin: ${name}`);
  }
  return url.origin;
}

function list(value, name, parse) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing ${name}`);
  const entries = value.split(',').map(entry => parse(entry.trim(), name));
  if (new Set(entries).size !== entries.length) throw new Error(`Duplicate entry in ${name}`);
  return entries;
}

export function turnstileHostnames(value) {
  return list(value, 'NEWS_EMAIL_TURNSTILE_HOSTNAMES', (entry, name) => {
    const hostname = entry.toLowerCase();
    if (hostname.length > 253 || !hostname.split('.').every(label =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
      throw new Error(`Invalid hostname in ${name}`);
    }
    // Reject host spellings that URL parsing would reinterpret (e.g. short IPs).
    if (new URL(`https://${hostname}`).hostname !== hostname) {
      throw new Error(`Non-canonical hostname in ${name}`);
    }
    return hostname;
  });
}

export function websiteConfig(env) {
  const site = httpsOrigin(env.NEWS_EMAIL_SITE_ORIGIN, 'NEWS_EMAIL_SITE_ORIGIN');
  const hostnames = turnstileHostnames(env.NEWS_EMAIL_TURNSTILE_HOSTNAMES);
  const origins = hostnames.map(hostname => `https://${hostname}`);
  if (!origins.includes(site)) throw new Error('Canonical email site must be an allowed origin');
  return { site, origins, hostnames };
}
