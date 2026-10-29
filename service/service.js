// Background service of the Beacon app (2026-10-26). Makes the few HTTPS calls the app's web view can't:
// Beacon's CMS only accepts beacon.tv as a browser origin. Everything else (sign-in state, catalog,
// search, screens) lives in the app itself; this service keeps no state (apart from the reordered video
// playlists it serves for a few minutes, see below).
// Runs on the TV's own Node.js (v8 on webOS 6): CommonJS, no fetch, no object spread.
'use strict';

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const urlLib = require('url');
const Service = require('webos-service');
const pkg = require('./package.json');

const CMS_URL = 'https://critrole-beacon-production-backend.clockhosting.com/api/graphql';
const OAUTH_URL = 'https://pocketbeacon.memberful.com/oauth/token';
const CLIENT_ID = '3Wdgxb5im239JhTBhS7KczZn';   // Beacon's own (public) Memberful client, as used by beacon.tv
// Caption files only come from JW Player, so the text method is no open fetcher
const TEXT_HOSTS = /(^|\.)(jwplayer\.com|jwpsrv\.com|jwpcdn\.com|jwplatform\.com)$/;

const service = new Service(pkg.name);

// webOS ends a service a few seconds after its last request, and starting it again takes ~3 s (measured on the TV),
// which the app felt on every screen after a pause. So every request (and the app's ping, every 2 minutes while it is
// in front) keeps it running for KEEP_ALIVE through an activity.
const KEEP_ALIVE = 3 * 60 * 1000;
let keepAlive = null;                   // activity that keeps this service running
let keepAliveTimer = null;

function holdService() {
  try {
    if (!keepAlive) {
      keepAlive = true;   // until the activity arrives
      service.activityManager.create('keepAlive', (activity) => { keepAlive = activity; });
    }
  } catch (e) { /* no activity: the service then just stops when idle, as before */ }
  clearTimeout(keepAliveTimer);
  keepAliveTimer = setTimeout(() => {
    const activity = keepAlive;
    keepAlive = null;
    if (activity && activity !== true) service.activityManager.complete(activity, () => {});
  }, KEEP_ALIVE);
}

// The app's keep-warm call: {} -> {}
service.register('ping', (msg) => {
  holdService();
  msg.respond({ returnValue: true });
});

// One HTTPS request; follows redirects (Memberful sends the token request on to members.beacon.tv)
function request(url, opts, redirects) {
  redirects = redirects || 0;
  return new Promise((resolve, reject) => {
    const u = urlLib.parse(url);
    const headers = Object.assign({ 'user-agent': 'BeaconTV-webOS/' + pkg.version }, opts.headers);
    const req = https.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port, path: u.path,
      method: opts.method || 'GET', headers: headers,
    }, (res) => {
      if ([301, 302, 303, 307, 308].indexOf(res.statusCode) >= 0 && res.headers.location && redirects < 3) {
        res.resume();
        const next = urlLib.resolve(url, res.headers.location);
        const keep = res.statusCode === 307 || res.statusCode === 308;
        resolve(request(next, keep ? opts : { method: 'GET', headers: opts.headers }, redirects + 1));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.setTimeout(20000, () => req.abort());
    req.on('error', (e) => reject(e.code === 'ECONNRESET' ? new Error('timeout') : e));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}
const parse = (text) => { try { return JSON.parse(text); } catch (e) { return null; } };
const fail = (msg, e) => msg.respond({ returnValue: false, errorText: e.message || String(e) });

// GraphQL query to Beacon's CMS: { query, variables, token?, supportsDrm? } -> { status, data, errors }
service.register('gql', (msg) => {
  holdService();
  const p = msg.payload;
  const headers = {
    'content-type': 'application/json',
    'x-platform': 'web',
    'x-supports-drm': p.supportsDrm ? 'true' : 'false',   // false: plain HLS the TV plays itself
    'x-has-waiting-room': 'true',
  };
  if (p.token) headers.authorization = 'Bearer ' + p.token;
  const body = JSON.stringify({ query: p.query, variables: p.variables || {} });
  headers['content-length'] = Buffer.byteLength(body);
  request(CMS_URL, { method: 'POST', headers: headers, body: body }).then((r) => {
    const j = parse(r.body) || {};
    msg.respond({ returnValue: true, status: r.status, data: j.data || null, errors: j.errors || null });
  }).catch((e) => fail(msg, e));
});

// Memberful token request: { grant_type: 'password', username, password } or { grant_type: 'refresh_token',
// refresh_token } -> { status, body }. The password is passed on and never kept.
service.register('token', (msg) => {
  holdService();
  const p = msg.payload;
  const params = { client_id: CLIENT_ID, grant_type: p.grant_type };
  ['username', 'password', 'refresh_token'].forEach((k) => { if (p[k] !== undefined) params[k] = String(p[k]); });
  const qs = Object.keys(params).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(params[k])).join('&');
  request(OAUTH_URL + '?' + qs, { method: 'POST', headers: { 'content-length': 0 } }).then((r) => {
    msg.respond({ returnValue: true, status: r.status, body: parse(r.body) || {} });
  }).catch((e) => fail(msg, e));
});

// A caption file from JW Player: { url } -> { status, text }
service.register('text', (msg) => {
  holdService();
  const u = urlLib.parse(String(msg.payload.url || ''));
  if (u.protocol !== 'https:' || !TEXT_HOSTS.test(u.hostname || '')) return fail(msg, new Error('host not allowed'));
  request(u.href, {}).then((r) => msg.respond({ returnValue: true, status: r.status, text: r.body }))
    .catch((e) => fail(msg, e));
});

// ---------- full quality from the first second ----------
// JW Player's master playlists list the 640x360 stream first (then 1080p, 720p, ...), and the TV's player starts
// with the first stream it reads: every video began blurry until the player had measured the connection. Sorting
// alone isn't enough: tested on the TV (2026-10-29), LG's player starts on the first stream but ~4 s in always drops
// to the lowest one it's offered, for ~4 s, before climbing back. So the playlist method fetches the master
// playlist and serves two copies on 127.0.0.1 for the video element:
//   best  only the highest stream: sharp from the first second (the app's first choice)
//   url   all streams, highest first, so the player can step down (the app switches to it if playback stalls)
// The streams themselves still come straight from JW Player (their addresses are made absolute).
const PLAYLIST_TTL = 10 * 60 * 1000;    // the player reads the master playlist once, at the start
const playlists = {};                   // id -> { text, expires }
let server = null;                      // promise of the local port

// { head, streams }: streams in order of bandwidth, highest first; null if this is no master playlist
function reorderPlaylist(text, base) {
  const lines = text.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter((l) => l);
  const head = [];
  const streams = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/URI="([^"]+)"/g, (m, ref) => 'URI="' + urlLib.resolve(base, ref) + '"');
    if (line.indexOf('#EXT-X-STREAM-INF:') !== 0) {
      // a stray address line without its #EXT-X-STREAM-INF would change meaning when moved: don't touch the file
      if (line[0] !== '#') return null;
      head.push(line);
      continue;
    }
    // the stream's tag lines up to its address
    const block = [line];
    while (++i < lines.length && lines[i][0] === '#') block.push(lines[i]);
    if (i >= lines.length) return null;
    block.push(urlLib.resolve(base, lines[i]));
    const bw = /(?:^|[:,])BANDWIDTH=(\d+)/.exec(line);
    streams.push({ lines: block, bandwidth: bw ? Number(bw[1]) : 0, order: streams.length });
  }
  if (!streams.length) return null;
  // the order index keeps the sort stable (Node 8's sort isn't)
  streams.sort((a, b) => (b.bandwidth - a.bandwidth) || (a.order - b.order));
  return { head: head, streams: streams };
}

