// Entry point when deployed as a Cloudflare Worker with static assets.
// /api/proxy goes to the proxy; everything else is served from the static files.
import { onRequest } from './functions/api/proxy.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/proxy') return onRequest({ request, env });
    return env.ASSETS.fetch(request);
  },
};
