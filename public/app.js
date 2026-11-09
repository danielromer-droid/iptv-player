// Open Media Player: a client-side player for user-supplied sources.
// No content is bundled. Everything runs in the browser; the optional
// /api/proxy endpoint (Cloudflare Pages Function) only relays requests.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const MAX_RENDER = 400; // cap list rendering for huge playlists

// ---------- storage (safe) ----------
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem('omp:' + key); return v == null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('omp:' + key, JSON.stringify(value)); } catch { /* ignore */ }
  },
  del(key) { try { localStorage.removeItem('omp:' + key); } catch { /* ignore */ } },
};

// ---------- status ----------
const statusEl = $('#status');
function setStatus(msg, kind = '') {
  statusEl.textContent = msg || '';
  statusEl.className = 'status ' + kind;
}

// ---------- proxy ----------
const proxyBox = $('#useProxy');
proxyBox.checked = store.get('useProxy', false);
proxyBox.addEventListener('change', () => store.set('useProxy', proxyBox.checked));

// http:// sources can't load on an https:// page (mixed content), so they
// always go through the proxy. "Always use proxy" also covers https sources
// that send no CORS headers.
function needsProxy(url) {
  if (!/^https?:\/\//i.test(url)) return false;
  if (proxyBox.checked) return true;
  return location.protocol === 'https:' && /^http:\/\//i.test(url);
}
function viaProxy(url) {
  if (!needsProxy(url)) return url;
  return `${location.origin}/api/proxy?url=${encodeURIComponent(url)}`;
}

function mixedContentHint(url) {
  if (needsProxy(url)) return ' (Request went through the proxy: the server may be down, or it may refuse connections from Cloudflare.)';
  return '';
}

async function fetchText(url, headers = {}) {
  let res;
  try {
    res = await fetch(viaProxy(url), { headers });
  } catch (e) {
    throw new Error('Network or CORS error.' + (mixedContentHint(url) || ' Try turning on "Always use proxy".'));
  }
  if (!res.ok) {
    let detail = '';
    if (needsProxy(url)) { try { detail = (await res.text()).slice(0, 200); } catch { /* ignore */ } }
    throw new Error(`HTTP ${res.status} ${res.statusText}`.trim() + (detail ? `: ${detail}` : '') + mixedContentHint(url));
  }
  return res.text();
}
async function fetchJSON(url, headers = {}) {
  const text = await fetchText(url, headers);
  try { return JSON.parse(text); } catch { throw new Error('Response is not valid JSON.'); }
}

// ---------- player ----------
const video = $('#video');
const overlay = $('#overlay');
let engine = null; // { destroy() }
let onEndedNext = null;

function detectType(url) {
  const clean = url.split(/[?#]/)[0].toLowerCase();
  if (clean.endsWith('.m3u8') || /\/hls\//.test(clean)) return 'hls';
  if (clean.endsWith('.mpd')) return 'dash';
  if (clean.endsWith('.ts') || clean.endsWith('.flv')) return 'mpegts';
  if (/\/live\/[^/]+\/[^/]+\/\d+$/.test(clean)) return 'mpegts'; // Xtream live without extension
  return 'native';
}

function stopEngine() {
  if (engine) { try { engine.destroy(); } catch { /* ignore */ } engine = null; }
  video.removeAttribute('src');
  video.load();
}

function play({ url, title = '', info = '', type = 'auto', proxy = true }) {
  stopEngine();
  onEndedNext = null;
  const isBlob = url.startsWith('blob:');
  const src = proxy && !isBlob ? viaProxy(url) : url;
  const kind = type === 'auto' ? detectType(url) : type;

  $('#nowTitle').textContent = title || url.split('/').pop() || 'Stream';
  $('#nowInfo').textContent = info || (isBlob ? 'Local file' : kind.toUpperCase());
  overlay.hidden = true;
  setStatus('Loading…');

  const fail = (msg) => {
    setStatus(msg + mixedContentHint(url), 'error');
    overlay.textContent = 'Could not play this source.';
    overlay.hidden = false;
  };

  if (kind === 'hls') {
    if (window.Hls && Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true, lowLatencyMode: true });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) { hls.recoverMediaError(); return; }
        fail(`HLS error: ${data.details}.`);
        hls.destroy();
      });
      hls.loadSource(src);
      hls.attachMedia(video);
      engine = hls;
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src; // Safari / iOS native HLS
    } else return fail('HLS is not supported in this browser.');
  } else if (kind === 'dash') {
    if (!window.dashjs) return fail('DASH library failed to load.');
    const dash = dashjs.MediaPlayer().create();
    dash.initialize(video, src, true);
    dash.on(dashjs.MediaPlayer.events.ERROR, (e) => fail('DASH error: ' + (e?.error?.message || 'unknown') + '.'));
    engine = { destroy: () => dash.reset() };
  } else if (kind === 'mpegts') {
    if (window.mpegts && mpegts.getFeatureList().mseLivePlayback) {
      const p = mpegts.createPlayer({ type: /\.flv/i.test(url) ? 'flv' : 'mpegts', isLive: true, url: src });
      p.attachMediaElement(video);
      p.load();
      p.on(mpegts.Events.ERROR, (t, d) => fail(`Stream error: ${t} ${d}.`));
      engine = { destroy: () => { p.pause(); p.unload(); p.detachMediaElement(); p.destroy(); } };
    } else {
      video.src = src;
    }
  } else {
    video.src = src;
  }

  video.play().catch(() => { /* autoplay may need a click; controls are visible */ });
  if (!isBlob) addHistory({ url, title, type });
}

