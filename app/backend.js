// Beacon data for the app (2026-10-26; formerly the separate Beacon proxy): sign-in with Memberful, Beacon's
// CMS GraphQL API, a local index of the whole catalog for forgiving search and suggestions, and the data
// each screen shows. Network calls go through the app's own service (luna://org.home.beacon.service),
// because Beacon's CMS only accepts beacon.tv as a browser origin.
// Written for the TV's older web engine: no optional chaining, nullish coalescing or other post-2019 syntax.
window.Backend = (function () {
  'use strict';

  const SERVICE = 'luna://org.home.beacon.service/';
  const PLAYABLE = ['video', 'videoPodcast'];
  const INDEX_HOURS = 6;
  const sessionId = 'tv-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);

  function load(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function store(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage full or unavailable */ } }

  // ---------- the app's service ----------
  const pending = new Set();   // keeps bridges alive until they answer
  function call(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (typeof PalmServiceBridge === 'undefined') { reject(new Error('Only available on the TV')); return; }
      const bridge = new PalmServiceBridge();
      pending.add(bridge);
      const timer = setTimeout(() => { pending.delete(bridge); reject(new Error('Beacon is not responding')); }, timeoutMs || 25000);
      bridge.onservicecallback = (text) => {
        clearTimeout(timer);
        pending.delete(bridge);
        let r = {};
        try { r = JSON.parse(text); } catch (e) { /* not JSON */ }
        if (r.returnValue) resolve(r);
        else reject(new Error(r.errorText === 'timeout' ? 'Beacon is not responding' : (r.errorText || 'No connection with Beacon')));
      };
      bridge.call(SERVICE + method, JSON.stringify(params || {}));
    });
  }

  // ---------- sign-in (tokens kept on the TV; the password never is) ----------
  let auth = load('beacon.auth') || {};   // { accessToken, refreshToken, accessExpiry, email }
  let refreshing = null;
  const isSignedIn = () => Boolean(auth.accessToken && auth.refreshToken);

  function tokenRequest(params) {
    return call('token', params).then(r => {
      const body = r.body || {};
      if (r.status >= 400 || !body.access_token) {
        const err = new Error(body.error_description || body.error || ('Memberful answered HTTP ' + r.status));
        err.rejected = r.status === 400 || r.status === 401;
        throw err;
      }
      return body;
    });
  }
  function keepTokens(body) {
    auth.accessToken = body.access_token;
    auth.refreshToken = body.refresh_token || auth.refreshToken;
    auth.accessExpiry = Date.now() + (Number(body.expires_in) || 3600) * 1000;
    store('beacon.auth', auth);
  }
  function signIn(email, password) {
    email = String(email || '').trim();
    return tokenRequest({ grant_type: 'password', username: email, password: String(password || '') }).then(body => {
      auth = { email: email };
      keepTokens(body);
      cache.clear();
    }, err => {
      if (err.rejected) throw new Error('Email address or password is incorrect.');
      throw err;
    });
  }
  function signOut() {
    auth = {};
    store('beacon.auth', null);
    cache.clear();
  }
  // A valid access token, refreshed shortly before it expires; null when signed out
  function accessToken(forceRefresh) {
    if (!isSignedIn()) return Promise.resolve(null);
    if (!forceRefresh && Date.now() < auth.accessExpiry - 60000) return Promise.resolve(auth.accessToken);
    if (!refreshing) {
      refreshing = tokenRequest({ grant_type: 'refresh_token', refresh_token: auth.refreshToken })
        .then(body => { keepTokens(body); return auth.accessToken; })
        .catch(err => { if (err.rejected) signOut(); throw err; })   // refresh token revoked: signed out
        .finally(() => { refreshing = null; });
    }
    return refreshing;
  }

  // ---------- Beacon's CMS ----------
  function gql(query, variables) {
    const attempt = (n) => accessToken(n > 0).then(token => call('gql', { query: query, variables: variables || {}, token: token }).then(r => {
      if (r.status === 401 && token && n === 0) return attempt(1);   // token went stale: refresh once
      if (!r.data) throw new Error((r.errors || []).map(e => e.message).join('; ') || ('Beacon answered HTTP ' + r.status));
      return r.data;
    }));
    return attempt(0);
  }
  // Small in-memory cache for responses that don't change by the second
  const cache = new Map();
  function cached(key, ttlMs, fn) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return Promise.resolve(hit.value);
    return fn().then(value => {
      cache.set(key, { at: Date.now(), value: value });
      if (cache.size > 300) cache.delete(cache.keys().next().value);
      return value;
    });
  }

  const CARD = `
    fragment Card on Content {
      id title duration slug contentType episodeNumber releaseDate
      contentTier { name planLevel }
      primaryCollection { id name slug isSeries }
      thumbnail { sizes { landscape { url } } }
    }`;
  const VIDEO = 'contentVideo { video { video videoData closedCaptions playlistUrl } }';
  const Q = {
    me: 'query { meMember { user { username activeSubscription tier { name planLevel } } } }',
    content: `query Content($slug: String!) {
        Contents(where: { slug: { equals: $slug } }, limit: 1, draft: false) {
          docs {
            ...Card description
            collections { id name slug isSeries }
            content { ... on SuggestedContent { carouselContent: content { ...Card } } }
            ${VIDEO}
          }
        }
        currentProgress(slug: $slug) { videoProgress videoProgressSeconds }
      }${CARD}`,
    media: `query Media($slug: String!) {
        Contents(where: { slug: { equals: $slug } }, limit: 1, draft: false) { docs { id duration ${VIDEO} } }
        currentProgress(slug: $slug) { videoProgress videoProgressSeconds }
      }`,
    series: `query Series($collection: String!, $season: String, $content: String, $limit: Int) {
        fetchSeries(collection: $collection, season: $season, content: $content, limit: $limit) {
          series
          docs { content { ...Card } }
          collection { id name slug isSeries series { id seasonNumber } }
          next { ...Card }
        }
      }${CARD}`,
    search: `query Search($q: String, $sort: String, $types: [String], $collection: String, $page: Int, $limit: Int) {
        search(search: $q, sort: $sort, contentTypes: $types, collection: $collection, page: $page, limit: $limit) {
          totalPages totalDocs page docs { ...Card }
        }
      }${CARD}`,
    collections: `query Collections($page: Int, $limit: Int) {
        collectionSearch(sort: "-releaseDate", page: $page, limit: $limit) {
          totalPages docs {
            id name slug isSeries itemCount releaseDate
            thumbnail { sizes { landscape { url } portrait { url } } }
          }
        }
      }`,
    allCollections: `query {
        series: Collections(where: { isSeries: { equals: true } }, limit: 1000) { docs { id name slug } }
        other: Collections(where: { isSeries: { not_equals: true } }, limit: 1000) { docs { id name slug } }
      }`,
    continueWatching: `query CW($limit: Int) {
        continueWatching(limit: $limit, page: 1) { docs { videoProgress videoProgressSeconds content { ...Card } } }
      }${CARD}`,
    progress: `query P($ids: [String!]!) {
        getProgressForContent(id: $ids) { timeMap { contentId videoProgress videoProgressSeconds } }
      }`,
    track: 'mutation Track($events: [EventInput!]!) { trackView(events: $events) { success reason } }',
    // The member home page exactly as beacon.tv asks for it (home-query.js)
    home: window.BEACON_HOME_QUERY,
  };

  // ---------- catalog index: search that forgives typos, partial words, series names, episode codes
  // like "c4e12"; and "next episode" / "other versions" suggestions. Beacon's own search only matches
  // whole words. Kept on the TV and refreshed every few hours. ----------
  let videos = [], collections = [], builtAt = 0, building = null;

  function normalize(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  }
  // "C4 E001 | ..." -> "c4e1"
  const codeOfTitle = (t) => { const m = /\bc\s*(\d+)\s*e\s*(\d+)\b/i.exec(t || ''); return m ? 'c' + (+m[1]) + 'e' + (+m[2]) : null; };
  // what a person types: "c4 e12", "c4e12", "campaign 4 episode 12", "c 4 ep 12"
  const codeOfQuery = (q) => { const m = /\b(?:c|campaign)\s*(\d+)\s*(?:e|ep|episode)\s*(\d+)\b/.exec(q); return m ? 'c' + (+m[1]) + 'e' + (+m[2]) : null; };

  // Stored form (raw) -> searchable form
  function withWords(v, text) { const n = normalize(text); return Object.assign({}, v, { norm: normalize(v.title || v.name), words: n.split(' ') }); }
  const indexVideo = (v) => Object.assign(withWords(v, v.title + ' ' + (v.series ? v.series.name : '')), { code: codeOfTitle(v.title) });
  const indexCollection = (c) => withWords(c, c.name);

  function rawVideo(c) {
    const series = c.primaryCollection || null;
    return {
      id: c.id, slug: c.slug, title: c.title, duration: c.duration, type: c.contentType,
      tier: c.contentTier ? c.contentTier.name : null, level: c.contentTier ? c.contentTier.planLevel : 0,
      image: c.thumbnail && c.thumbnail.sizes && c.thumbnail.sizes.landscape ? c.thumbnail.sizes.landscape.url : null,
      released: c.releaseDate, episode: c.episodeNumber,
      series: series ? { id: series.id, name: series.name, slug: series.slug, isSeries: series.isSeries } : null,
    };
  }
  function rawCollection(c) {
    const s = c.thumbnail && c.thumbnail.sizes;
    return {
      id: c.id, slug: c.slug, name: c.name, isSeries: Boolean(c.isSeries), itemCount: c.itemCount, released: c.releaseDate,
      image: s && s.landscape ? s.landscape.url : null, portrait: s && s.portrait ? s.portrait.url : null,
    };
  }

  function pages(query, field, map, max) {
    const out = [];
    const next = (page) => gql(query, { types: PLAYABLE, sort: '-releaseDate', page: page, limit: 100 }).then(r => {
      out.push.apply(out, r[field].docs.map(map));
      return page < r[field].totalPages && page < max ? next(page + 1) : out;
    });
    return next(1);
  }
  async function build() {
    const v = await pages(Q.search, 'search', rawVideo, 100);
    const c = await pages(Q.collections, 'collectionSearch', rawCollection, 50);
    // collectionSearch skips many series (Campaign 2, ...); the search-filter lists have them all, without
    // pictures, so those borrow the picture of their newest video
    const lists = await gql(Q.allCollections);
    [[lists.series.docs, true], [lists.other.docs, false]].forEach(pair => {
      pair[0].forEach(d => {
        if (c.some(x => x.id === d.id)) return;
        const own = v.filter(x => x.series && x.series.id === d.id);
        if (!own.length) return;
        c.push(rawCollection(Object.assign({}, d, { isSeries: pair[1], itemCount: own.length, releaseDate: own[0].released,
          thumbnail: { sizes: { landscape: { url: own[0].image } } } })));
      });
    });
    setIndex({ builtAt: Date.now(), videos: v, collections: c });
    store('beacon.index', { builtAt: builtAt, videos: v, collections: c });
  }
  function setIndex(saved) {
    videos = saved.videos.map(indexVideo);
    collections = saved.collections.map(indexCollection);
    builtAt = saved.builtAt;
  }
  (function restore() { const saved = load('beacon.index'); if (saved && saved.videos && saved.videos.length) setIndex(saved); })();

  // Resolves once there is an index; a stale one is used while a new one is built in the background
  function ensureIndex() {
    const stale = Date.now() - builtAt > INDEX_HOURS * 3600000;
    if ((stale || !videos.length) && !building) {
      building = build().catch(e => { console.log('[catalog] build failed: ' + e.message); if (!videos.length) throw e; })
        .finally(() => { building = null; });
    }
    return videos.length ? Promise.resolve() : building;
  }

  // Edit distance (two swapped letters count as one typo) with an early exit once it exceeds max
  function within(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return false;
    let prev2 = null;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      let best = i;
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], prev2[j - 2] + 1);
        best = Math.min(best, cur[j]);
      }
      if (best > max) return false;
      prev2 = prev;
      prev = cur;
    }
    return prev[b.length] <= max;
  }
  // How well one typed word matches one indexed word
  function wordScore(q, w) {
    if (w === q) return 3;
    if (q.length >= 2 && w.startsWith(q)) return 2.2;
    if (q.length >= 4) {
      const max = q.length >= 8 ? 2 : 1;
      if (within(q, w.slice(0, q.length + max), max) && w.length >= q.length - max) return 1.4;   // typo, possibly mid-word
    }
    return 0;
  }
  function score(qWords, qNorm, entry) {
    let total = 0, matched = 0;
    qWords.forEach(q => {
      let best = 0;
      for (const w of entry.words) { const s = wordScore(q, w); if (s > best) best = s; if (best === 3) break; }
      if (best) { matched++; total += best; }
    });
    if (!matched) return 0;
    const coverage = matched / qWords.length;
    if (coverage < (qWords.length > 2 ? 0.6 : 1)) return 0;
    if (entry.norm.indexOf(qNorm) >= 0) total += 3;                 // whole phrase in the title
    return total * coverage;
  }
  function localSearch(query, limit) {
    const qNorm = normalize(query);
    if (!qNorm) return { collections: [], videos: [] };
    const qWords = qNorm.split(' ');
    const code = codeOfQuery(qNorm);
    const col = collections.map(c => ({ c: c, s: score(qWords, qNorm, c) })).filter(x => x.s > 0)
      .sort((a, b) => b.s - a.s || b.c.itemCount - a.c.itemCount).slice(0, 12).map(x => x.c);
    const now = Date.now();
    const vid = videos.map(v => {
      let s = code && v.code === code ? 20 : score(qWords, qNorm, v);
      if (s && v.released) s += Math.max(0, 0.5 - (now - Date.parse(v.released)) / (3 * 365 * 86400000));   // slight preference for newer
      return { v: v, s: s };
    }).filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, limit || 40).map(x => x.v);
    return { collections: col, videos: vid };
  }
  // Quick completions while typing: series names and titles that start with what was typed
  function localSuggest(query, limit) {
    limit = limit || 8;
    const qNorm = normalize(query);
    if (qNorm.length < 2) return [];
    const out = [];
    const add = (text) => { if (!out.some(o => normalize(o) === normalize(text))) out.push(text); };
    collections.forEach(c => { if (c.norm.startsWith(qNorm) || c.words.some(w => w.startsWith(qNorm))) add(c.name); });
    for (const v of videos) {
      if (out.length >= limit) break;
      const title = v.title.split('|').map(s => s.trim()).find(p => normalize(p).indexOf(qNorm) >= 0);
      if (title) add(title);
    }
    return out.slice(0, limit);
  }
  const videoBySlug = (slug) => videos.find(v => v.slug === slug) || null;
  const collectionBySlug = (slug) => collections.find(c => c.slug === slug) || null;
  // Episodes of a series in watching order
  const seriesVideos = (seriesId) => videos.filter(v => v.series && v.series.id === seriesId).sort((a, b) =>
    (a.episode || 0) - (b.episode || 0) || Date.parse(a.released || 0) - Date.parse(b.released || 0));
  // The same episode in another form: the Cooldown, Abridged, ... of "C4 E040"
  const otherVersions = (video) => video && video.code ? videos.filter(v => v.code === video.code && v.id !== video.id) : [];

  // ---------- what the screens show ----------
  // Cloudflare Images URLs end in "/format=auto"; ask for the size we show
  const img = (url, width) => url ? (url.indexOf('format=auto') >= 0 ? url.replace(/format=auto(,width=\d+)?/, 'format=auto,width=' + width) : url) : null;
  const minutes = (ms) => ms ? Math.max(1, Math.round(ms / 60000)) : null;
  const meQuery = () => cached('me', 600000, () => gql(Q.me).catch(() => null));

  function userLevel() {
    if (!isSignedIn()) return Promise.resolve(1);   // free content only
    return meQuery().then(me => {
      const tier = me && me.meMember && me.meMember.user && me.meMember.user.tier;
      return tier ? tier.planLevel : 1;
    });
  }
  function status() {
    const catalog = { videos: videos.length, collections: collections.length, builtAt: builtAt ? new Date(builtAt).toISOString() : null };
    if (!isSignedIn()) return Promise.resolve({ signedIn: false, user: null, catalog: catalog });
    return meQuery().then(r => {
      const u = r && r.meMember && r.meMember.user;
      return { signedIn: isSignedIn(), catalog: catalog,
        user: u ? { name: u.username || auth.email, tier: u.tier ? u.tier.name : null, active: u.activeSubscription } : { name: auth.email } };
    });
  }

  // One video tile; accepts a CMS ContentCard or a catalog entry
  function videoCard(c, level, progress) {
    const known = c.thumbnail || c.image ? null : videoBySlug(c.slug);   // some home items come without picture
    const series = c.primaryCollection || c.series || (known && known.series) || null;
    const levelNeeded = c.contentTier ? c.contentTier.planLevel : c.level || (known && known.level) || 0;
    const image = c.thumbnail && c.thumbnail.sizes && c.thumbnail.sizes.landscape ? c.thumbnail.sizes.landscape.url : c.image || (known && known.image);
    return {
      kind: 'video', slug: c.slug, id: c.id, title: c.title, subtitle: series ? series.name : '',
      image: img(image, 480), minutes: minutes(c.duration), locked: levelNeeded > level,
      progress: progress && progress[c.id] ? progress[c.id] : 0,
    };
  }
  function seriesCard(c) {
    const s = c.thumbnail && c.thumbnail.sizes;
    const image = s ? (s.landscape || s.portrait || {}).url : c.image || c.portrait;
    const known = collectionBySlug(c.slug);
    return { kind: 'series', slug: c.slug, title: c.name, image: img(image || (known && known.image), 480), count: c.itemCount || (known && known.itemCount) || null };
  }
  // Progress (0..1) for a list of content ids, from Beacon
  async function progressFor(ids) {
    const map = {};
    if (!isSignedIn() || !ids.length) return map;
    for (let i = 0; i < ids.length; i += 100) {
      const r = await gql(Q.progress, { ids: ids.slice(i, i + 100) }).catch(() => null);
      const list = (r && r.getProgressForContent && r.getProgressForContent.timeMap) || [];
      list.forEach(p => { map[p.contentId] = Math.min(1, (p.videoProgress || 0) / 100); });
    }
    return map;
  }

  const isVideo = (c) => c && c.slug && c.title && (!c.contentType || PLAYABLE.indexOf(c.contentType) >= 0);
  const isCollection = (c) => c && c.slug && c.name && !c.title;
  // Pull the content and collection items out of any home-page block, whatever its shape
  function blockItems(block) {
    const out = [];
    const keys = ['items', 'carouselContent', 'latestCarouselContent', 'collections', 'content', 'interestsCollections'];
    const visit = (v, depth) => {
      if (!v || depth > 3) return;
      if (Array.isArray(v)) { v.forEach(x => visit(x, depth + 1)); return; }
      if (typeof v !== 'object') return;
      if (v.relationTo && v.value) { visit(v.value, depth); return; }
      if (isVideo(v) || isCollection(v)) { out.push(v); return; }
      keys.forEach(k => { if (v[k]) visit(v[k], depth + 1); });
    };
    ['items', 'carouselContent', 'latestCarouselContent', 'collections', 'interestsCollections'].forEach(k => { if (block[k]) visit(block[k], 0); });
    return out;
  }
  function blockTitle(block, index) {
    if (block.forYouColor !== undefined) return block.title || 'For you';
    if (block.yourInterestsColor !== undefined) return block.title || 'Your interests';
    return block.title || block.carouselTitle || (index === 0 ? 'Featured' : '');
  }

  async function home() {
    const signed = isSignedIn();
    const level = await userLevel();
    ensureIndex().catch(() => {});   // the home page doesn't wait for the index; "next episode" needs it
    const both = await Promise.all([
      cached('home:' + signed, 300000, () => gql(Q.home)),
      signed ? gql(Q.continueWatching, { limit: 30 }).catch(() => null) : null,
    ]);
    const page = both[0], cw = both[1];
    const rows = [];
    let hero = [];

    if (cw && cw.continueWatching) {
      const docs = cw.continueWatching.docs.filter(d => d.content && isVideo(d.content));
      const progress = {};
      docs.forEach(d => { progress[d.content.id] = Math.min(1, (d.videoProgress || 0) / 100); });
      const unfinished = docs.filter(d => (d.videoProgress || 0) < 92);
      if (unfinished.length) rows.push({ title: 'Continue watching', items: unfinished.map(d => videoCard(d.content, level, progress)) });

      // Next up: for series whose last watched episode is finished, the episode after it
      const next = [];
      const seenSeries = new Set();
      for (const d of docs) {
        const s = d.content.primaryCollection;
        if (!s || seenSeries.has(s.id)) continue;
        seenSeries.add(s.id);
        if ((d.videoProgress || 0) < 92) continue;
        const list = seriesVideos(s.id);
        const i = list.findIndex(v => v.id === d.content.id);
        const candidate = i >= 0 ? list[i + 1] : null;
        if (candidate && !docs.some(x => x.content.id === candidate.id)) next.push(candidate);
        if (next.length >= 12) break;
      }
      if (next.length) rows.push({ title: 'Next episode', items: next.map(v => videoCard(v, level)) });
    }

    const blocks = (page.MemberHomePage && page.MemberHomePage.pageContent) || [];
    blocks.forEach((block, i) => {
      const items = blockItems(block);
      if (!items.length) return;
      const cards = items.map(c => isCollection(c) ? seriesCard(c) : videoCard(c, level));
      if (!hero.length && i === 0 && cards.some(c => c.kind === 'video')) {
        // the first carousel becomes the big banner at the top instead of a row
        hero = items.filter(isVideo).slice(0, 6).map(c => {
          const own = c.thumbnail && c.thumbnail.sizes && c.thumbnail.sizes.landscape && c.thumbnail.sizes.landscape.url;
          const known = videoBySlug(c.slug);
          return Object.assign(videoCard(c, level), { image: img(own || (known && known.image), 1280) });
        });
        return;
      }
      rows.push({ title: blockTitle(block, i), items: cards });
    });
    return { signedIn: signed, hero: hero, rows: rows.filter(r => r.items.length) };
  }

  async function seriesList() {
    await ensureIndex();
    const latest = {};
    videos.forEach(v => { if (v.series && !latest[v.series.id]) latest[v.series.id] = v.released; });
    const all = collections.slice().sort((a, b) => Date.parse(latest[b.id] || b.released || 0) - Date.parse(latest[a.id] || a.released || 0));
    const card = (c) => ({ kind: 'series', slug: c.slug, title: c.name, image: img(c.image || c.portrait, 480), count: c.itemCount });
    return { series: all.filter(c => c.isSeries).map(card), collections: all.filter(c => !c.isSeries && c.itemCount).map(card) };
  }

  async function collection(slug) {
    await ensureIndex();
    const c = collectionBySlug(slug);
    if (!c) throw new Error('Series not found.');
    const level = await userLevel();
    const seasons = await cached('collection:' + slug + ':' + isSignedIn(), 600000, async () => {
      if (c.isSeries) {
        const first = await gql(Q.series, { collection: c.id, limit: 1000 });
        const info = first.fetchSeries.collection;
        const list = ((info && info.series) || []).slice().sort((a, b) => a.seasonNumber - b.seasonNumber);
        if (list.length <= 1) return [{ title: 'Episodes', docs: first.fetchSeries.docs.map(d => d.content) }];
        return Promise.all(list.map(s => gql(Q.series, { collection: c.id, season: s.id, limit: 1000 })
          .then(r => ({ title: 'Season ' + s.seasonNumber, docs: r.fetchSeries.docs.map(d => d.content) }))));
      }
      const docs = [];
      for (let page = 1, total = 1; page <= total && page <= 20; page++) {
        const r = await gql(Q.search, { collection: c.id, types: PLAYABLE, sort: '-releaseDate', page: page, limit: 100 });
        total = r.search.totalPages;
        docs.push.apply(docs, r.search.docs);
      }
      return [{ title: 'Videos', docs: docs }];
    });
    const progress = await progressFor([].concat.apply([], seasons.map(s => s.docs.map(d => d.id))));
    return {
      slug: c.slug, title: c.name, image: img(c.image || c.portrait, 1280), isSeries: c.isSeries,
      seasons: seasons.map(s => ({ title: s.title, items: s.docs.filter(isVideo).map(d => videoCard(d, level, progress)) })).filter(s => s.items.length),
    };
  }

  async function content(slug) {
    const r = await gql(Q.content, { slug: slug });
    const doc = r.Contents && r.Contents.docs[0];
    if (!doc) throw new Error('Video not found.');
    await ensureIndex().catch(() => {});
    const level = await userLevel();
    const video = doc.contentVideo && doc.contentVideo.video;
    const series = doc.primaryCollection;
    const rows = [];

    if (series && series.isSeries) {
      const s = await gql(Q.series, { collection: series.id, content: doc.id, limit: 1 }).catch(() => null);
      const next = s && s.fetchSeries && s.fetchSeries.next;
      if (next) rows.push({ title: 'Next episode', items: [videoCard(next, level)] });
    }
    const versions = otherVersions(videoBySlug(slug));
    if (versions.length) rows.push({ title: 'Other versions', items: versions.map(v => videoCard(v, level)) });
    if (series) {
      const list = seriesVideos(series.id);
      const i = list.findIndex(v => v.slug === slug);
      // the episodes after this one; for the newest episode, the ones before it
      let around = i >= 0 ? list.slice(i + 1, i + 13) : [];
      if (!around.length) around = list.filter(v => v.slug !== slug).slice(-12).reverse();
      if (around.length) rows.push({ title: 'More from ' + series.name, items: around.map(v => videoCard(v, level)) });
    }
    const suggested = [].concat.apply([], (doc.content || []).map(b => (b && b.carouselContent) || [])).filter(isVideo);
    if (suggested.length) rows.push({ title: 'Recommended', items: suggested.map(c => videoCard(c, level)) });
    const ids = Array.from(new Set([].concat.apply([], rows.map(row => row.items.map(i => i.id)))));
    const progress = await progressFor(ids);
    rows.forEach(row => row.items.forEach(i => { i.progress = progress[i.id] || 0; }));

    const cp = r.currentProgress;
    return {
      id: doc.id, slug: doc.slug, title: doc.title, description: doc.description || '',
      image: img(doc.thumbnail && doc.thumbnail.sizes && doc.thumbnail.sizes.landscape && doc.thumbnail.sizes.landscape.url, 1280),
      minutes: minutes(doc.duration), released: doc.releaseDate,
      series: series ? { slug: series.slug, title: series.name } : null,
      tier: doc.contentTier ? doc.contentTier.name : null,
      playable: Boolean(video && video.video), locked: !(video && video.video),
      signInNeeded: !(video && video.video) && !isSignedIn(),
      resumeAt: cp && cp.videoProgress < 95 ? cp.videoProgressSeconds || 0 : 0,
      rows: rows,
    };
  }

  // Captions from JW Player's playlist data
  function captionsOf(video) {
    const out = [];
    try {
      const data = JSON.parse(video.videoData || '{}');
      const item = data.playlist && data.playlist[0];
      ((item && item.tracks) || []).forEach(t => {
        if (t.kind === 'captions' || t.kind === 'subtitles') out.push({ label: t.label || 'Subtitles', url: t.file });
      });
    } catch (e) { /* no playlist data */ }
    if (!out.length && typeof video.closedCaptions === 'string' && /^https?:/.test(video.closedCaptions)) out.push({ label: 'Subtitles', url: video.closedCaptions });
    return out;
  }
  // The stream itself (plain HLS from JW Player) goes straight to the TV's player
  async function play(slug) {
    const r = await gql(Q.media, { slug: slug });
    const doc = r.Contents && r.Contents.docs[0];
    const video = doc && doc.contentVideo && doc.contentVideo.video;
    if (!video || !video.video) return null;
    const cp = r.currentProgress;
    return {
      id: doc.id, url: video.video,
      duration: doc.duration ? Math.round(doc.duration / 1000) : null,
      resumeAt: cp && cp.videoProgress < 95 ? cp.videoProgressSeconds || 0 : 0,
      captions: captionsOf(video),
    };
  }
  // A caption file's text (fetched by the service: JW Player's caption host sends no CORS headers)
  function captionText(url) {
    return call('text', { url: url }).then(r => {
      if (r.status >= 400) throw new Error('HTTP ' + r.status);
      return r.text;
    });
  }

  async function search(q) {
    await ensureIndex();
    const level = await userLevel();
    const local = localSearch(q);
    const remote = await gql(Q.search, { q: q, types: PLAYABLE, page: 1, limit: 20 }).catch(() => null);
    const found = local.videos.slice();
    ((remote && remote.search.docs) || []).forEach(d => { if (!found.some(v => v.id === d.id)) found.push(d); });
    return {
      series: local.collections.map(c => ({ kind: 'series', slug: c.slug, title: c.name, image: img(c.image || c.portrait, 480), count: c.itemCount })),
      videos: found.slice(0, 48).map(v => videoCard(v, level)),
    };
  }
  function suggest(q) {
    return ensureIndex().then(() => ({ suggestions: localSuggest(q) }));
  }

  // Watch progress, sent the way beacon.tv sends it (keeps "Continue watching" in sync everywhere)
  function progress(p) {
    if (!isSignedIn() || !p.id || !(p.position >= 0)) return Promise.resolve({ ok: false });
    const event = {
      content: String(p.id), viewedAt: new Date().toISOString(), sessionId: sessionId,
      duration: Math.round(p.duration || 0), videoProgressSeconds: Math.round(p.position),
      videoProgress: p.duration ? Math.min(100, Math.round(p.position / p.duration * 100)) : 0,
    };
    return gql(Q.track, { events: [event] }).then(r => ({ ok: Boolean(r.trackView && r.trackView.success) }));
  }

  return {
    isSignedIn: isSignedIn, signIn: signIn, signOut: signOut, status: status, ensureIndex: ensureIndex,
    home: home, seriesList: seriesList, collection: collection, content: content, play: play, captionText: captionText,
    search: search, suggest: suggest, progress: progress,
  };
})();
