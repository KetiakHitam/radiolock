// Radiolock player page. Runs inside Deadlock's HTML panel.
// Game to page: URL fragment "#s=<seq>&c=<json command list>". Page to game: document.title JSON.
(function () {
  'use strict';

  const VERSION = '1.0.0';
  const HELPER = 'http://127.0.0.1:47800';
  const SID = Math.random().toString(36).slice(2, 10);
  const YT_ID = /^[A-Za-z0-9_-]{11}$/;
  const el = (id) => document.getElementById(id);

  // ---------- page to game ----------
  let outN = 0;
  const outQ = [];
  let flushing = false;

  function send(t, d, urgent) {
    const msg = JSON.stringify({ t: t, n: ++outN, sid: SID, d: d || {} });
    if (urgent) outQ.unshift(msg); else outQ.push(msg);
    if (outQ.length > 80) outQ.splice(40, outQ.length - 80);
    if (!flushing) flush();
  }
  function flush() {
    if (!outQ.length) { flushing = false; return; }
    flushing = true;
    document.title = outQ.shift();
    setTimeout(flush, 20);
  }
  function log(msg) { send('log', { msg: String(msg).slice(0, 300) }); }

  // ---------- storage ----------
  function load(key, fallback) {
    try { const v = JSON.parse(localStorage.getItem(key) || 'null'); return v === null ? fallback : v; } catch (e) { return fallback; }
  }
  function save(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { log('storage write failed: ' + e.name); }
  }

  const S = Object.assign({
    source: 'youtube', folderPath: '', skipAds: true, visualizer: true, shuffle: true,
    rememberSong: false, onlineArt: true, browserZoom: 0
  }, load('rl_settings', {}));

  // ---------- helper ----------
  const helper = { on: false, checked: false, info: null, failStreak: 0 };

  async function hget(path, timeoutMs) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs || 20000);
    try {
      const r = await fetch(HELPER + path, { cache: 'no-store', signal: ctl.signal });
      return await r.json();
    } finally { clearTimeout(timer); }
  }

  async function checkHelper() {
    const was = helper.on;
    const first = !helper.checked;
    try {
      const j = await hget('/ping', 3000);
      helper.on = !!(j && j.ok && j.app === 'radiolock-helper');
      helper.info = j;
    } catch (e) {
      helper.on = false;
    }
    helper.checked = true;
    if (first || helper.on !== was) {
      send('helper', { on: helper.on, status: helper.info ? helper.info.status : '' });
      log('helper ' + (helper.on ? 'connected' : 'not running'));
      if (!first) onHelperChange();
    }
    renderStatus();
    setTimeout(checkHelper, helper.on ? 30000 : 10000);
  }

  // ---------- player state ----------
  const P = {
    engine: 'none',      // 'audio' | 'embed' | 'none'
    cur: null,           // { kind: 'yt' | 'folder', id, rel, title, author, duration }
    playing: false,
    vol: 30,
    adMuted: false,
    activated: false,
    pendingPlay: false,
    errors: 0
  };
  const Q = { items: [], idx: -1, mixFor: '' };          // YouTube queue (helper mode)
  const F = { files: [], path: '', idx: -1, recent: [], missing: false, loaded: false };
  let results = [];
  let listTab = 'results';
  const audio = el('audio');

  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function splitName(name) {
    const cut = name.indexOf(' - ');
    return cut > 0 ? { author: name.slice(0, cut).trim(), title: name.slice(cut + 3).trim() } : { author: '', title: name };
  }
  function thumb(id) { return 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg'; }
  function isUrl(t) { return /^https?:\/\//i.test(t) || /^(www\.)?(youtube\.com|youtu\.be|music\.youtube\.com)\//i.test(t); }

  // ---------- volume ----------
  let fadeTimer = null;
  function applyVol() {
    const v = P.adMuted ? 0 : Math.max(0, Math.min(100, P.vol));
    audio.volume = v / 100;
    if (embed.player && embed.ready) {
      try { if (P.adMuted) embed.player.mute(); else { embed.player.unMute(); embed.player.setVolume(Math.round(v)); } } catch (e) { log('embed volume: ' + e.message); }
    }
  }
  function setVol(v) { P.vol = Number(v) || 0; applyVol(); }
  function fadeTo(to, sec) {
    if (fadeTimer) { clearInterval(fadeTimer); fadeTimer = null; }
    const from = P.vol, ms = (Number(sec) || 0) * 1000, t0 = Date.now();
    if (!(ms > 60)) { setVol(to); return; }
    fadeTimer = setInterval(() => {
      const k = Math.min(1, (Date.now() - t0) / ms);
      setVol(from + (to - from) * k);
      if (k >= 1) { clearInterval(fadeTimer); fadeTimer = null; }
    }, 50);
  }

  // ---------- audio engine (helper YouTube and folder) ----------
  audio.addEventListener('playing', () => { P.playing = true; P.errors = 0; send('play'); renderNow(); vizSetup(); });
  audio.addEventListener('pause', () => { if (P.engine !== 'audio') return; P.playing = false; send('pause'); renderNow(); });
  audio.addEventListener('ended', () => { if (P.engine === 'audio') next(); });
  audio.addEventListener('error', () => {
    if (P.engine !== 'audio' || !audio.getAttribute('src')) return;
    P.errors++;
    const name = P.cur ? P.cur.title : 'song';
    log('cannot play ' + name + ' (code ' + (audio.error ? audio.error.code : '?') + ')');
    setNotice("Couldn't load " + name + (P.errors < 5 ? ', skipping.' : '.'));
    if (P.errors < 5) setTimeout(next, 1500);
  });

  function tryPlay() {
    if (P.engine === 'audio') {
      const pr = audio.play();
      if (pr && pr.catch) pr.catch((e) => { if (e.name === 'NotAllowedError') needClick(); else log('play failed: ' + e.name); });
    } else if (P.engine === 'embed' && embed.player && embed.ready) {
      embed.player.playVideo();
      setTimeout(() => { if (P.engine === 'embed' && !P.playing && !P.activated) needClick(); }, 2500);
    }
  }
  function pause() {
    if (P.engine === 'audio') audio.pause();
    else if (P.engine === 'embed' && embed.player && embed.ready) embed.player.pauseVideo();
  }
  function curTime() {
    if (P.engine === 'audio') return audio.currentTime || 0;
    if (P.engine === 'embed' && embed.player && embed.ready) return embed.player.getCurrentTime() || 0;
    return 0;
  }
  function curDur() {
    if (P.engine === 'audio') return isFinite(audio.duration) ? audio.duration : (P.cur ? P.cur.duration || 0 : 0);
    if (P.engine === 'embed' && embed.player && embed.ready) return embed.player.getDuration() || 0;
    return 0;
  }
  function seek(sec) {
    sec = Math.max(0, Number(sec) || 0);
    if (P.engine === 'audio') { try { audio.currentTime = sec; } catch (e) { log('seek failed: ' + e.name); } }
    else if (P.engine === 'embed' && embed.player && embed.ready) embed.player.seekTo(sec, true);
  }

  function useEngine(name) {
    if (P.engine === name) return;
    if (P.engine === 'audio') { audio.pause(); audio.removeAttribute('src'); audio.load(); }
    if (P.engine === 'embed' && embed.player && embed.ready) { try { embed.player.stopVideo(); } catch (e) { log('embed stop: ' + e.message); } }
    P.engine = name;
    P.playing = false;
    el('ytHost').style.visibility = name === 'embed' ? 'visible' : 'hidden';
  }

  function startAudio(src, autoplay, at) {
    useEngine('audio');
    audio.src = src;
    applyVol();
    if (at > 0) {
      const once = () => { audio.removeEventListener('loadedmetadata', once); try { audio.currentTime = at; } catch (e) { log('resume seek: ' + e.name); } };
      audio.addEventListener('loadedmetadata', once);
    }
    if (autoplay) tryPlay(); else audio.load();
  }

  // ---------- embed engine (no helper) ----------
  const embed = { player: null, ready: false, loading: false, queued: null, lastId: '' };

  function embedEnsure(then) {
    if (embed.ready) { then(); return; }
    embed.queued = then;
    if (embed.loading) return;
    embed.loading = true;
    window.onYouTubeIframeAPIReady = () => {
      embed.player = new YT.Player('ytHost', {
        width: 200, height: 113,
        playerVars: { autoplay: 0, playsinline: 1, rel: 0, controls: 0, disablekb: 1, iv_load_policy: 3 },
        events: {
          onReady: () => { embed.ready = true; applyVol(); const q = embed.queued; embed.queued = null; if (q) q(); },
          onStateChange: (e) => embedState(e.data),
          onError: (e) => {
            log('embed error ' + e.data);
            setNotice(e.data === 101 || e.data === 150 ? "This video can't play outside YouTube. Skipping." : "Couldn't play this video.");
            setTimeout(() => { try { embed.player.nextVideo(); } catch (err) { log('embed next: ' + err.message); } }, 1500);
          }
        }
      });
      ['onAdStart', 'onAdEnd'].forEach((ev) => {
        try { embed.player.addEventListener(ev, () => onAd(ev === 'onAdStart')); } catch (err) { log('ad hook ' + ev + ': ' + err.message); }
      });
      try { embed.player.addEventListener('onAutoplayBlocked', () => needClick()); } catch (err) { log('autoplay hook: ' + err.message); }
    };
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    tag.onerror = () => { embed.loading = false; setNotice("Couldn't reach YouTube."); };
    document.head.appendChild(tag);
  }

  function onAd(on) {
    send('ad', { on: on });
    if (!S.skipAds) return;
    P.adMuted = on;
    applyVol();
    setNotice(on ? 'Ad playing, muted until it ends.' : '');
  }

  function embedState(st) {
    if (P.engine !== 'embed') return;
    if (st === 1) { P.playing = true; P.errors = 0; send('play'); embedMeta(); }
    else if (st === 2) { P.playing = false; send('pause'); }
    else if (st === 0) { P.playing = false; send('pause'); }
    else if (st === 5 || st === -1) embedMeta();
    renderNow();
  }

  function embedMeta() {
    let vd = null;
    try { vd = embed.player.getVideoData(); } catch (e) { return; }
    if (!vd || !vd.video_id || vd.video_id === embed.lastId || !vd.title) return;
    embed.lastId = vd.video_id;
    setCurrent({ kind: 'yt', id: vd.video_id, title: vd.title, author: vd.author || '', duration: 0 });
    renderList();
  }

  function embedPlayVideo(id, autoplay, at) {
    useEngine('embed');
    embedEnsure(() => {
      embed.lastId = '';
      const opts = { list: 'RD' + id, listType: 'playlist', index: 0, startSeconds: at || 0 };
      try {
        if (autoplay) embed.player.loadPlaylist(opts); else embed.player.cuePlaylist(opts);
      } catch (e) {
        log('mix load failed, single video: ' + e.message);
        if (autoplay) embed.player.loadVideoById({ videoId: id, startSeconds: at || 0 });
        else embed.player.cueVideoById({ videoId: id, startSeconds: at || 0 });
      }
      applyVol();
      if (autoplay) setTimeout(() => { if (!P.playing && !P.activated) needClick(); }, 3000);
    });
  }

  function embedPlayList(listId, autoplay) {
    useEngine('embed');
    embedEnsure(() => {
      embed.lastId = '';
      const opts = { list: listId, listType: 'playlist', index: 0 };
      if (autoplay) embed.player.loadPlaylist(opts); else embed.player.cuePlaylist(opts);
      applyVol();
    });
  }

  // ---------- current track ----------
  function setCurrent(c) {
    P.cur = c;
    if (c.kind === 'yt') send('meta', { id: c.id, title: c.title || 'Unknown', author: c.author || '' });
    else send('meta', { id: '', title: c.title || 'Unknown', author: c.author || '', art: '' });
    renderNow();
    if (c.kind === 'folder') folderArt(c);
  }

  // ---------- YouTube via helper ----------
  function playQueueAt(i, autoplay, at) {
    if (i < 0 || i >= Q.items.length) return;
    Q.idx = i;
    const it = Q.items[i];
    setCurrent({ kind: 'yt', id: it.id, title: it.title, author: it.channel, duration: it.duration });
    startAudio(HELPER + '/yt/audio?id=' + it.id, autoplay, at);
    afterTrackChange();
  }

  function afterTrackChange() {
    renderList();
    const nx = Q.items[Q.idx + 1];
    if (nx) hget('/yt/prefetch?id=' + nx.id, 5000).catch(() => {});
    if (Q.items.length - Q.idx <= 3) extendWithMix();
  }

  async function extendWithMix() {
    const seed = P.cur && P.cur.kind === 'yt' ? P.cur.id : '';
    if (!seed || Q.mixFor === seed || !helper.on) return;
    Q.mixFor = seed;
    try {
      const j = await hget('/yt/list?mix=' + seed, 30000);
      if (!j.ok) return;
      const have = new Set(Q.items.map((x) => x.id));
      const add = j.items.filter((x) => !have.has(x.id) && (!x.duration || x.duration < 900));
      Q.items = Q.items.concat(add.slice(0, 40));
      if (Q.items.length > 300) { const drop = Q.items.length - 300; const keep = Math.min(drop, Math.max(0, Q.idx - 20)); Q.items.splice(0, keep); Q.idx -= keep; }
      renderList();
      const nx = Q.items[Q.idx + 1];
      if (nx) hget('/yt/prefetch?id=' + nx.id, 5000).catch(() => {});
    } catch (e) { log('mix failed: ' + e.message); }
  }

  function playYouTube(item, autoplay, at) {
    if (helper.on) {
      Q.items = [item];
      Q.idx = -1;
      Q.mixFor = '';
      playQueueAt(0, autoplay, at);
    } else {
      setCurrent({ kind: 'yt', id: item.id, title: item.title || 'Loading...', author: item.channel || '', duration: item.duration || 0 });
      embedPlayVideo(item.id, autoplay, at);
    }
  }

  function addToQueue(item) {
    if (!helper.on) { playYouTube(item, true); return; }
    if (Q.idx < 0) { Q.items = [item]; playQueueAt(0, true); return; }
    Q.items.splice(Q.idx + 1, 0, item);
    setNotice('Added to Up next.');
    afterTrackChange();
  }

  // ---------- folder ----------
  async function loadFolder(autostart) {
    F.loaded = false;
    if (!helper.on) {
      F.files = []; F.missing = false;
      send('folder', { helper: false, count: 0 });
      renderList();
      return;
    }
    try {
      const j = await hget('/folder/list?path=' + encodeURIComponent(S.folderPath || ''), 15000);
      if (!j.ok) {
        F.files = []; F.missing = true; F.path = j.path || S.folderPath;
        send('folder', { missing: true, path: F.path });
      } else {
        F.files = j.files; F.missing = false; F.path = j.path;
        send('folder', { count: j.files.length, path: j.path });
      }
    } catch (e) {
      F.files = []; F.missing = true;
      send('folder', { missing: true, error: e.message });
    }
    F.loaded = true;
    renderList();
    if (autostart && S.source === 'folder' && F.files.length && !(P.cur && P.cur.kind === 'folder')) {
      const last = S.rememberSong ? load('rl_last', null) : null;
      const li = last && last.kind === 'folder' ? F.files.findIndex((f) => f.rel === last.rel) : -1;
      if (li >= 0) { playFolderAt(li, false, last.t); send('resumed', { t: Math.round(last.t || 0) }); }
      else playFolderAt(S.shuffle ? Math.floor(Math.random() * F.files.length) : 0, true);
    }
  }

  function folderSrc(rel, what) {
    return HELPER + '/folder/' + what + '?path=' + encodeURIComponent(F.path || S.folderPath || '') + '&f=' + encodeURIComponent(rel);
  }

  function playFolderAt(i, autoplay, at) {
    if (!F.files.length) return;
    i = ((i % F.files.length) + F.files.length) % F.files.length;
    if (F.idx >= 0 && F.idx !== i) { F.recent.push(F.idx); if (F.recent.length > 100) F.recent.shift(); }
    F.idx = i;
    const f = F.files[i];
    const nm = splitName(f.name);
    setCurrent({ kind: 'folder', rel: f.rel, title: nm.title, author: nm.author, duration: 0 });
    startAudio(folderSrc(f.rel, 'file'), autoplay, at);
    renderList();
  }

  function folderNext() {
    if (!F.files.length) return;
    if (!S.shuffle || F.files.length < 2) { playFolderAt(F.idx + 1, true); return; }
    const avoid = new Set(F.recent.slice(-Math.min(F.recent.length, Math.floor(F.files.length / 2))));
    avoid.add(F.idx);
    let j = F.idx;
    for (let k = 0; k < 20; k++) { j = Math.floor(Math.random() * F.files.length); if (!avoid.has(j)) break; }
    playFolderAt(j, true);
  }

  function folderPrev() {
    if (curTime() > 3) { seek(0); return; }
    if (S.shuffle && F.recent.length) { const j = F.recent.pop(); F.idx = -1; playFolderAt(j, true); return; }
    playFolderAt(F.idx - 1, true);
  }

  // Album art: embedded cover first, then a YouTube thumbnail found by name.
  const artCache = load('rl_art', {});
  async function folderArt(c) {
    const want = c.rel;
    try {
      const r = await fetch(folderSrc(c.rel, 'cover'), { cache: 'no-store' });
      if (r.ok) {
        const url = await squareJpeg(await r.blob());
        if (url && P.cur && P.cur.rel === want) { send('art', { u: url, square: true }); setArt(url); }
        return;
      }
    } catch (e) { log('cover read failed: ' + e.message); }
    if (!S.onlineArt || !helper.on) return;
    const key = c.author + ' - ' + c.title;
    let id = artCache[key];
    if (!id) {
      try {
        const j = await hget('/yt/search?q=' + encodeURIComponent(key.replace(/\(.*?\)|\[.*?\]/g, ' ').trim()), 20000);
        id = j.ok && j.items.length ? j.items[0].id : '';
      } catch (e) { log('art lookup failed: ' + e.message); id = ''; }
      if (id) {
        artCache[key] = id;
        const keys = Object.keys(artCache);
        if (keys.length > 400) delete artCache[keys[0]];
        save('rl_art', artCache);
      }
    }
    if (id && P.cur && P.cur.rel === want) { send('art', { u: thumb(id), square: false }); setArt(thumb(id)); }
  }

  function squareJpeg(blob) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const im = new Image();
      im.onload = () => {
        try {
          const cv = document.createElement('canvas');
          cv.width = 96; cv.height = 96;
          const sz = Math.min(im.width, im.height);
          cv.getContext('2d').drawImage(im, (im.width - sz) / 2, (im.height - sz) / 2, sz, sz, 0, 0, 96, 96);
          resolve(cv.toDataURL('image/jpeg', 0.82));
        } catch (e) { log('cover draw failed: ' + e.name); resolve(''); }
        URL.revokeObjectURL(url);
      };
      im.onerror = () => { URL.revokeObjectURL(url); resolve(''); };
      im.src = url;
    });
  }

  // ---------- transport ----------
  function next() {
    if (S.source === 'folder') { folderNext(); return; }
    if (P.engine === 'embed') { try { embed.player.nextVideo(); } catch (e) { log('embed next: ' + e.message); } return; }
    if (Q.idx + 1 < Q.items.length) playQueueAt(Q.idx + 1, true);
    else { extendWithMix().then(() => { if (Q.idx + 1 < Q.items.length) playQueueAt(Q.idx + 1, true); }); }
  }
  function prev() {
    if (S.source === 'folder') { folderPrev(); return; }
    if (curTime() > 3) { seek(0); return; }
    if (P.engine === 'embed') { try { embed.player.previousVideo(); } catch (e) { log('embed prev: ' + e.message); } return; }
    if (Q.idx > 0) playQueueAt(Q.idx - 1, true); else seek(0);
  }
  function play() {
    if (P.engine === 'none') {
      if (S.source === 'folder' && F.files.length) { playFolderAt(F.idx >= 0 ? F.idx : 0, true); return; }
      const last = load('rl_last', null);
      if (S.source === 'youtube' && last && last.kind === 'yt') { playYouTube({ id: last.id, title: last.title, channel: last.author, duration: last.duration }, true, last.t); return; }
      setNotice('Pick a song in the Music tab first.');
      return;
    }
    tryPlay();
  }

  function needClick() {
    P.pendingPlay = true;
    setNotice('Click anywhere here to start the music.', true);
    send('needclick');
  }

  document.addEventListener('pointerdown', () => {
    const first = !P.activated;
    P.activated = true;
    if (P.pendingPlay) { P.pendingPlay = false; setNotice(''); tryPlay(); }
    if (first) vizSetup();
  }, true);

  // ---------- source switching ----------
  function switchSource(src) {
    S.source = src === 'folder' ? 'folder' : 'youtube';
    useEngine('none');
    P.cur = null;
    P.adMuted = false;
    send('meta', { id: '', title: '', author: '' });
    listTab = S.source === 'folder' ? 'folder' : (results.length ? 'results' : 'queue');
    renderNow();
    renderTabs();
    if (S.source === 'folder') loadFolder(true);
    else { renderList(); maybeResumeYouTube(); }
    renderStatus();
  }

  function maybeResumeYouTube() {
    if (!S.rememberSong) return;
    const last = load('rl_last', null);
    if (!last || last.kind !== 'yt' || !YT_ID.test(last.id)) return;
    playYouTube({ id: last.id, title: last.title, channel: last.author, duration: last.duration }, false, last.t);
    send('resumed', { t: Math.round(last.t || 0) });
  }

  function onHelperChange() {
    if (S.source === 'folder') { if (!F.loaded || helper.on) loadFolder(!P.cur); }
    renderList();
  }

  // ---------- search and links ----------
  function parseLink(text) {
    let u;
    try { u = new URL(/^https?:\/\//i.test(text) ? text : 'https://' + text); } catch (e) { return null; }
    const host = u.hostname.replace(/^(www|m|music)\./, '');
    let id = '';
    if (host === 'youtu.be') id = u.pathname.slice(1, 12);
    else if (host === 'youtube.com') id = u.searchParams.get('v') || (u.pathname.match(/^\/(shorts|live|embed)\/([A-Za-z0-9_-]{11})/) || [])[2] || '';
    else return null;
    const list = u.searchParams.get('list') || '';
    return { id: YT_ID.test(id) ? id : '', list: /^[A-Za-z0-9_-]{10,64}$/.test(list) ? list : '', url: u.href };
  }

  el('searchForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = el('searchInput').value.trim();
    if (!text) return;
    if (S.source === 'folder') { switchSource('youtube'); send('source', { src: 'youtube' }); }
    if (isUrl(text)) { openLink(text); return; }
    if (!helper.on) { setNotice('Search needs Radiolock Helper. Paste a YouTube link instead.', true); return; }
    setNotice('Searching...');
    try {
      const j = await hget('/yt/search?q=' + encodeURIComponent(text), 30000);
      results = j.ok ? j.items : [];
      setNotice(results.length ? '' : 'No results.');
    } catch (err) { setNotice("Search failed. Is the helper still running?"); log('search failed: ' + err.message); }
    listTab = 'results';
    renderTabs();
    renderList();
  });

  async function openLink(text) {
    const l = parseLink(text);
    if (!l || (!l.id && !l.list)) { setNotice("That doesn't look like a YouTube link."); return; }
    el('searchInput').value = '';
    if (l.list && helper.on) {
      setNotice('Loading playlist...');
      try {
        const j = await hget('/yt/list?url=' + encodeURIComponent(l.url), 60000);
        if (!j.ok || !j.items.length) { setNotice("Couldn't open that playlist."); return; }
        Q.items = j.items; Q.mixFor = '';
        const start = l.id ? Math.max(0, j.items.findIndex((x) => x.id === l.id)) : 0;
        setNotice('Playlist: ' + j.items.length + ' songs.');
        listTab = 'queue';
        renderTabs();
        playQueueAt(start, true);
      } catch (e) { setNotice("Couldn't open that playlist."); log('playlist failed: ' + e.message); }
      return;
    }
    if (l.list && !helper.on) { setCurrent({ kind: 'yt', id: l.id || '', title: 'Loading playlist...', author: '' }); embedPlayList(l.list, true); return; }
    playYouTube({ id: l.id, title: 'Loading...', channel: '', duration: 0 }, true);
  }

  // ---------- rendering ----------
  let noticeTimer = null;
  function setNotice(text, call) {
    const n = el('notice');
    n.textContent = text || '';
    n.classList.toggle('call', !!call);
    if (noticeTimer) clearTimeout(noticeTimer);
    if (text && !call) noticeTimer = setTimeout(() => { n.textContent = ''; }, 6000);
  }

  function renderStatus() {
    const chip = el('sourceChip');
    let text, cls;
    if (S.source === 'folder') { text = helper.on ? 'Music folder' : 'Music folder (helper needed)'; cls = helper.on ? 'good' : 'warn'; }
    else if (helper.on) { text = 'YouTube - ad-free'; cls = 'good'; }
    else { text = 'YouTube - ads muted'; cls = 'warn'; }
    if (!helper.checked) { text = 'Starting...'; cls = ''; }
    chip.textContent = text;
    chip.className = 'chip ' + cls;
    el('searchInput').placeholder = helper.on ? 'Search YouTube or paste a link' : 'Paste a YouTube link or playlist';
    el('searchBtn').textContent = helper.on ? 'Search' : 'Play';
  }

  function setArt(url) { el('artImg').style.backgroundImage = url ? 'url("' + url + '")' : 'none'; }

  function renderNow() {
    const c = P.cur;
    el('nowTitle').textContent = c ? c.title || 'Unknown' : 'Nothing playing';
    el('nowArtist').textContent = c ? c.author || '' : '';
    if (!c) setArt('');
    else if (c.kind === 'yt' && c.id) setArt(thumb(c.id));
    else if (c.kind === 'folder') setArt('');
    el('btnPlay').innerHTML = P.playing ? '&#10074;&#10074;' : '&#9654;';
  }

  function renderTabs() {
    const folder = S.source === 'folder';
    document.querySelectorAll('.tab').forEach((t) => {
      const name = t.dataset.list;
      t.hidden = folder ? name !== 'folder' : name === 'folder';
      t.classList.toggle('on', name === listTab);
    });
  }

  function itemRow(o) {
    const li = document.createElement('li');
    li.className = 'item' + (o.cur ? ' cur' : '');
    const th = document.createElement('div');
    th.className = 'thumb' + (o.thumb ? '' : ' note');
    if (o.thumb) th.style.backgroundImage = 'url("' + o.thumb + '")'; else th.textContent = '♪';
    const meta = document.createElement('div');
    meta.className = 'meta';
    const t = document.createElement('div'); t.className = 't'; t.textContent = o.title;
    const s = document.createElement('div'); s.className = 's'; s.textContent = o.sub || '';
    meta.append(t, s);
    li.append(th, meta);
    if (o.dur) { const d = document.createElement('div'); d.className = 'dur'; d.textContent = fmt(o.dur); li.append(d); }
    if (o.add) {
      const b = document.createElement('button'); b.textContent = '+ Queue';
      b.addEventListener('click', (e) => { e.stopPropagation(); o.add(); });
      li.append(b);
    }
    li.addEventListener('click', o.play);
    return li;
  }

  function renderList() {
    const ul = el('list');
    const empty = el('empty');
    ul.textContent = '';
    empty.textContent = '';
    const frag = document.createDocumentFragment();
    if (listTab === 'folder') {
      if (!helper.on) empty.innerHTML = 'Your music folder needs <b>Radiolock Helper</b> running on this PC.';
      else if (F.missing) empty.textContent = "Music folder not found. Set the folder path in the Playback tab.";
      else if (!F.loaded) empty.textContent = 'Loading your music folder...';
      else if (!F.files.length) empty.textContent = 'No songs in ' + (F.path || 'the folder') + '.';
      F.files.forEach((f, i) => {
        const nm = splitName(f.name);
        frag.append(itemRow({ title: nm.title, sub: nm.author, cur: i === F.idx, play: () => playFolderAt(i, true) }));
      });
    } else if (listTab === 'results') {
      if (!results.length) empty.innerHTML = helper.on ? 'Search for a song, or paste a YouTube link.<br>Click a song to play it.' :
        'Paste a YouTube link or playlist above.<br>Run <b>Radiolock Helper</b> for search and ad-free audio.';
      results.forEach((r) => {
        frag.append(itemRow({ title: r.title, sub: r.channel, thumb: thumb(r.id), dur: r.duration, cur: P.cur && P.cur.id === r.id,
          play: () => playYouTube(r, true), add: helper.on ? () => addToQueue(r) : null }));
      });
    } else {
      if (P.engine === 'embed') {
        empty.textContent = 'Up next is handled by YouTube without the helper.';
      } else {
        if (Q.idx < 0) empty.textContent = 'Nothing queued yet. Songs you play start a radio of similar music.';
        Q.items.slice(Math.max(0, Q.idx), Q.idx + 60).forEach((q, k) => {
          const i = Math.max(0, Q.idx) + k;
          frag.append(itemRow({ title: q.title, sub: q.channel, thumb: thumb(q.id), dur: q.duration, cur: i === Q.idx, play: () => playQueueAt(i, true) }));
        });
      }
    }
    ul.append(frag);
  }

  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => { listTab = t.dataset.list; renderTabs(); renderList(); }));
  el('btnPlay').addEventListener('click', () => { if (P.playing) pause(); else play(); });
  el('btnNext').addEventListener('click', () => next());
  el('btnPrev').addEventListener('click', () => prev());
  el('artBox').parentElement.querySelector('.bar').addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const d = curDur();
    if (d > 0) seek(Math.max(0, Math.min(d - 3, (e.clientX - r.left) / r.width * d)));
  });

  // ---------- visualizer ----------
  let viz = null, vizTried = false;
  function vizSetup() {
    if (!S.visualizer || viz || vizTried || P.engine !== 'audio' || !P.activated) return;
    vizTried = true;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC();
      ctx.resume().then(() => {
        if (ctx.state !== 'running') { vizTried = false; ctx.close(); return; }
        const src = ctx.createMediaElementSource(audio);
        const an = ctx.createAnalyser();
        an.fftSize = 512; an.smoothingTimeConstant = 0.5; an.minDecibels = -100; an.maxDecibels = -20;
        src.connect(an); an.connect(ctx.destination);
        viz = { ctx: ctx, an: an, buf: new Uint8Array(an.frequencyBinCount), peak: [0, 0, 0, 0, 0] };
        send('viz', { ok: true });
      }).catch((e) => { vizTried = false; log('visualizer: ' + e.name); });
    } catch (e) { log('visualizer: ' + e.name); }
  }
  const BANDS = [[1, 2], [3, 5], [6, 12], [13, 30], [31, 80]];
  setInterval(() => {
    if (!viz || !S.visualizer || P.engine !== 'audio' || audio.paused) return;
    if (viz.ctx.state !== 'running') { viz.ctx.resume().catch(() => {}); return; }
    viz.an.getByteFrequencyData(viz.buf);
    let out = '';
    for (let i = 0; i < BANDS.length; i++) {
      let s = 0, c = 0;
      for (let j = BANDS[i][0]; j <= BANDS[i][1]; j++) { s += viz.buf[j]; c++; }
      const avg = s / c;
      viz.peak[i] = Math.max(avg, viz.peak[i] * 0.992);
      out += viz.peak[i] < 8 ? 0 : Math.min(9, Math.floor(avg / viz.peak[i] * 9.4));
    }
    send('v', { b: out });
  }, 70);

  // ---------- reporting ----------
  let beat = 0;
  setInterval(() => {
    beat++;
    const t = curTime(), d = curDur();
    el('barFill').style.width = d > 0 ? Math.min(100, t / d * 100) + '%' : '0%';
    el('timeCur').textContent = fmt(t);
    el('timeDur').textContent = fmt(d);
    if (P.playing) send('tick', { cur: t, dur: d, id: P.cur && P.cur.kind === 'yt' ? P.cur.id : '' });
    else if (beat % 3 === 0) send('st', { playing: false });
    if (beat % 4 === 0) send('hb', {});
    if (P.playing && S.rememberSong && beat % 10 === 0 && P.cur) {
      save('rl_last', { kind: P.cur.kind, id: P.cur.id || '', rel: P.cur.rel || '', title: P.cur.title, author: P.cur.author, duration: d, t: Math.floor(t) });
    }
  }, 500);

  // ---------- game to page ----------
  let lastSeq = 0;
  function onHash() {
    const m = /^#s=(\d+)&c=(.*)$/.exec(location.hash);
    if (!m) return;
    const seq = Number(m[1]);
    send('ack', { s: seq }, true);
    if (seq <= lastSeq) return;
    lastSeq = seq;
    let cmds;
    try { cmds = JSON.parse(decodeURIComponent(m[2])); } catch (e) { log('bad command batch ' + seq); return; }
    if (!Array.isArray(cmds)) return;
    cmds.forEach((c) => {
      try { run(c[0], c[1]); } catch (e) { log('command ' + c[0] + ' failed: ' + e.message); }
    });
  }

  function run(cmd, a) {
    switch (cmd) {
      case 'settings': applySettings(a || {}); break;
      case 'vol': setVol(a); break;
      case 'fade': fadeTo(a[0], a[1]); break;
      case 'play': play(); break;
      case 'pause': pause(); break;
      case 'next': next(); break;
      case 'prev': prev(); break;
      case 'seek': seek(a); break;
      case 'playId': if (YT_ID.test(String(a[0]))) { if (S.source !== 'youtube') switchSource('youtube'); playYouTube({ id: a[0], title: 'Loading...', channel: '', duration: 0 }, true, a[1] || 0); } break;
      case 'source': switchSource(a); break;
      case 'rescan': if (S.source === 'folder') loadFolder(!P.cur); break;
      case 'zoom': document.documentElement.style.zoom = String(Number(a) || 1); break;
      case 'repaint':
        document.documentElement.classList.toggle('dlmrp');
        window.dispatchEvent(new Event('resize'));
        break;
      default: log('unknown command ' + cmd);
    }
  }

  function applySettings(o) {
    const before = { source: S.source, folderPath: S.folderPath, visualizer: S.visualizer, skipAds: S.skipAds };
    Object.keys(o).forEach((k) => { S[k] = o[k]; });
    save('rl_settings', S);
    if (S.source !== before.source) switchSource(S.source);
    else if (S.source === 'folder' && S.folderPath !== before.folderPath) loadFolder(true);
    if (!S.skipAds && P.adMuted) { P.adMuted = false; applyVol(); }
    if (S.visualizer && !before.visualizer) vizSetup();
    renderStatus();
  }

  window.addEventListener('hashchange', onHash);

  // ---------- boot ----------
  renderTabs();
  renderNow();
  renderList();
  renderStatus();
  send('hello', { version: VERSION, saved: load('rl_settings', null) });
  listTab = S.source === 'folder' ? 'folder' : 'results';
  renderTabs();
  checkHelper().then(() => {
    if (S.source === 'folder') loadFolder(true);
    else maybeResumeYouTube();
    renderList();
  });
})();