video.addEventListener('playing', () => setStatus('Playing', 'ok'));
video.addEventListener('waiting', () => setStatus('Buffering…'));
video.addEventListener('error', () => {
  const err = video.error;
  if (!err || !video.currentSrc) return;
  setStatus(`Playback error (code ${err.code}). The format may be unsupported by this browser.`, 'error');
});
video.addEventListener('ended', () => { if (onEndedNext) onEndedNext(); });

function markPlaying(list, li) {
  $$('li.playing', list).forEach((x) => x.classList.remove('playing'));
  li?.classList.add('playing');
}

// ---------- list rendering ----------
function renderList(ul, items, onClick, emptyText = 'Nothing found.') {
  ul.innerHTML = '';
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = emptyText;
    ul.append(li);
    return;
  }
  const frag = document.createDocumentFragment();
  items.slice(0, MAX_RENDER).forEach((item, i) => {
    const li = document.createElement('li');
    if (item.className) li.className = item.className;
    if (item.logo) {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.src = item.logo;
      img.onerror = () => img.remove();
      li.append(img);
    }
    const box = document.createElement('div');
    box.className = 'name';
    box.textContent = item.name;
    if (item.sub) {
      const s = document.createElement('div');
      s.className = 'sub';
      s.textContent = item.sub;
      box.append(s);
    }
    li.append(box);
    li.addEventListener('click', () => { markPlaying(ul, li); onClick(item, i, li); });
    frag.append(li);
  });
  if (items.length > MAX_RENDER) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = `Showing ${MAX_RENDER} of ${items.length}. Use search to narrow down.`;
    frag.append(li);
  }
  ul.append(frag);
}

const matches = (q) => (item) => !q || item.name.toLowerCase().includes(q);

// ---------- tabs ----------
$$('.tabs button').forEach((btn) => btn.addEventListener('click', () => selectTab(btn.dataset.tab)));
function selectTab(name) {
  $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
  store.set('tab', name);
}
selectTab(store.get('tab', 'xtream'));

// ---------- history ----------
function addHistory(entry) {
  const list = store.get('history', []).filter((h) => h.url !== entry.url);
  list.unshift({ ...entry, at: Date.now() });
  store.set('history', list.slice(0, 20));
  renderHistory();
}
function renderHistory() {
  const items = store.get('history', []).map((h) => ({ ...h, name: h.title || h.url, sub: h.title ? h.url : '' }));
  renderList($('#historyList'), items, (h) => play(h), 'No streams played yet.');
}
renderHistory();

// ---------- single stream ----------
$('#singleForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const url = String(f.get('url')).trim();
  if (url) play({ url, type: String(f.get('type')) });
});

// ---------- local files ----------
const localUl = $('#localList');
let localItems = [];
function addLocalFiles(files) {
  const media = [...files].filter((f) => /^(audio|video)\//.test(f.type) || /\.(mp4|m4v|mkv|webm|mov|mp3|m4a|aac|ogg|oga|opus|wav|flac)$/i.test(f.name));
  if (!media.length) { setStatus('No audio or video files in that selection.', 'error'); return; }
  media.forEach((file) => localItems.push({
    name: file.name,
    sub: `${(file.size / 1048576).toFixed(1)} MB${file.type ? ' · ' + file.type : ''}`,
    url: URL.createObjectURL(file),
  }));
  renderLocal();
}
function playLocal(i) {
  const item = localItems[i];
  if (!item) return;
  play({ url: item.url, title: item.name, info: 'Local file', type: 'native' });
  markPlaying(localUl, localUl.children[i]);
  onEndedNext = () => playLocal(i + 1); // auto-advance like a playlist
}
function renderLocal() {
  renderList(localUl, localItems, (_item, i) => playLocal(i));
}
$('#localFiles').addEventListener('change', (e) => { addLocalFiles(e.target.files); e.target.value = ''; });
const drop = $('#dropZone');
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => addLocalFiles(e.dataTransfer.files));

