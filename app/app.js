// Beacon TV app (2026-10-25, self-contained since 2026-10-26): browse, search and watch Beacon on the LG TV.
// Data comes from backend.js (Beacon's API through the app's own service); sign-in with the TV keyboard.
// Written for the TV's older web engine: no optional chaining, nullish coalescing or other post-2019 syntax.
(function () {
  'use strict';

  const KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 461, ESC: 27, BACKSPACE: 8,
    PLAY: 415, PAUSE: 19, PLAYPAUSE: 10252, STOP: 413, FF: 417, REW: 412 };
  const B = window.Backend;
  const screenEl = document.getElementById('screen');
  let stack = [];          // [{ name, params, focusKey, scroll }]
  let current = null;      // { onKey, destroy }
  let status = null;       // Backend.status()
  let renderToken = 0;

  // ---------- small DOM helpers ----------
  function h(tag, props, children) {
    const e = document.createElement(tag);
    Object.keys(props || {}).forEach(k => {
      const v = props[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k === 'act') { e._act = v; e.addEventListener('click', () => v()); }
      else e.setAttribute(k, v);
    });
    (children || []).forEach(c => { if (c !== null && c !== undefined && c !== false) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  // a focusable element; key identifies it when coming back to this screen
  const fh = (tag, cls, key, act, children, extra) => h(tag, Object.assign({ class: cls + ' f', tabindex: '-1', 'data-key': key, act: act }, extra || {}), children);

  let toastTimer = null;
  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 5000);
  }
  const clock = (s) => {
    s = Math.max(0, Math.floor(s || 0));
    const hh = Math.floor(s / 3600), mm = Math.floor(s / 60) % 60, ss = s % 60;
    return (hh ? hh + ':' + String(mm).padStart(2, '0') : mm) + ':' + String(ss).padStart(2, '0');
  };

  // ---------- focus and spatial navigation ----------
  function scope() {
    const p = document.getElementById('player');
    return p.hidden ? screenEl : p;
  }
  const focusables = () => Array.prototype.filter.call(scope().querySelectorAll('.f'), e => e.offsetParent !== null);

  function focus(e) {
    if (!e) return;
    e.focus();
    ensureVisible(e);
  }
  function ensureVisible(e) {
    const strip = e.closest('.strip');
    if (strip) {
      const r = e.getBoundingClientRect(), s = strip.getBoundingClientRect(), pad = 80;
      if (r.left < s.left + pad) strip.scrollLeft -= (s.left + pad - r.left);
      else if (r.right > s.right - pad) strip.scrollLeft += r.right - (s.right - pad);
    }
    const sc = e.closest('.scroll');
    if (sc) {
      const r = e.getBoundingClientRect(), s = sc.getBoundingClientRect();
      const row = e.closest('.row') || e;
      const rr = row.getBoundingClientRect();
      if (rr.top < s.top + 20) sc.scrollTop -= (s.top + 20 - rr.top);
      else if (r.bottom > s.bottom - 60) sc.scrollTop += r.bottom - (s.bottom - 60);
    }
  }
  function move(dir) {
    const list = focusables(), cur = document.activeElement;
    if (!cur || list.indexOf(cur) < 0) { focus(list[0]); return; }
    const a = cur.getBoundingClientRect(), ax = a.left + a.width / 2, ay = a.top + a.height / 2;
    let best = null, bestD = Infinity;
    list.forEach(e => {
      if (e === cur) return;
      const b = e.getBoundingClientRect(), bx = b.left + b.width / 2, by = b.top + b.height / 2;
      let main, cross;
      if (dir === 'left') { main = ax - bx; cross = Math.abs(by - ay) * 4; }
      else if (dir === 'right') { main = bx - ax; cross = Math.abs(by - ay) * 4; }
      else if (dir === 'up') { main = ay - by; cross = Math.abs(bx - ax) * 0.6; }
      else { main = by - ay; cross = Math.abs(bx - ax) * 0.6; }
      if (main < 6) return;
      const d = main + cross;
      if (d < bestD) { bestD = d; best = e; }
    });
    if (best) focus(best);
  }

  // ---------- screens and history ----------
  const SCREENS = {};
  function saveFocus() {
    const top = stack[stack.length - 1];
    if (!top) return;
    const a = document.activeElement;
    top.focusKey = a && a.getAttribute ? a.getAttribute('data-key') : null;
    const sc = screenEl.querySelector('.scroll');
    top.scroll = sc ? sc.scrollTop : 0;
  }
  function go(name, params) { saveFocus(); stack.push({ name: name, params: params || {} }); render(); }
  function root(name, params) { stack = [{ name: name, params: params || {} }]; render(); }
  function back() {
    if (stack.length > 1) { stack.pop(); render(); }
    else if (stack[0].name !== 'home') root('home');
    else window.close();
  }
  function render() {
    const top = stack[stack.length - 1];
    const token = ++renderToken;
    if (current && current.destroy) current.destroy();
    current = {};
    screenEl.innerHTML = '';
    const page = h('div', { class: 'page' });
    screenEl.appendChild(page);
    page.appendChild(h('div', { class: 'loading', text: 'Loading…' }));
    Promise.resolve(SCREENS[top.name](page, top.params, current)).then(() => {
      if (token !== renderToken) return;
      const loading = page.querySelector('.loading');
      if (loading) loading.remove();
      const sc = page.querySelector('.scroll');
      if (sc && top.scroll) sc.scrollTop = top.scroll;
      let target = top.focusKey ? page.querySelector('[data-key="' + top.focusKey + '"]') : null;
      if (!target) target = page.querySelector('.f[data-default]') || focusables().filter(e => !e.closest('.nav'))[0] || focusables()[0];
      focus(target);
    }).catch(err => {
      if (token !== renderToken) return;
      page.innerHTML = '';
      page.appendChild(nav(top.name));
      page.appendChild(h('div', { class: 'center' }, [
        h('h1', { text: 'Something went wrong' }),
        h('p', { text: err.message }),
        fh('div', 'btn', 'retry', () => render(), ['Try again'], { 'data-default': '1' }),
      ]));
      focus(page.querySelector('[data-default]'));
    });
  }

  // ---------- shared building blocks ----------
  function nav(active) {
    const tabs = [['home', 'Home'], ['series', 'Series'], ['search', 'Search'], ['settings', 'Settings']];
    return h('div', { class: 'nav' }, [h('span', { class: 'logo', text: 'BEACON' })].concat(
      tabs.map(t => fh('span', 'tab' + (t[0] === active ? ' on' : ''), 'nav-' + t[0], () => root(t[0]), [t[1]])),
      [h('span', { class: 'user', text: status && status.user ? status.user.name : (status ? 'Not signed in' : '') })]));
  }
  function open(item) {
    if (item.kind === 'series') go('collection', { slug: item.slug });
    else go('detail', { slug: item.slug });
  }
  function card(item, key, small) {
    const pic = h('div', { class: 'pic' }, [
      item.image ? h('img', { src: item.image, loading: 'lazy', alt: '' }) : null,
      item.locked ? h('div', { class: 'lock', text: 'Members' }) : null,
      item.minutes ? h('div', { class: 'dur', text: item.minutes + ' min' }) : (item.count ? h('div', { class: 'dur', text: item.count + ' videos' }) : null),
      item.progress > 0.01 ? h('div', { class: 'bar', style: 'width:' + Math.round(item.progress * 100) + '%' }) : null,
    ]);
    return fh('div', 'card' + (item.kind === 'series' ? ' series' : '') + (small ? ' small' : ''), key, () => open(item),
      [pic, h('div', { class: 't', text: item.title }), item.subtitle ? h('div', { class: 's', text: item.subtitle }) : null]);
  }
  function row(r, key, small) {
    return h('div', { class: 'row' }, [
      r.title ? h('h2', { text: r.title }) : null,
      h('div', { class: 'strip' }, r.items.map((it, i) => card(it, key + '-' + i, small))),
    ]);
  }
  function grid(items, key, small) {
    return h('div', { class: 'grid' }, items.map((it, i) => card(it, key + '-' + i, small)));
  }

  // ---------- home ----------
  SCREENS.home = (page, p, ctx) => B.home().then(d => {
    page.appendChild(nav('home'));
    const sc = h('div', { class: 'scroll', style: 'top:0;padding-top:0' });
    page.appendChild(sc);
    if (d.hero && d.hero.length) sc.appendChild(hero(d.hero, ctx));
    else sc.appendChild(h('div', { style: 'height:130px' }));
    if (!d.signedIn) sc.appendChild(h('div', { class: 'row' }, [h('h2', { text: 'Not signed in: you only see free videos. Sign in under Settings.' })]));
    d.rows.forEach((r, i) => sc.appendChild(row(r, 'r' + i)));
  });

  function hero(items, ctx) {
    let i = 0;
    const bg = h('div', { class: 'bg' });
    const title = h('h1');
    const meta = h('div', { class: 'meta' });
    const dots = h('div', { class: 'dots' }, items.map(() => h('span')));
    const show = () => {
      const it = items[i];
      bg.style.backgroundImage = it.image ? 'url("' + it.image + '")' : '';
      title.textContent = it.title;
      meta.textContent = [it.subtitle, it.minutes ? it.minutes + ' min' : '', it.locked ? 'Members only' : ''].filter(Boolean).join('  ·  ');
      Array.prototype.forEach.call(dots.children, (d, k) => { d.className = k === i ? 'on' : ''; });
    };
    const playBtn = fh('div', 'btn', 'hero-play', () => startPlayback(items[i].slug), [h('span', { class: 'ico', text: '▶' }), 'Play'], { 'data-default': '1' });
    const infoBtn = fh('div', 'btn', 'hero-info', () => go('detail', { slug: items[i].slug }), ['More info']);
    const el = h('div', { class: 'hero' }, [bg, h('div', { class: 'shade' }),
      h('div', { class: 'info' }, [title, meta, playBtn, infoBtn]), dots]);
    show();
    // rotate every 9 s unless the banner buttons have focus
    const timer = setInterval(() => {
      if (el.contains(document.activeElement)) return;
      i = (i + 1) % items.length;
      show();
    }, 9000);
    ctx.destroy = () => clearInterval(timer);
    return el;
  }

  // ---------- series ----------
  SCREENS.series = (page) => B.seriesList().then(d => {
    page.appendChild(nav('series'));
    const sc = h('div', { class: 'scroll' });
    page.appendChild(sc);
    sc.appendChild(h('div', { class: 'section', text: 'Series' }));
    sc.appendChild(grid(d.series, 's'));
    if (d.collections.length) {
      sc.appendChild(h('div', { class: 'section', text: 'Collections' }));
      sc.appendChild(grid(d.collections, 'c'));
    }
  });

  // ---------- one series or collection ----------
  SCREENS.collection = (page, p) => B.collection(p.slug).then(d => {
    page.appendChild(nav(''));
    const sc = h('div', { class: 'scroll' });
    page.appendChild(sc);
    sc.appendChild(h('div', { class: 'title-big', text: d.title }));
    if (!d.seasons.length) { sc.appendChild(h('div', { class: 'section', text: 'No videos found.' })); return; }
    if (p.season === undefined) p.season = d.seasons.length - 1;   // newest season first
    const holder = h('div');
    const tabs = h('div', { class: 'tabs' }, d.seasons.length > 1 ? d.seasons.map((s, i) =>
      fh('span', 'tab' + (i === p.season ? ' on' : ''), 'season-' + i, () => { p.season = i; draw(); }, [s.title + ' (' + s.items.length + ')'])) : []);
    sc.appendChild(tabs);
    sc.appendChild(holder);
    function draw() {
      Array.prototype.forEach.call(tabs.children, (t, i) => { t.className = 'tab f' + (i === p.season ? ' on' : ''); });
      holder.innerHTML = '';
      holder.appendChild(grid(d.seasons[p.season].items, 'e' + p.season));
    }
    draw();
    const firstUnwatched = d.seasons[p.season].items.findIndex(it => it.progress < 0.92);
    const def = holder.querySelector('[data-key="e' + p.season + '-' + Math.max(0, firstUnwatched) + '"]');
    if (def) def.setAttribute('data-default', '1');
  });

  // ---------- details of one video ----------
  SCREENS.detail = (page, p) => B.content(p.slug).then(d => {
    page.className = 'page detail';
    page.appendChild(h('div', { class: 'bg', style: d.image ? 'background-image:url("' + d.image + '")' : '' }));
    page.appendChild(h('div', { class: 'shade' }));
    page.appendChild(nav(''));
    const sc = h('div', { class: 'scroll', style: 'top:0' });
    page.appendChild(sc);
    const buttons = [];
    if (d.playable) {
      if (d.resumeAt > 30) {
        buttons.push(fh('div', 'btn', 'resume', () => startPlayback(d.slug), [h('span', { class: 'ico', text: '▶' }), 'Resume (' + clock(d.resumeAt) + ')'], { 'data-default': '1' }));
        buttons.push(fh('div', 'btn', 'start', () => startPlayback(d.slug, { fromStart: true }), ['From the beginning']));
      } else {
        buttons.push(fh('div', 'btn', 'play', () => startPlayback(d.slug, { fromStart: true }), [h('span', { class: 'ico', text: '▶' }), 'Play'], { 'data-default': '1' }));
      }
    }
    if (d.series) buttons.push(fh('div', 'btn', 'series', () => go('collection', { slug: d.series.slug }), ['All episodes'], buttons.length ? null : { 'data-default': '1' }));
    const meta = [d.minutes ? d.minutes + ' min' : '', d.released ? new Date(d.released).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '', d.tier === 'Free' ? 'Free' : ''].filter(Boolean).join('  ·  ');
    sc.appendChild(h('div', { class: 'info' }, [
      d.series ? h('div', { class: 'series', text: d.series.title }) : null,
      h('h1', { text: d.title }),
      h('div', { class: 'meta', text: meta }),
      d.description ? h('div', { class: 'desc', text: d.description }) : null,
      d.signInNeeded ? h('div', { class: 'note', text: 'This video is for members. Sign in under Settings to watch it.' }) :
        (!d.playable ? h('div', { class: 'note', text: 'This video is not included in your membership.' }) : null),
      h('div', {}, buttons),
    ]));
    d.rows.forEach((r, i) => sc.appendChild(row(r, 'r' + i)));
    if (!buttons.length) { const first = sc.querySelector('.card'); if (first) first.setAttribute('data-default', '1'); }
  });

  // ---------- search ----------
  SCREENS.search = (page, p, ctx) => {
    page.className = 'page search';
    page.appendChild(nav('search'));
    p.q = p.q || '';
    const queryEl = h('div', { class: 'query' });
    const right = h('div', { class: 'right' });
    const scroller = h('div', { class: 'scroll', style: 'top:0' });
    right.appendChild(scroller);
    const keys = 'abcdef ghijkl mnopqr stuvwx yz1234 567890'.split(' ');
    const kb = h('div', { class: 'kb' }, keys.map((rowKeys, r) => h('div', {}, rowKeys.split('').map(c =>
      fh('span', 'k', 'k-' + c, () => type(c), [c.toUpperCase()], r === 0 && c === 'a' ? { 'data-default': '1' } : null)))).concat([
      h('div', {}, [
        fh('span', 'k wide', 'k-space', () => type(' '), ['Space']),
        fh('span', 'k wide', 'k-del', () => type('\b'), ['⌫ Delete']),
        fh('span', 'k wide', 'k-clear', () => { p.q = ''; update(); }, ['Clear']),
      ]),
    ]));
    page.appendChild(h('div', { class: 'left' }, [queryEl, kb]));
    page.appendChild(right);

    let suggestTimer = null, searchTimer = null, seq = 0;
    function type(c) {
      p.q = c === '\b' ? p.q.slice(0, -1) : (p.q + c).replace(/^ /, '');
      update();
    }
    function update() {
      queryEl.innerHTML = '';
      queryEl.appendChild(p.q ? document.createTextNode(p.q) : h('span', { class: 'ph', text: 'Type to search…' }));
      clearTimeout(suggestTimer);
      clearTimeout(searchTimer);
      if (!p.q.trim()) { showStart(); return; }
      suggestTimer = setTimeout(suggest, 200);
      searchTimer = setTimeout(search, 650);
    }
    let chipsEl = null;
    function suggest() {
      const n = ++seq;
      B.suggest(p.q).then(d => {
        if (n !== seq && !chipsEl) return;
        drawChips(d.suggestions);
      }).catch(() => {});
    }
    function drawChips(list) {
      if (!chipsEl) { chipsEl = h('div', { class: 'chips' }); scroller.insertBefore(chipsEl, scroller.firstChild); }
      chipsEl.innerHTML = '';
      list.forEach((s, i) => chipsEl.appendChild(fh('span', 'chip', 'chip-' + i, () => { p.q = s.toLowerCase(); update(); search(); }, [s])));
    }
    function search() {
      const n = ++seq;
      const q = p.q;
      B.search(q).then(d => {
        if (n !== seq) return;
        const keepChips = chipsEl;
        scroller.innerHTML = '';
        if (keepChips) scroller.appendChild(keepChips);
        if (d.series.length) {
          scroller.appendChild(h('div', { class: 'section', text: 'Series' }));
          scroller.appendChild(h('div', { class: 'row' }, [h('div', { class: 'strip' }, d.series.map((it, i) => card(it, 'rs-' + i, true)))]));
        }
        scroller.appendChild(h('div', { class: 'section', text: d.videos.length ? 'Videos' : '' }));
        if (d.videos.length) scroller.appendChild(grid(d.videos, 'rv', true));
        else scroller.appendChild(h('div', { class: 'empty', text: 'Nothing found for "' + q + '".' }));
      }).catch(err => toast(err.message));
    }
    function showStart() {
      chipsEl = null;
      scroller.innerHTML = '';
      scroller.appendChild(h('div', { class: 'empty', text: 'Search by title, series, character or episode code (e.g. c4e12).' }));
      B.seriesList().then(d => {
        if (p.q) return;
        scroller.appendChild(h('div', { class: 'section', text: 'Popular series' }));
        scroller.appendChild(grid(d.series.slice(0, 9), 'ps', true));
      }).catch(() => {});
    }
    update();
    if (p.q) search();
    ctx.onKey = (e) => {
      // letters and digits from a keyboard or the remote's number keys
      if (e.key && e.key.length === 1 && /[a-z0-9 ]/i.test(e.key)) { type(e.key.toLowerCase()); return true; }
      if (e.keyCode === KEY.BACKSPACE && p.q) { type('\b'); return true; }
      return false;
    };
    ctx.destroy = () => { clearTimeout(suggestTimer); clearTimeout(searchTimer); };
  };

  // ---------- settings ----------
  SCREENS.settings = (page) => refreshStatus().then(() => {
    page.appendChild(nav('settings'));
    const who = status.signedIn ? 'Signed in as ' + (status.user ? status.user.name : 'member') + (status.user && status.user.tier ? ' (' + status.user.tier + ')' : '') : 'Not signed in to Beacon';
    const index = status.catalog.videos ? status.catalog.videos + ' videos in the search index' : 'Search index not built yet';
    page.appendChild(h('div', { class: 'center', style: 'padding-top:260px' }, [
      h('h1', { text: 'Settings' }),
      h('p', { text: who }),
      h('p', { text: index }),
      h('br'),
      status.signedIn
        ? fh('div', 'btn', 'logout', () => { B.signOut(); refreshStatus().then(() => root('signin')); }, ['Sign out of Beacon'], { 'data-default': '1' })
        : fh('div', 'btn', 'login', () => root('signin'), ['Sign in'], { 'data-default': '1' }),
    ]));
  });

  // ---------- sign-in with the TV keyboard (the password goes to Beacon's sign-in service only) ----------
  SCREENS.signin = (page, p) => {
    // The remote moves between the boxes; OK on a box puts the cursor in its field, which opens LG's keyboard
    const email = h('input', { class: 'inner', type: 'email', tabindex: '-1', spellcheck: 'false', autocomplete: 'off',
      placeholder: 'Email address', value: p.email || '' });
    const password = h('input', { class: 'inner', type: 'password', tabindex: '-1', placeholder: 'Password' });
    const emailBox = fh('div', 'field', 'email', () => email.focus(), [email], p.email ? null : { 'data-default': '1' });
    const passwordBox = fh('div', 'field', 'password', () => password.focus(), [password], p.email ? { 'data-default': '1' } : null);
    const msg = h('p', { class: 'err', text: p.error || '' });
    // typing on LG's keyboard is error-prone; let people check what they typed
    const reveal = fh('div', 'btn', 'reveal', () => {
      password.type = password.type === 'password' ? 'text' : 'password';
      reveal.textContent = password.type === 'password' ? 'Show password' : 'Hide password';
    }, ['Show password']);
    const submit = () => {
      p.email = email.value;
      if (!email.value.trim() || !password.value) { msg.textContent = 'Enter your email address and password.'; return; }
      msg.textContent = 'Signing in…';
      B.signIn(email.value, password.value).then(refreshStatus).then(() => {
        toast('Signed in as ' + (status.user ? status.user.name : 'member'));
        root('home');
      }).catch(err => {
        // the password stays, so it can be checked with "Show password" and corrected
        msg.textContent = err.message + (password.type === 'password' ? ' Use "Show password" to check what you typed.' : '');
        focus(passwordBox);
      });
    };
    email.addEventListener('keydown', e => { if (e.keyCode === KEY.ENTER) { e.preventDefault(); password.focus(); } });
    password.addEventListener('keydown', e => { if (e.keyCode === KEY.ENTER) { e.preventDefault(); password.blur(); submit(); } });
    // high on the screen: LG's on-screen keyboard covers the lower 40 % while a field has focus
    page.appendChild(h('div', { class: 'center', style: 'padding-top:70px' }, [
      h('h1', { text: 'Sign in to Beacon' }),
      h('p', { text: 'Use the email address and password of your Beacon account. Your password is not stored on the TV.' }),
      emailBox, h('br'), h('br'), passwordBox,
      msg,
      fh('div', 'btn', 'signin', submit, ['Sign in']),
      reveal,
      fh('div', 'btn', 'later', () => root('home'), ['Later (free videos only)']),
    ]));
  };
  function refreshStatus() { return B.status().then(s => { status = s; return s; }); }

  // ---------- player ----------
  const P = {
    el: document.getElementById('player'), video: document.getElementById('video'), cue: document.getElementById('cue'),
    title: document.getElementById('osd-title'), fill: document.getElementById('osd-fill'), time: document.getElementById('osd-time'),
    buttons: document.getElementById('osd-buttons'), upnext: document.getElementById('upnext'),
    slug: null, id: null, osdTimer: null, lastReport: 0, captions: [], capIndex: -1, cues: [], nextTimer: null, next: null,
  };

  function startPlayback(slug, opts) {
    opts = opts || {};
    B.play(slug).then(d => {
      if (!d || !d.url) throw new Error(B.isSignedIn() ? 'This video is not included in your membership.' : 'This video is for members only.');
      return B.content(slug).catch(() => null).then(info => openPlayer(slug, d, info, opts));
    }).catch(err => toast(err.message));
  }

  function openPlayer(slug, d, info, opts) {
    saveFocus();
    P.slug = slug;
    P.id = d.id;
    P.title.textContent = info ? info.title : '';
    P.captions = d.captions || [];
    P.capIndex = -1;
    P.cues = [];
    P.cue.textContent = '';
    P.lastReport = 0;
    const nextRow = info && info.rows ? info.rows.filter(r => r.title === 'Next episode')[0] : null;
    P.next = nextRow && nextRow.items[0] && !nextRow.items[0].locked ? nextRow.items[0] : null;
    P.upnext.hidden = true;
    clearInterval(P.nextTimer);
    P.el.hidden = false;
    P.el.className = 'wait';
    const startAt = opts.fromStart ? 0 : (d.resumeAt || 0);
    P.video.src = d.url;
    P.video.onloadedmetadata = () => { if (startAt > 5) P.video.currentTime = startAt; };
    P.video.play().catch(() => {});
    drawButtons();
    showOsd();
  }
  function closePlayer() {
    report(true);
    P.video.pause();
    P.video.removeAttribute('src');
    P.video.load();
    P.el.hidden = true;
    clearTimeout(P.osdTimer);
    clearInterval(P.nextTimer);
    render();   // refresh the screen underneath (progress bars), keeping focus
  }
  function report(force) {
    const v = P.video;
    if (!P.id || !v.duration || !isFinite(v.duration)) return;
    const now = Date.now();
    if (!force && now - P.lastReport < 15000) return;
    P.lastReport = now;
    B.progress({ id: P.id, position: v.currentTime, duration: v.duration }).catch(() => {});
  }
  function drawButtons() {
    P.buttons.innerHTML = '';
    const capLabel = P.capIndex < 0 ? 'Subtitles: off' : 'Subtitles: ' + P.captions[P.capIndex].label;
    P.buttons.appendChild(fh('div', 'btn', 'p-play', togglePlay, [P.video.paused ? '▶ Play' : '❚❚ Pause']));
    P.buttons.appendChild(fh('div', 'btn', 'p-back', () => seek(-30), ['« 30 s']));
    P.buttons.appendChild(fh('div', 'btn', 'p-fwd', () => seek(30), ['30 s »']));
    if (P.captions.length) P.buttons.appendChild(fh('div', 'btn', 'p-cc', cycleCaptions, [capLabel]));
    if (P.next) P.buttons.appendChild(fh('div', 'btn', 'p-next', () => playNext(), ['Next episode']));
  }
  function showOsd(keepFocus) {
    P.el.classList.add('osd');
    clearTimeout(P.osdTimer);
    P.osdTimer = setTimeout(() => {
      if (P.video.paused) return;
      P.el.classList.remove('osd');
      if (document.activeElement && P.buttons.contains(document.activeElement)) document.activeElement.blur();
    }, 5000);
    if (keepFocus) return;
    updateOsd();
  }
  function updateOsd() {
    const v = P.video;
    const dur = isFinite(v.duration) ? v.duration : 0;
    P.fill.style.width = dur ? (v.currentTime / dur * 100) + '%' : '0';
    P.time.textContent = clock(v.currentTime) + ' / ' + clock(dur);
  }
  function togglePlay() {
    if (P.video.paused) P.video.play().catch(() => {}); else P.video.pause();
    drawButtons();
    showOsd();
    const b = P.buttons.querySelector('[data-key="p-play"]');
    if (b && P.buttons.contains(document.activeElement)) b.focus();
  }
  function seek(s) {
    const v = P.video;
    if (!isFinite(v.duration)) return;
    v.currentTime = Math.max(0, Math.min(v.duration - 2, v.currentTime + s));
    showOsd(true);
    updateOsd();
  }
  function cycleCaptions() {
    P.capIndex = P.capIndex + 1 >= P.captions.length ? -1 : P.capIndex + 1;
    P.cues = [];
    P.cue.textContent = '';
    if (P.capIndex >= 0) {
      B.captionText(P.captions[P.capIndex].url).then(t => { P.cues = parseVtt(t); }).catch(() => toast('Could not load the subtitles.'));
    }
    drawButtons();
    focus(P.buttons.querySelector('[data-key="p-cc"]'));
    showOsd(true);
  }
  function parseVtt(text) {
    const toSec = (t) => { const p = t.trim().split(':').map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]; };
    return text.replace(/\r/g, '').split('\n\n').map(block => {
      const lines = block.split('\n');
      const i = lines.findIndex(l => l.indexOf('-->') >= 0);
      if (i < 0) return null;
      const m = lines[i].split('-->');
      return { start: toSec(m[0]), end: toSec(m[1].trim().split(' ')[0]), text: lines.slice(i + 1).join('\n').replace(/<[^>]+>/g, '') };
    }).filter(Boolean);
  }
  function playNext() {
    if (!P.next) return;
    const slug = P.next.slug;
    report(true);
    clearInterval(P.nextTimer);
    startPlayback(slug, { fromStart: true });
  }

  P.video.addEventListener('timeupdate', () => {
    report(false);
    if (P.el.classList.contains('osd')) updateOsd();
    if (P.cues.length) {
      const t = P.video.currentTime;
      const c = P.cues.filter(x => t >= x.start && t <= x.end)[0];
      const text = c ? c.text : '';
      if (P.cue.textContent !== text) P.cue.textContent = text;
    }
  });
  P.video.addEventListener('waiting', () => P.el.classList.add('wait'));
  P.video.addEventListener('playing', () => { P.el.classList.remove('wait'); drawButtons(); });
  P.video.addEventListener('pause', () => { drawButtons(); showOsd(true); });
  // The usual cause: an ad blocker or Pi-hole on the network blocking JW Player, which hosts Beacon's video
  P.video.addEventListener('error', () => {
    if (P.el.hidden) return;
    toast('Playback failed. If you use an ad blocker or Pi-hole, allow jwplayer.com, jwpsrv.com and jwpcdn.com.');
    closePlayer();
  });
  P.video.addEventListener('ended', () => {
    report(true);
    if (!P.next) { closePlayer(); return; }
    let left = 10;
    P.upnext.innerHTML = '';
    P.upnext.appendChild(h('div', { text: 'Next episode in ' }));
    const count = h('span', { text: String(left) });
    P.upnext.firstChild.appendChild(count);
    P.upnext.appendChild(h('div', { class: 't', text: P.next.title }));
    P.upnext.appendChild(fh('div', 'btn', 'p-upnext', playNext, ['Play now'], { 'data-default': '1' }));
    P.upnext.hidden = false;
    focus(P.upnext.querySelector('.f'));
    P.nextTimer = setInterval(() => {
      left--;
      count.textContent = String(left);
      if (left <= 0) playNext();
    }, 1000);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && !P.el.hidden) { report(true); P.video.pause(); }
  });

  function playerKey(e) {
    const k = e.keyCode;
    const onButtons = document.activeElement && (P.buttons.contains(document.activeElement) || P.upnext.contains(document.activeElement));
    if (k === KEY.BACK || k === KEY.ESC || k === KEY.STOP) {
      if (!P.upnext.hidden) { clearInterval(P.nextTimer); P.upnext.hidden = true; closePlayer(); return; }
      if (onButtons && k !== KEY.STOP) { document.activeElement.blur(); P.el.classList.remove('osd'); return; }
      closePlayer();
      return;
    }
    if (k === KEY.PLAY || k === KEY.PAUSE || k === KEY.PLAYPAUSE) { togglePlay(); return; }
    if (k === KEY.FF) { seek(30); return; }
    if (k === KEY.REW) { seek(-30); return; }
    if (onButtons) {
      if (k === KEY.LEFT) move('left');
      else if (k === KEY.RIGHT) move('right');
      else if (k === KEY.ENTER && document.activeElement._act) document.activeElement._act();
      else if (k === KEY.DOWN) { document.activeElement.blur(); }
      showOsd(true);
      return;
    }
    if (k === KEY.ENTER) { togglePlay(); return; }
    if (k === KEY.LEFT) { seek(-10); return; }
    if (k === KEY.RIGHT) { seek(10); return; }
    if (k === KEY.UP || k === KEY.DOWN) { showOsd(); focus(P.buttons.querySelector('.f')); }
  }

  // ---------- keys ----------
  document.addEventListener('keydown', (e) => {
    const k = e.keyCode;
    if (!P.el.hidden) { e.preventDefault(); playerKey(e); return; }
    let a = document.activeElement;
    const inField = a && a.tagName === 'INPUT';
    if (inField && (k === KEY.LEFT || k === KEY.RIGHT || (k === KEY.BACKSPACE))) return;   // let the field edit
    // Leaving a field (keyboard closed): back to its box, from where the remote navigates as usual
    if (inField && (k === KEY.UP || k === KEY.DOWN || k === KEY.BACK || k === KEY.ESC) && a.parentNode.classList.contains('f')) {
      a.blur();
      a = a.parentNode;
      a.focus();
      if (k === KEY.BACK || k === KEY.ESC) { e.preventDefault(); return; }
    }
    if (current && current.onKey && current.onKey(e)) { e.preventDefault(); return; }
    if (k === KEY.LEFT) move('left');
    else if (k === KEY.RIGHT) move('right');
    else if (k === KEY.UP) move('up');
    else if (k === KEY.DOWN) move('down');
    else if (k === KEY.ENTER) { if (inField) return; if (a && a._act) a._act(); }
    else if (k === KEY.BACK || k === KEY.ESC || (k === KEY.BACKSPACE && !inField)) back();
    else return;
    e.preventDefault();
  });
  // LG's keyboard closed with Back: the cursor leaves the field, focus goes to its box. Typing on a USB keyboard
  // also hides LG's keyboard; then the field keeps focus (anything typed shortly before or after counts as typing).
  let lastTyped = 0, closeTimer = null;
  document.addEventListener('input', () => { lastTyped = Date.now(); }, true);
  document.addEventListener('keydown', (e) => { if (e.key && e.key.length === 1) lastTyped = Date.now(); }, true);
  document.addEventListener('keyboardStateChange', (e) => {
    clearTimeout(closeTimer);
    if (!e.detail || e.detail.visibility) return;
    closeTimer = setTimeout(() => {
      const a = document.activeElement;
      if (Date.now() - lastTyped < 1000 || PalmSystem.isKeyboardVisible) return;
      if (a && a.tagName === 'INPUT' && a.parentNode.classList.contains('f')) { a.blur(); a.parentNode.focus(); }
    }, 400);
  });

  // ---------- start ----------
  B.ensureIndex().catch(() => {});   // build or refresh the search index in the background
  refreshStatus().catch(() => { status = { signedIn: B.isSignedIn(), user: null, catalog: { videos: 0 } }; })
    .then(() => root(B.isSignedIn() ? 'home' : 'signin'));
})();
