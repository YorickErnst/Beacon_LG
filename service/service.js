// Background service of the Beacon app (2026-10-26). Makes the few HTTPS calls the app's web view can't:
// Beacon's CMS only accepts beacon.tv as a browser origin. Everything else (sign-in state, catalog,
// search, screens) lives in the app itself; this service keeps no state.
// Runs on the TV's own Node.js (v8 on webOS 6): CommonJS, no fetch, no object spread.
'use strict';

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
  const u = urlLib.parse(String(msg.payload.url || ''));
  if (u.protocol !== 'https:' || !TEXT_HOSTS.test(u.hostname || '')) return fail(msg, new Error('host not allowed'));
  request(u.href, {}).then((r) => msg.respond({ returnValue: true, status: r.status, text: r.body }))
    .catch((e) => fail(msg, e));
});