// ---------- M3U ----------
function parseAttrs(s) {
  const out = {};
  s.replace(/([\w-]+)="([^"]*)"/g, (_m, k, v) => { out[k.toLowerCase()] = v; return ''; });
  return out;
}
export function parseM3U(text, baseUrl = '') {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const items = [];
  let cur = null;
  let grp = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const comma = findTitleComma(line);
      const head = line.slice(0, comma);
      const attrs = parseAttrs(head);
      cur = {
        name: line.slice(comma + 1).trim() || attrs['tvg-name'] || 'Untitled',
        logo: attrs['tvg-logo'] || '',
        group: attrs['group-title'] || '',
        id: attrs['tvg-id'] || '',
      };
    } else if (line.startsWith('#EXTGRP:')) {
      grp = line.slice(8).trim();
    } else if (line.startsWith('#')) {
      continue;
    } else {
      let url = line;
      try { url = baseUrl ? new URL(line, baseUrl).href : line; } catch { /* keep */ }
      const item = cur || { name: line.split('/').pop() || line, logo: '', group: '' };
      if (!item.group && grp) item.group = grp;
      item.url = url;
      items.push(item);
      cur = null;
      grp = '';
    }
  }
  return items;
}
// The title follows the first comma that is not inside a quoted attribute.
function findTitleComma(line) {
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') inQ = !inQ;
    else if (line[i] === ',' && !inQ) return i;
  }
  return line.length;
}

let m3uItems = [];
function showM3U(items, label) {
  m3uItems = items;
  const groups = [...new Set(items.map((i) => i.group).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const sel = $('#m3uGroup');
  sel.innerHTML = '';
  sel.append(new Option(`All groups (${groups.length})`, ''));
  groups.forEach((g) => sel.append(new Option(g, g)));
  $('#m3uBrowser').hidden = false;
  $('#m3uSearch').value = '';
  filterM3U();
  setStatus(`Loaded ${items.length} entries from ${label}.`, 'ok');
}
function filterM3U() {
  const g = $('#m3uGroup').value;
  const q = $('#m3uSearch').value.trim().toLowerCase();
  const list = m3uItems.filter((i) => (!g || i.group === g)).filter(matches(q))
    .map((i) => ({ ...i, sub: i.group }));
  $('#m3uCount').textContent = `${list.length} items`;
  renderList($('#m3uList'), list, (i) => play({ url: i.url, title: i.name, info: i.group }));
}
$('#m3uGroup').addEventListener('change', filterM3U);
$('#m3uSearch').addEventListener('input', debounce(filterM3U, 150));

async function loadM3UUrl(url) {
  setStatus('Loading playlist…');
  try {
    const text = await fetchText(url);
    if (!/#EXTM3U|#EXTINF/.test(text)) {
      if (/#EXT-X-/.test(text)) { play({ url, type: 'hls' }); return; } // it was an HLS stream
      throw new Error('This does not look like an M3U playlist.');
    }
    showM3U(parseM3U(text, url), 'URL');
    store.set('m3uUrl', url);
  } catch (e) { setStatus(e.message, 'error'); }
}
$('#m3uForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const url = String(new FormData(e.target).get('url')).trim();
  if (url) loadM3UUrl(url);
});
$('#m3uForm [name=url]').value = store.get('m3uUrl', '');
$('#m3uFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  showM3U(parseM3U(await file.text()), file.name);
  e.target.value = '';
});

// ---------- Xtream Codes ----------
const xt = { base: '', user: '', pass: '', format: 'm3u8', section: 'live', categories: [], items: [], series: null };
const XT_ACTIONS = {
  live: { cats: 'get_live_categories', list: 'get_live_streams' },
  vod: { cats: 'get_vod_categories', list: 'get_vod_streams' },
  series: { cats: 'get_series_categories', list: 'get_series' },
};
function xtApi(params) {
  const q = new URLSearchParams({ username: xt.user, password: xt.pass, ...params });
  return `${xt.base}/player_api.php?${q}`;
}
const enc = encodeURIComponent;
function xtStreamUrl(kind, id, ext) {
  const path = { live: 'live', vod: 'movie', series: 'series' }[kind];
  return `${xt.base}/${path}/${enc(xt.user)}/${enc(xt.pass)}/${id}.${ext}`;
}

async function xtLogin({ server, username, password, format, remember }) {
  let base = server.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) base = 'http://' + base;
  base = base.replace(/\/(player_api|get)\.php.*$/i, '');
  Object.assign(xt, { base, user: username.trim(), pass: password, format });
  setStatus('Logging in…');
  const data = await fetchJSON(xtApi({}));
  const ui = data?.user_info;
  if (!ui || String(ui.auth) !== '1') throw new Error('Login failed: check server, username and password.');
  if (remember) store.set('xtream', { server: base, username: xt.user, password, format });
  else store.del('xtream');
  const exp = ui.exp_date ? new Date(Number(ui.exp_date) * 1000).toLocaleDateString() : 'never';
  $('#xtreamAccount').textContent = `Signed in as ${ui.username} · status ${ui.status || 'n/a'} · expires ${exp} · max connections ${ui.max_connections ?? 'n/a'}`;
  $('#xtreamForm').hidden = true;
  $('#xtreamBrowser').hidden = false;
  setStatus('Signed in.', 'ok');
  await xtLoadSection('live');
}

