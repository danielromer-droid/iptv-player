// Cloudflare Pages Function: GET /api/proxy?url=<encoded source URL>
//
// Relays a request to a source you are allowed to use, so the browser can
// reach http:// servers from the https:// site and servers that send no CORS
// headers. HLS playlists are rewritten so their segments also go through it.
//
// Safety limits (set these in Pages > Settings > Variables):
//   ALLOWED_HOSTS  optional, comma-separated host names, e.g. "my-server.com,cdn.my-server.com".
//                  When set, every other host is refused. Strongly recommended.
//   ALLOW_ANY_ORIGIN  set to "1" to let other websites use this proxy (off by default).
//   ALLOW_PRIVATE_HOSTS  set to "1" only for local testing against localhost / LAN servers.

const FORWARD_HEADERS = ['range', 'authorization', 'x-api-key', 'accept', 'user-agent', 'if-none-match', 'if-modified-since'];
const EXPOSE_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'cache-control'];

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(request, env) });
  if (request.method !== 'GET' && request.method !== 'HEAD') return text('Method not allowed', 405, request, env);

  const self = new URL(request.url);
  if (!sameSite(request, self, env)) return text('This proxy only serves its own site.', 403, request, env);

  const raw = self.searchParams.get('url');
  let target;
  try { target = new URL(raw); } catch { return text('Missing or invalid ?url=', 400, request, env); }
  if (!/^https?:$/.test(target.protocol)) return text('Only http and https are supported.', 400, request, env);
  if (env.ALLOW_PRIVATE_HOSTS !== '1' && isPrivateHost(target.hostname)) return text('Private and local addresses are not allowed.', 403, request, env);
  if (target.host === self.host) return text('Refusing to proxy to itself.', 400, request, env);

  const allowed = (env.ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (allowed.length && !allowed.some((h) => target.hostname === h || target.hostname.endsWith('.' + h))) {
    return text(`Host ${target.hostname} is not in ALLOWED_HOSTS.`, 403, request, env);
  }

  const headers = new Headers();
  for (const h of FORWARD_HEADERS) {
    const v = request.headers.get(h);
    if (v) headers.set(h, v);
  }

  let upstream;
  try {
    upstream = await fetch(target.toString(), { method: request.method, headers, redirect: 'follow' });
  } catch (e) {
    return text('Upstream fetch failed: ' + e.message, 502, request, env);
  }

  const out = new Headers(cors(request, env));
  for (const h of EXPOSE_HEADERS) {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }

  const type = (upstream.headers.get('content-type') || '').toLowerCase();
  const finalUrl = upstream.url || target.toString();
  const looksHls = type.includes('mpegurl') || /\.m3u8(\?|$)/i.test(new URL(finalUrl).pathname + new URL(finalUrl).search);

  if (looksHls && request.method === 'GET' && upstream.ok) {
    const body = await upstream.text();
    if (body.includes('#EXT-X-')) {
      out.delete('content-length');
      out.set('content-type', 'application/vnd.apple.mpegurl');
      out.set('cache-control', 'no-store');
      return new Response(rewriteHls(body, finalUrl, self), { status: upstream.status, headers: out });
    }
    return new Response(body, { status: upstream.status, headers: out });
  }

  return new Response(upstream.body, { status: upstream.status, headers: out });
}

function rewriteHls(body, base, self) {
  const prox = (u) => {
    try { return `${self.origin}/api/proxy?url=${encodeURIComponent(new URL(u, base).toString())}`; }
    catch { return u; }
  };
  return body.split(/\r?\n/).map((line) => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_m, u) => `URI="${prox(u)}"`);
    return prox(t);
  }).join('\n');
}

function sameSite(request, self, env) {
  if (env.ALLOW_ANY_ORIGIN === '1') return true;
  const site = request.headers.get('sec-fetch-site');
  if (site === 'same-origin' || site === 'none') return true;
  const origin = request.headers.get('origin');
  if (origin) return origin === self.origin;
  const ref = request.headers.get('referer');
  if (ref) { try { return new URL(ref).origin === self.origin; } catch { return false; } }
  return !site; // non-browser clients without these headers (e.g. curl for testing)
}

function isPrivateHost(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return h.includes(':');
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

function cors(request, env) {
  const origin = request.headers.get('origin');
  return {
    'access-control-allow-origin': env.ALLOW_ANY_ORIGIN === '1' ? '*' : (origin || new URL(request.url).origin),
    'access-control-allow-methods': 'GET, HEAD, OPTIONS',
    'access-control-allow-headers': 'range, authorization, x-api-key, content-type',
    'access-control-expose-headers': EXPOSE_HEADERS.join(', '),
    vary: 'origin',
  };
}

function text(msg, status, request, env) {
  return new Response(msg, { status, headers: { ...cors(request, env), 'content-type': 'text/plain; charset=utf-8' } });
}
