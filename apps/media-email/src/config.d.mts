export function httpsOrigin(value: unknown, name: string): string;
export function turnstileHostnames(value: unknown): string[];
export function websiteConfig(env: {
  NEWS_EMAIL_SITE_ORIGIN: string;
  NEWS_EMAIL_TURNSTILE_HOSTNAMES: string;
}): { site: string; origins: string[]; hostnames: string[] };