async function xtLoadSection(section) {
  xt.section = section;
  xt.series = null;
  $('#xtreamSection').value = section;
  setStatus('Loading categories…');
  try {
    const cats = await fetchJSON(xtApi({ action: XT_ACTIONS[section].cats }));
    xt.categories = Array.isArray(cats) ? cats : [];
    const sel = $('#xtreamCategory');
    sel.innerHTML = '';
    sel.append(new Option('All categories', ''));
    xt.categories.forEach((c) => sel.append(new Option(c.category_name, c.category_id)));
    // Start on the first category: "All" can be very large on some servers.
    sel.value = xt.categories[0]?.category_id ?? '';
    await xtLoadCategory();
  } catch (e) { setStatus(e.message, 'error'); }
}

async function xtLoadCategory() {
  const cat = $('#xtreamCategory').value;
  xt.series = null;
  setStatus('Loading list…');
  try {
    const params = { action: XT_ACTIONS[xt.section].list };
    if (cat) params.category_id = cat;
    const list = await fetchJSON(xtApi(params));
    xt.items = (Array.isArray(list) ? list : Object.values(list || {})).map((s) => ({
      name: s.name || s.title || 'Untitled',
      logo: s.stream_icon || s.cover || '',
      id: s.stream_id ?? s.series_id,
      ext: s.container_extension,
      sub: s.rating ? `★ ${s.rating}` : '',
      raw: s,
    }));
    setStatus(`${xt.items.length} items.`, 'ok');
    xtRender();
  } catch (e) { setStatus(e.message, 'error'); }
}

function xtRender() {
  const q = $('#xtreamSearch').value.trim().toLowerCase();
  const ul = $('#xtreamList');
  if (xt.series) {
    const back = { name: '← Back to series', className: 'back', back: true };
    const eps = xt.series.episodes.filter(matches(q));
    renderList(ul, [back, ...eps], (ep) => {
      if (ep.back) { xt.series = null; xtRender(); return; }
      play({ url: xtStreamUrl('series', ep.id, ep.ext || 'mp4'), title: `${xt.series.name} · ${ep.name}`, info: 'Series' });
    });
    return;
  }
  renderList(ul, xt.items.filter(matches(q)), (item) => {
    if (xt.section === 'live') {
      play({ url: xtStreamUrl('live', item.id, xt.format), title: item.name, info: 'Live TV', type: xt.format === 'ts' ? 'mpegts' : 'hls' });
    } else if (xt.section === 'vod') {
      play({ url: xtStreamUrl('vod', item.id, item.ext || 'mp4'), title: item.name, info: 'Movie' });
    } else {
      xtOpenSeries(item);
    }
  });
}

