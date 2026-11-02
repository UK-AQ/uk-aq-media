// Optional Worker secret: absence must never prevent unrelated Media deployment.
// Kept outside Wrangler's generated declarations so `npm run types` preserves it.
interface MediaDiscoveryEnv {
  UK_AQ_MEDIA_THREADS_TOKEN?: string;
}