function playlistServer() {
  if (!server) {
    server = new Promise((resolve, reject) => {
      const s = http.createServer((req, res) => {
        const m = /^\/playlist\/([0-9a-f]+)\.m3u8/.exec(req.url);
        const p = m && playlists[m[1]];
        if (!p) { res.writeHead(404); res.end(); return; }
        holdService();
        res.writeHead(200, {
          'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-cache',
          'content-length': Buffer.byteLength(p.text),
        });
        res.end(p.text);
      });
      s.on('error', (e) => { server = null; reject(e); });
      s.listen(0, '127.0.0.1', () => resolve(s.address().port));   // local only; any free port
    });
  }
  return server;
}

// A video's master playlist as two local copies:
//   { url } -> { best: only the best stream, url: all streams best first, streams: [resolutions, best first] }
service.register('playlist', (msg) => {
  const u = urlLib.parse(String(msg.payload.url || ''));
  if (u.protocol !== 'https:' || !TEXT_HOSTS.test(u.hostname || '')) return fail(msg, new Error('host not allowed'));
  holdService();
  request(u.href, {}).then((r) => {
    if (r.status !== 200) throw new Error('HTTP ' + r.status);
    const p = reorderPlaylist(r.body, u.href);
    if (!p) throw new Error('not a master playlist');
    const now = Date.now();
    Object.keys(playlists).forEach((id) => { if (playlists[id].expires < now) delete playlists[id]; });
    const serve = (streams) => {
      const id = crypto.randomBytes(8).toString('hex');
      const text = p.head.concat.apply(p.head, streams.map((s) => s.lines)).join('\n') + '\n';
      playlists[id] = { text: text, expires: now + PLAYLIST_TTL };
      return '/playlist/' + id + '.m3u8';
    };
    // the best video stream (an audio-only stream has no RESOLUTION)
    const top = p.streams.filter((s) => /RESOLUTION=/.test(s.lines[0]))[0] || p.streams[0];
    const best = serve([top]);
    const all = serve(p.streams);
    return playlistServer().then((port) => msg.respond({
      returnValue: true, best: 'http://127.0.0.1:' + port + best, url: 'http://127.0.0.1:' + port + all,
      streams: p.streams.map((s) => (/RESOLUTION=(\d+x\d+)/.exec(s.lines[0]) || [])[1] || s.bandwidth),
    }));
  }).catch((e) => fail(msg, e));
});