async function xtOpenSeries(item) {
  setStatus('Loading episodes…');
  try {
    const info = await fetchJSON(xtApi({ action: 'get_series_info', series_id: item.id }));
    const episodes = [];
    Object.entries(info?.episodes || {}).forEach(([season, eps]) => {
      (eps || []).forEach((ep) => episodes.push({
        name: `S${season}E${ep.episode_num ?? '?'} ${ep.title || ''}`.trim(),
        id: ep.id,
        ext: ep.container_extension,
        logo: ep.info?.movie_image || '',
      }));
    });
    xt.series = { name: item.name, episodes };
    $('#xtreamSearch').value = '';
    setStatus(`${episodes.length} episodes.`, 'ok');
    xtRender();
  } catch (e) { setStatus(e.message, 'error'); }
}

$('#xtreamForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await xtLogin({
      server: String(f.get('server')), username: String(f.get('username')), password: String(f.get('password')),
      format: String(f.get('format')), remember: f.get('remember') === 'on',
    });
  } catch (err) { setStatus(err.message, 'error'); }
});
$('#xtreamSection').addEventListener('change', (e) => xtLoadSection(e.target.value));
$('#xtreamCategory').addEventListener('change', xtLoadCategory);
$('#xtreamSearch').addEventListener('input', debounce(xtRender, 150));
$('#xtreamLogout').addEventListener('click', () => {
  store.del('xtream');
  Object.assign(xt, { base: '', user: '', pass: '', items: [], series: null });
  $('#xtreamBrowser').hidden = true;
  $('#xtreamForm').hidden = false;
  $('#xtreamForm').reset();
  setStatus('Logged out.');
});
(function restoreXtream() {
  const saved = store.get('xtream', null);
  if (!saved) return;
  const form = $('#xtreamForm');
  form.server.value = saved.server; form.username.value = saved.username;
  form.password.value = saved.password; form.format.value = saved.format || 'm3u8';
  form.remember.checked = true;
})();

// ---------- Stream API ----------
const URL_KEYS = ['url', 'src', 'stream', 'stream_url', 'streamUrl', 'hls', 'dash', 'file', 'link'];
const NAME_KEYS = ['name', 'title', 'label'];
export function extractStreams(data) {
  const pick = (o, keys) => keys.map((k) => o?.[k]).find((v) => typeof v === 'string' && v);
  let arr = Array.isArray(data) ? data
    : Array.isArray(data?.streams) ? data.streams
      : Array.isArray(data?.data) ? data.data
        : Array.isArray(data?.items) ? data.items
          : Array.isArray(data?.channels) ? data.channels
            : [data];
  return arr.map((o) => {
    if (typeof o === 'string') return { name: o.split('/').pop(), url: o };
    const url = pick(o, URL_KEYS);
    return url ? { name: pick(o, NAME_KEYS) || url.split('/').pop(), url, logo: o.logo || o.image || o.icon || '', sub: o.group || o.category || '' } : null;
  }).filter(Boolean);
}
$('#apiForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const url = String(f.get('url')).trim();
  const headers = {};
  const h = String(f.get('header') || '').trim();
  if (h.includes(':')) { const i = h.indexOf(':'); headers[h.slice(0, i).trim()] = h.slice(i + 1).trim(); }
  setStatus('Fetching…');
  try {
    const streams = extractStreams(await fetchJSON(url, headers));
    if (!streams.length) throw new Error('No stream URL found in the response.');
    renderList($('#apiList'), streams, (s) => play({ url: s.url, title: s.name }));
    setStatus(`${streams.length} stream(s) found.`, 'ok');
    if (streams.length === 1) play({ url: streams[0].url, title: streams[0].name });
  } catch (err) { setStatus(err.message, 'error'); }
});

// ---------- URL parameters: ?url=…  ?m3u=…  ?api=…  ----------
(function fromQuery() {
  const p = new URLSearchParams(location.search);
  if (p.has('proxy')) { proxyBox.checked = p.get('proxy') !== '0'; }
  if (p.get('url')) { selectTab('single'); $('#singleForm').url.value = p.get('url'); play({ url: p.get('url'), title: p.get('title') || '' }); }
  else if (p.get('m3u')) { selectTab('m3u'); $('#m3uForm').url.value = p.get('m3u'); loadM3UUrl(p.get('m3u')); }
  else if (p.get('api')) { selectTab('api'); $('#apiForm').url.value = p.get('api'); $('#apiForm').requestSubmit(); }
})();

// ---------- helpers ----------
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// ---------- PWA ----------
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => { /* optional */ });
}

let deferredInstall = null;
const installBtn = $('#installBtn');
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e;
  installBtn.hidden = false;
});
installBtn.addEventListener('click', async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  await deferredInstall.userChoice;
  deferredInstall = null;
  installBtn.hidden = true;
});
