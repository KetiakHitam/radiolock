// Radiolock player page. Runs inside Deadlock's HTML panel.
// Game to page: URL fragment "#s=<seq>&c=<json command list>". Page to game: document.title JSON.
(function () {
  'use strict';

  const VERSION = '1.6.0';
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
  const pageLogQ = [];
  function log(msg) {
    msg = String(msg).slice(0, 300);
    send('log', { msg: msg });
    pageLogQ.push(new Date().toTimeString().slice(0, 8) + ' page: ' + msg);
    if (pageLogQ.length > 100) pageLogQ.shift();
  }
  window.addEventListener('error', (e) => log('error: ' + e.message + ' at ' + (e.filename || '').split('/').pop() + ':' + e.lineno));
  window.addEventListener('unhandledrejection', (e) => log('unhandled: ' + (e.reason && e.reason.message ? e.reason.message : e.reason)));
  setInterval(() => { if (pageLogQ.length && helper.on) writeGameLog(pageLogQ.splice(0)); }, 5000);

  // ---------- storage ----------
  function load(key, fallback) {
    try { const v = JSON.parse(localStorage.getItem(key) || 'null'); return v === null ? fallback : v; } catch (e) { return fallback; }
  }
  function save(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { log('storage write failed: ' + e.name); }
  }

  const S = Object.assign({
    source: 'youtube', folderPath: '', skipAds: true, visualizer: true, shuffle: true,
    rememberSong: false, onlineArt: true, levelLoud2: false, browserZoom: 0, repeat: 'off'
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
      if (helper.on) { connectEvents(); loadLib(); sendHotkeys(); loadPlaylists(); } else { disconnectEvents(); send('hotkeys', { helper: false }); }
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
  // fixed: a playlist or other chosen list, no radio after it. pid: the saved playlist being played.
  const Q = { items: [], idx: -1, mixFor: '', fixed: false, pid: '', shuffled: false };
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
    // With the audio graph, the element stays at full volume so loudness can be measured; the gain node sets volume.
    if (graph) { audio.volume = 1; graph.vol.gain.setTargetAtTime(v / 100, graph.ctx.currentTime, 0.02); }
    else audio.volume = v / 100;
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
  audio.addEventListener('playing', () => { P.playing = true; P.errors = 0; send('play'); renderNow(); graphSetup(); noteRecent(); });
  audio.addEventListener('pause', () => { if (P.engine !== 'audio') return; P.playing = false; send('pause'); renderNow(); });
  audio.addEventListener('ended', () => {
    if (P.engine !== 'audio') return;
    if (S.repeat === 'one') { seek(0); tryPlay(); return; }
    next();
  });
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
      // AbortError only means a newer song replaced this one before it started.
      if (pr && pr.catch) pr.catch((e) => { if (e.name === 'NotAllowedError') needClick(); else if (e.name !== 'AbortError') log('play failed: ' + e.name); });
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
    if (st === 1) { P.playing = true; P.errors = 0; send('play'); embedMeta(); noteRecent(); }
    else if (st === 2) { P.playing = false; send('pause'); }
    else if (st === 0) {
      if (S.repeat === 'one') { embed.player.seekTo(0, true); embed.player.playVideo(); return; }
      P.playing = false; send('pause');
    }
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
    P.recentNoted = false;
    if (c.kind === 'yt') send('meta', { id: c.id, title: c.title || 'Unknown', author: c.author || '' });
    else send('meta', { id: '', title: c.title || 'Unknown', author: c.author || '', art: '' });
    renderNow();
    if (c.kind === 'folder') folderArt(c);
    meterReset();
    sendFavState();
  }

  // ---------- queue (helper mode, YouTube and folder songs mixed) ----------
  // Queue items: { kind: 'yt', id, title, channel, duration } or { kind: 'folder', rel, folder, title, channel }.
  function kindOf(it) { return it.kind === 'folder' ? 'folder' : 'yt'; }
  function itemKey(it) {
    return kindOf(it) === 'yt' ? 'y:' + it.id : 'f:' + String(it.folder || '').toLowerCase() + '|' + String(it.rel || '').toLowerCase();
  }

  function playQueueAt(i, autoplay, at) {
    if (i < 0 || i >= Q.items.length) return;
    Q.idx = i;
    P.queueMode = true;
    const it = Q.items[i];
    if (kindOf(it) === 'folder') {
      setCurrent({ kind: 'folder', rel: it.rel, folder: it.folder, title: it.title, author: it.channel || '', duration: 0 });
      startAudio(folderSrc(it.rel, 'file', it.folder), autoplay, at);
    } else {
      setCurrent({ kind: 'yt', id: it.id, title: it.title, author: it.channel, duration: it.duration });
      startAudio(HELPER + '/yt/audio?id=' + it.id, autoplay, at);
    }
    afterTrackChange();
  }

  function afterTrackChange() {
    renderList();
    const nx = Q.items[Q.idx + 1];
    if (nx && kindOf(nx) === 'yt') hget('/yt/prefetch?id=' + nx.id, 5000).catch(() => {});
    if (Q.items.length - Q.idx <= 3) extendWithMix();
  }

  // Current song as a queue item, so a queue can start from whatever is playing.
  function currentAsItem() {
    const c = P.cur;
    if (!c) return null;
    if (c.kind === 'folder') return { kind: 'folder', rel: c.rel, folder: c.folder || F.path || S.folderPath || '', title: c.title, channel: c.author || '' };
    return c.id ? { kind: 'yt', id: c.id, title: c.title, channel: c.author || '', duration: c.duration || 0 } : null;
  }

  function ensureQueueMode() {
    if (P.queueMode) return true;
    const cur = currentAsItem();
    if (!cur || P.engine !== 'audio') return false;
    Q.items = [cur];
    Q.idx = 0;
    Q.mixFor = '';
    P.queueMode = true;
    return true;
  }

  // where: 'next' puts it right after the current song, 'end' at the end of the queue.
  function queueInsert(item, where) {
    if (!helper.on) {
      if (kindOf(item) === 'yt') playYouTube(item, true); else setNotice('Folder songs need Radiolock running.');
      return;
    }
    if (!ensureQueueMode()) { Q.items = [item]; Q.mixFor = ''; playQueueAt(0, true); return; }
    const key = itemKey(item);
    const existing = Q.items.findIndex((x, i) => i > Q.idx && itemKey(x) === key);
    if (existing >= 0) Q.items.splice(existing, 1);
    if (where === 'next') Q.items.splice(Q.idx + 1, 0, item); else Q.items.push(item);
    setNotice(where === 'next' ? 'Plays next.' : 'Added to the end of Up next.');
    afterTrackChange();
  }

  function queueMove(from, to) {
    if (from <= Q.idx || to <= Q.idx || from >= Q.items.length) return;
    const [it] = Q.items.splice(from, 1);
    Q.items.splice(Math.min(to, Q.items.length), 0, it);
    afterTrackChange();
  }

  function queueRemove(i) {
    if (i <= Q.idx || i >= Q.items.length) return;
    Q.items.splice(i, 1);
    afterTrackChange();
  }

  function shuffled(items) {
    const list = items.slice();
    for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = list[i]; list[i] = list[j]; list[j] = t; }
    return list;
  }

  function playList(items, start, shuffle, pid) {
    if (!items.length) return;
    let list = items.slice();
    if (shuffle) { list = shuffled(list); start = 0; }
    Q.fixed = true;
    Q.pid = pid || '';
    Q.shuffled = !!shuffle;
    if (!helper.on) {
      const yt = list.filter((x) => kindOf(x) === 'yt');
      if (!yt.length) { setNotice('Folder songs need Radiolock running.'); return; }
      playYouTube(yt[Math.min(start, yt.length - 1)], true);
      return;
    }
    Q.items = list;
    Q.mixFor = '';
    listTab = 'queue';
    renderTabs();
    playQueueAt(Math.max(0, Math.min(start, list.length - 1)), true);
  }

  async function extendWithMix() {
    const seed = P.cur && P.cur.kind === 'yt' ? P.cur.id : '';
    if (!seed || Q.fixed || Q.mixFor === seed || !helper.on) return;
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
      Q.fixed = false;
      Q.pid = '';
      playQueueAt(0, autoplay, at);
    } else {
      setCurrent({ kind: 'yt', id: item.id, title: item.title || 'Loading...', author: item.channel || '', duration: item.duration || 0 });
      embedPlayVideo(item.id, autoplay, at);
    }
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

  function folderSrc(rel, what, folder) {
    return HELPER + '/folder/' + what + '?path=' + encodeURIComponent(folder || F.path || S.folderPath || '') + '&f=' + encodeURIComponent(rel);
  }

  function folderItem(f) {
    const nm = splitName(f.name);
    return { kind: 'folder', rel: f.rel, folder: F.path || S.folderPath || '', title: nm.title, channel: nm.author };
  }

  function playFolderAt(i, autoplay, at) {
    if (!F.files.length) return;
    i = ((i % F.files.length) + F.files.length) % F.files.length;
    if (F.idx >= 0 && F.idx !== i) { F.recent.push(F.idx); if (F.recent.length > 100) F.recent.shift(); }
    F.idx = i;
    P.queueMode = false;
    const f = F.files[i];
    const nm = splitName(f.name);
    setCurrent({ kind: 'folder', rel: f.rel, folder: F.path || S.folderPath || '', title: nm.title, author: nm.author, duration: 0 });
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
      const r = await fetch(folderSrc(c.rel, 'cover', c.folder), { cache: 'no-store' });
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
    if (P.engine === 'embed') { try { embed.player.nextVideo(); } catch (e) { log('embed next: ' + e.message); } return; }
    if (!P.queueMode && S.source === 'folder') { folderNext(); return; }
    if (Q.idx + 1 < Q.items.length) { playQueueAt(Q.idx + 1, true); return; }
    // End of a playlist or chosen list: loop it with Repeat, otherwise stop. No radio.
    if (Q.fixed) {
      if (S.repeat === 'all' && Q.items.length) {
        if (Q.shuffled) Q.items = shuffled(Q.items);
        playQueueAt(0, true);
      } else {
        pause();
        setNotice('End of the list. Turn on Repeat to loop it.');
      }
      return;
    }
    // End of the queue: keep a radio going for YouTube songs, otherwise fall back to the folder.
    if (P.cur && P.cur.kind === 'yt') { extendWithMix().then(() => { if (Q.idx + 1 < Q.items.length) playQueueAt(Q.idx + 1, true); }); return; }
    if (S.source === 'folder' && F.files.length) { P.queueMode = false; folderNext(); }
  }
  function prev() {
    if (curTime() > 3) { seek(0); return; }
    if (P.engine === 'embed') { try { embed.player.previousVideo(); } catch (e) { log('embed prev: ' + e.message); } return; }
    if (!P.queueMode && S.source === 'folder') { folderPrev(); return; }
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
    if (first) graphSetup();
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

  let lastQuery = '', searchToken = 0, typeTimer = null;

  async function doSearch(auto) {
    if (typeTimer) { clearTimeout(typeTimer); typeTimer = null; }
    const text = el('searchInput').value.trim();
    if (!text) return;
    if (isUrl(text)) {
      if (auto) return;
      if (S.source === 'folder') { switchSource('youtube'); send('source', { src: 'youtube' }); }
      openLink(text);
      return;
    }
    if (text === lastQuery) return;
    if (!helper.on) { if (!auto) setNotice('Search needs Radiolock Helper. Paste a YouTube link instead.', true); return; }
    lastQuery = text;
    const token = ++searchToken;
    setNotice('Searching...');
    try {
      const j = await hget('/yt/search?q=' + encodeURIComponent(text), 30000);
      if (token !== searchToken) return;
      results = j.ok ? j.items : [];
      setNotice(results.length ? '' : 'No results.');
    } catch (err) {
      if (token !== searchToken) return;
      lastQuery = '';
      setNotice('Search failed. Is the helper still running?');
      log('search failed: ' + err.message);
    }
    listTab = 'results';
    renderTabs();
    renderList();
  }

  el('searchForm').addEventListener('submit', (e) => { e.preventDefault(); lastQuery = ''; doSearch(false); });
  // Enter may arrive as keydown or keyup depending on how the game forwards keys.
  ['keydown', 'keyup'].forEach((type) => el('searchInput').addEventListener(type, (e) => {
    if (e.key !== 'Enter' && e.keyCode !== 13) return;
    e.preventDefault();
    if (type === 'keydown') { lastQuery = ''; doSearch(false); } else doSearch(false);
  }));
  el('searchInput').addEventListener('input', () => {
    if (typeTimer) clearTimeout(typeTimer);
    const text = el('searchInput').value.trim();
    if (text.length >= 3 && !isUrl(text)) typeTimer = setTimeout(() => doSearch(true), 1100);
  });

  async function pickFolder() {
    if (!helper.on) { setNotice('Choosing a folder needs Radiolock running.', true); return; }
    setNotice('A folder window opened. If you do not see it, press Alt+Tab.', true);
    try {
      const j = await hget('/folder/pick?path=' + encodeURIComponent(S.folderPath || F.path || ''), 600000);
      if (j.status === 'busy') { setNotice('The folder window is already open. Press Alt+Tab to find it.', true); return; }
      if (!j.ok) { setNotice(j.status === 'cancelled' ? '' : "Couldn't open the folder window."); return; }
      S.folderPath = j.path;
      save('rl_settings', S);
      send('folderpicked', { path: j.path });
      setNotice('Music folder: ' + j.path);
      if (S.source !== 'folder') { switchSource('folder'); send('source', { src: 'folder' }); return; }
      useEngine('none');
      P.cur = null;
      F.idx = -1;
      F.recent = [];
      loadFolder(true);
    } catch (e) { setNotice("Couldn't open the folder window."); log('folder pick failed: ' + e.message); }
  }
  el('pickBtn').addEventListener('click', () => pickFolder());

  async function openLink(text) {
    const l = parseLink(text);
    if (!l || (!l.id && !l.list)) { setNotice("That doesn't look like a YouTube link."); return; }
    el('searchInput').value = '';
    if (l.list && helper.on) {
      setNotice('Loading playlist...');
      try {
        const j = await hget('/yt/list?url=' + encodeURIComponent(l.url), 180000);
        if (!j.ok || !j.items.length) { setNotice("Couldn't open that playlist. Private playlists can't be read."); return; }
        const items = j.items.map((x) => ({ kind: 'yt', id: x.id, title: x.title, channel: x.channel, duration: x.duration }));
        const pid = await savePlaylist({ src: l.list, name: j.title || 'YouTube playlist', items: items });
        const start = l.id ? Math.max(0, items.findIndex((x) => x.id === l.id)) : 0;
        setNotice('Saved to Playlists: ' + (j.title || 'YouTube playlist') + ' (' + items.length + ' songs).');
        playList(items, start, false, pid);
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
    el('btnFav').classList.toggle('on', isFav(currentAsItem()));
    el('btnFav').hidden = !helper.on || !c;
  }

  function renderTabs() {
    const folder = S.source === 'folder';
    el('folderBar').hidden = listTab !== 'folder';
    el('libBar').hidden = listTab !== 'favorites';
    el('plBar').hidden = listTab !== 'playlists';
    renderPlBar();
    el('folderPathLbl').textContent = F.path || S.folderPath || 'No folder chosen';
    document.querySelectorAll('.tab').forEach((t) => {
      const name = t.dataset.list;
      t.hidden = name === 'folder' ? !folder : (name === 'results' ? folder : false);
      t.classList.toggle('on', name === listTab);
    });
  }

  // ---------- library: favorites and recently played ----------
  const LIB = { fav: [], recent: [], favKeys: new Set(), loaded: false };

  function libItemFor(it) {
    if (kindOf(it) === 'folder') return { kind: 'folder', rel: it.rel, folder: it.folder || '', title: it.title, author: it.channel || it.author || '' };
    return { kind: 'yt', id: it.id, title: it.title, author: it.channel || it.author || '', duration: it.duration || 0 };
  }
  function libToItem(x) {
    if (x.kind === 'folder') return { kind: 'folder', rel: x.rel, folder: x.folder, title: x.title, channel: x.author };
    return { kind: 'yt', id: x.id, title: x.title, channel: x.author, duration: x.duration };
  }

  async function hpost(path, obj) {
    const r = await fetch(HELPER + path, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(obj), cache: 'no-store' });
    return r.json();
  }

  async function loadLib() {
    if (!helper.on) return;
    try {
      const j = await hget('/lib', 5000);
      if (!j.ok) return;
      LIB.fav = j.favorites;
      LIB.recent = j.recent;
      LIB.favKeys = new Set(j.favorites.map((x) => x.key));
      LIB.loaded = true;
      if (listTab === 'favorites' || listTab === 'recent') renderList();
      renderNow();
      sendFavState();
    } catch (e) { log('library load failed: ' + e.message); }
  }

  async function toggleFav(it, want) {
    if (!it) return;
    if (!helper.on) { setNotice('Favorites need Radiolock running.'); return; }
    try {
      const j = await hpost('/lib/fav', { item: libItemFor(it), on: want === undefined ? null : want });
      if (!j.ok) { setNotice("Couldn't change favorites."); return; }
      setNotice(j.on ? 'Added to favorites.' : 'Removed from favorites.');
      await loadLib();
    } catch (e) { log('favorite failed: ' + e.message); }
  }

  function isFav(it) { return !!(it && LIB.favKeys.has(itemKey(it))); }
  function sendFavState() { send('fav', { on: isFav(currentAsItem()) }); }

  function noteRecent() {
    if (P.recentNoted || !helper.on) return;
    const it = currentAsItem();
    if (!it) return;
    P.recentNoted = true;
    hpost('/lib/recent', { item: libItemFor(it) }).then(() => loadLib()).catch((e) => log('recent failed: ' + e.message));
  }

  // ---------- hotkeys (bound in the helper, pressed keys arrive as events) ----------
  let events = null;
  function connectEvents() {
    if (events || !helper.on || typeof EventSource !== 'function') return;
    events = new EventSource(HELPER + '/events');
    events.addEventListener('update', (e) => {
      try { const d = JSON.parse(e.data); send('update', { text: String(d.text || '') }); if (d.text) setNotice(d.text, true); }
      catch (err) { log('update event: ' + err.message); }
    });
    events.addEventListener('hotkey', (e) => {
      try { onHotkey(JSON.parse(e.data).action); } catch (err) { log('hotkey event: ' + err.message); }
    });
  }
  function disconnectEvents() { if (events) { events.close(); events = null; } }

  function onHotkey(action) {
    switch (action) {
      case 'playpause': if (P.playing) pause(); else play(); break;
      case 'next': next(); break;
      case 'prev': prev(); break;
      case 'fav': toggleFav(currentAsItem()); break;
      case 'quiet': case 'volup': case 'voldown': send('hotkey', { action: action }); break;
      default: log('unknown hotkey ' + action);
    }
  }

  async function sendHotkeys(status) {
    if (!helper.on) { send('hotkeys', { helper: false }); return; }
    try {
      const j = await hget('/hotkeys', 5000);
      send('hotkeys', { binds: j.binds, status: status || '' });
    } catch (e) { log('hotkeys read failed: ' + e.message); }
  }

  async function setHotkey(action, clear) {
    if (!helper.on) { send('hotkeys', { helper: false }); return; }
    try {
      if (!clear) setNotice('Press the keys in the Radiolock window. If you do not see it, press Alt+Tab.', true);
      const j = await hget('/hotkeys/' + (clear ? 'clear' : 'capture') + '?action=' + encodeURIComponent(action), 180000);
      setNotice('');
      send('hotkeys', { binds: j.binds, status: j.status || '', action: action });
    } catch (e) { log('hotkey change failed: ' + e.message); }
  }

  // ---------- playlists (Radiolock's own copies, stored by the helper) ----------
  const PL = { list: [], open: null, shown: 200, renaming: false };

  async function loadPlaylists() {
    if (!helper.on) return;
    try {
      const j = await hget('/pl', 8000);
      if (j.ok) PL.list = j.playlists;
      if (listTab === 'playlists') renderList();
    } catch (e) { log('playlists load failed: ' + e.message); }
  }

  async function openPlaylist(pid) {
    try {
      const j = await hget('/pl/get?pid=' + encodeURIComponent(pid), 8000);
      if (!j.ok) { setNotice("Couldn't open that playlist."); return; }
      PL.open = j.playlist;
      PL.shown = 200;
      listTab = 'playlists';
      renderTabs();
      renderList();
    } catch (e) { log('playlist open failed: ' + e.message); }
  }

  // Saves a whole playlist. Same YouTube source replaces the old copy. Returns the playlist id.
  async function savePlaylist(p) {
    if (!helper.on) { setNotice('Playlists need Radiolock running.'); return ''; }
    const body = { playlist: { pid: p.pid || '', src: p.src || '', name: p.name, items: p.items.map(libItemFor) } };
    try {
      const j = await hpost('/pl/put', body);
      if (!j.ok) { setNotice(j.error || "Couldn't save the playlist."); return ''; }
      await loadPlaylists();
      if (PL.open && PL.open.pid === j.pid) {
        const g = await hget('/pl/get?pid=' + j.pid, 8000);
        if (g.ok) PL.open = g.playlist;
        if (listTab === 'playlists') { renderPlBar(); renderList(); }
      }
      return j.pid;
    } catch (e) { log('playlist save failed: ' + e.message); setNotice("Couldn't save the playlist."); return ''; }
  }

  async function addToPlaylist(it, pid) {
    try {
      const g = await hget('/pl/get?pid=' + encodeURIComponent(pid), 8000);
      if (!g.ok) return;
      const p = g.playlist;
      const items = p.items.map(libToItem);
      if (items.some((x) => itemKey(x) === itemKey(it))) { setNotice('Already in ' + p.name + '.'); return; }
      if (items.length >= 2000) { setNotice(p.name + ' is full (2000 songs).'); return; }
      items.push(it);
      await savePlaylist({ pid: p.pid, src: p.src, name: p.name, items: items });
      setNotice('Added to ' + p.name + '.');
    } catch (e) { log('add to playlist failed: ' + e.message); }
  }

  async function newPlaylist(items) {
    const name = 'Playlist ' + (PL.list.length + 1);
    const pid = await savePlaylist({ name: name, items: items });
    if (!pid) return;
    setNotice('Created ' + name + '.');
    await openPlaylist(pid);
    startRename();
  }

  function plEntry(it, anchor) {
    return { label: 'Add to playlist...', fn: () => {
      const entries = PL.list.map((p) => ({ label: p.name, fn: () => addToPlaylist(it, p.pid) }));
      entries.push({ label: '+ New playlist', fn: () => newPlaylist([it]) });
      setTimeout(() => openMenu(anchor, entries), 0);
    } };
  }

  async function editOpen(fn) {
    if (!PL.open) return;
    const items = PL.open.items.map(libToItem);
    fn(items);
    await savePlaylist({ pid: PL.open.pid, src: PL.open.src, name: PL.open.name, items: items });
  }

  async function syncPlaylist(p) {
    if (!p.src) return;
    setNotice('Syncing ' + p.name + ' from YouTube...');
    try {
      const j = await hget('/yt/list?url=' + encodeURIComponent('https://www.youtube.com/playlist?list=' + p.src), 180000);
      if (!j.ok || !j.items.length) { setNotice("Couldn't read that playlist from YouTube."); return; }
      const items = j.items.map((x) => ({ kind: 'yt', id: x.id, title: x.title, channel: x.channel, duration: x.duration }));
      await savePlaylist({ pid: p.pid, src: p.src, name: p.name, items: items });
      setNotice(p.name + ' synced: ' + items.length + ' songs.');
    } catch (e) { log('playlist sync failed: ' + e.message); }
  }

  function playlistMenu(p, anchor) {
    const entries = [
      { label: 'Play', fn: () => playList(p.items.map(libToItem), 0, false, p.pid) },
      { label: 'Shuffle', fn: () => playList(p.items.map(libToItem), 0, true, p.pid) },
      { label: 'Rename', fn: () => { if (PL.open && PL.open.pid === p.pid) startRename(); else openPlaylist(p.pid).then(startRename); } }
    ];
    if (p.src) entries.push({ label: 'Sync from YouTube', fn: () => syncPlaylist(p) });
    entries.push({ label: 'Delete playlist', fn: () => setTimeout(() => openMenu(anchor, [
      { label: 'Yes, delete "' + p.name + '"', fn: () => deletePlaylist(p.pid) },
      { label: 'Cancel', fn: () => {} }
    ]), 0) });
    return entries;
  }

  async function deletePlaylist(pid) {
    try {
      await hpost('/pl/delete', { pid: pid });
      if (PL.open && PL.open.pid === pid) PL.open = null;
      if (Q.pid === pid) Q.pid = '';
      await loadPlaylists();
      renderTabs();
      renderList();
      setNotice('Playlist deleted.');
    } catch (e) { log('playlist delete failed: ' + e.message); }
  }

  function startRename() {
    if (!PL.open) return;
    PL.renaming = true;
    renderPlBar();
    const inp = el('plNameInput');
    inp.value = PL.open.name;
    inp.focus();
    inp.select();
  }

  function finishRename(keep) {
    if (!PL.renaming) return;
    PL.renaming = false;
    const name = el('plNameInput').value.trim().slice(0, 80);
    const changed = keep && PL.open && name && name !== PL.open.name;
    if (changed) PL.open.name = name;
    renderPlBar();
    if (changed) editOpen(() => {});
  }

  function renderPlBar() {
    const open = !!PL.open;
    el('plBack').hidden = !open;
    el('plPlay').hidden = !open;
    el('plShuffle').hidden = !open;
    el('plMore').hidden = !open;
    el('plNew').hidden = open;
    el('plNameInput').hidden = !(open && PL.renaming);
    el('plTitle').hidden = open && PL.renaming;
    el('plTitle').textContent = open ? PL.open.name + '  -  ' + PL.open.items.length + ' songs' :
      PL.list.length + (PL.list.length === 1 ? ' playlist' : ' playlists');
  }

  function renderPlaylists(frag, empty, curKey) {
    if (!helper.on) { empty.innerHTML = 'Playlists need <b>Radiolock</b> running on this PC.'; return; }
    if (!PL.open) {
      if (!PL.list.length) empty.innerHTML = 'Paste a YouTube playlist link in the search box and it is saved here.<br>Or use Add to playlist in any song\'s ... menu.';
      PL.list.forEach((p) => {
        frag.append(itemRow({ title: p.name, sub: p.count + (p.count === 1 ? ' song' : ' songs') + (Q.pid === p.pid ? '  -  playing' : ''),
          thumb: p.cover ? thumb(p.cover) : '', cur: Q.pid === p.pid, play: () => openPlaylist(p.pid),
          menu: (b) => playlistMenu(p, b) }));
      });
      return;
    }
    const p = PL.open;
    const items = p.items.map(libToItem);
    if (!items.length) empty.textContent = 'This playlist is empty. Use Add to playlist in any song\'s ... menu.';
    items.slice(0, PL.shown).forEach((it, i) => {
      frag.append(itemRow({ title: it.title, sub: it.channel, thumb: thumbFor(it), dur: it.duration, cur: itemKey(it) === curKey, qi: i,
        drag: { min: 0, move: (from, to) => editOpen((list) => { const [x] = list.splice(from, 1); list.splice(to, 0, x); }) },
        play: () => playList(items, i, false, p.pid),
        menu: (b) => queueEntries(it).concat([
          favEntry(it),
          { label: 'Remove from this playlist', fn: () => editOpen((list) => { list.splice(i, 1); }) },
          plEntry(it, b)
        ]) }));
    });
    if (items.length > PL.shown) {
      const more = document.createElement('li');
      more.className = 'item more-row';
      more.textContent = 'Show more (' + (items.length - PL.shown) + ' left)';
      more.addEventListener('click', () => { PL.shown += 200; renderList(); });
      frag.append(more);
    }
  }

  function renderRepeat() {
    const b = el('btnRepeat');
    b.classList.toggle('on', S.repeat !== 'off');
    b.classList.toggle('one', S.repeat === 'one');
    b.title = S.repeat === 'off' ? 'Repeat: off' : (S.repeat === 'all' ? 'Repeat: playlist' : 'Repeat: this song');
  }

  // ---------- row menu ----------
  const menuEl = el('menu');
  function closeMenu() { menuEl.hidden = true; }
  function openMenu(anchor, entries) {
    menuEl.textContent = '';
    entries.forEach((en) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = en.label;
      b.addEventListener('click', (ev) => { ev.stopPropagation(); closeMenu(); en.fn(); });
      menuEl.append(b);
    });
    menuEl.hidden = false;
    const r = anchor.getBoundingClientRect();
    const mh = menuEl.offsetHeight, mw = menuEl.offsetWidth;
    const top = r.bottom + 4 + mh > window.innerHeight ? r.top - mh - 4 : r.bottom + 4;
    menuEl.style.top = Math.max(4, top) + 'px';
    menuEl.style.left = Math.max(4, r.right - mw) + 'px';
  }
  document.addEventListener('pointerdown', (e) => { if (!menuEl.hidden && !menuEl.contains(e.target)) closeMenu(); }, true);
  el('list').addEventListener('scroll', closeMenu);

  function favEntry(it) {
    const on = isFav(it);
    return { label: on ? 'Remove from favorites' : 'Add to favorites', fn: () => toggleFav(it, !on) };
  }
  function queueEntries(it) {
    return [
      { label: 'Play next', fn: () => queueInsert(it, 'next') },
      { label: 'Add to end of queue', fn: () => queueInsert(it, 'end') }
    ];
  }

  function itemRow(o) {
    const li = document.createElement('li');
    li.className = 'item' + (o.cur ? ' cur' : '');
    if (o.qi !== undefined) li.dataset.qi = String(o.qi);
    if (o.drag) {
      const grip = document.createElement('span');
      grip.className = 'grip';
      grip.title = 'Drag to move';
      li.append(grip);
      enableDrag(li, grip, o.qi, o.drag);
    }
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
    if (o.menu && helper.on) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'more';
      b.title = 'More';
      for (let i = 0; i < 3; i++) b.append(document.createElement('i'));
      b.addEventListener('click', (e) => { e.stopPropagation(); openMenu(b, o.menu(b)); });
      li.append(b);
    }
    li.addEventListener('click', o.play);
    return li;
  }

  // Drag a queue row by its grip to a new position.
  function enableDrag(li, grip, index, opts) {
    grip.addEventListener('click', (e) => e.stopPropagation());
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
      grip.setPointerCapture(e.pointerId);
      const list = el('list');
      const rows = [...list.children];
      let target = index;
      li.classList.add('dragging');
      const clear = () => rows.forEach((r) => r.classList.remove('dropAbove', 'dropBelow'));
      const move = (ev) => {
        const lr = list.getBoundingClientRect();
        if (ev.clientY < lr.top + 24) list.scrollTop -= 12;
        else if (ev.clientY > lr.bottom - 24) list.scrollTop += 12;
        clear();
        for (const r of rows) {
          const b = r.getBoundingClientRect();
          if (ev.clientY < b.top || ev.clientY >= b.bottom || r.dataset.qi === undefined) continue;
          const ti = Number(r.dataset.qi);
          if (ti < opts.min) break;
          const below = ev.clientY > b.top + b.height / 2;
          r.classList.add(below ? 'dropBelow' : 'dropAbove');
          target = below ? ti + 1 : ti;
          break;
        }
      };
      const up = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        grip.removeEventListener('pointercancel', up);
        clear();
        li.classList.remove('dragging');
        let to = target;
        if (to > index) to -= 1;
        if (to !== index) opts.move(index, to);
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
      grip.addEventListener('pointercancel', up);
    });
  }

  function thumbFor(it) {
    if (kindOf(it) === 'yt') return it.id ? thumb(it.id) : '';
    const id = artCache[(it.channel || it.author || '') + ' - ' + it.title];
    return id ? thumb(id) : '';
  }

  function renderList() {
    closeMenu();
    const ul = el('list');
    const empty = el('empty');
    ul.textContent = '';
    empty.textContent = '';
    const frag = document.createDocumentFragment();
    const curKey = P.cur ? itemKey(currentAsItem() || {}) : '';
    if (listTab === 'folder') {
      el('folderPathLbl').textContent = F.path || S.folderPath || 'No folder chosen';
      if (!helper.on) empty.innerHTML = 'Your music folder needs <b>Radiolock</b> running on this PC.';
      else if (F.missing) empty.textContent = 'Music folder not found. Click Choose folder.';
      else if (!F.loaded) empty.textContent = 'Loading your music folder...';
      else if (!F.files.length) empty.textContent = 'No songs in ' + (F.path || 'the folder') + '.';
      F.files.forEach((f, i) => {
        const it = folderItem(f);
        frag.append(itemRow({ title: it.title, sub: it.channel, thumb: thumbFor(it), cur: itemKey(it) === curKey,
          play: () => playFolderAt(i, true), menu: (b) => queueEntries(it).concat([favEntry(it), plEntry(it, b)]) }));
      });
    } else if (listTab === 'results') {
      if (!results.length) empty.innerHTML = helper.on ? 'Search for a song, or paste a YouTube link.<br>Click a song to play it.' :
        'Paste a YouTube link or playlist above.<br>Run <b>Radiolock</b> for search and ad-free audio.';
      results.forEach((r) => {
        const it = { kind: 'yt', id: r.id, title: r.title, channel: r.channel, duration: r.duration };
        frag.append(itemRow({ title: r.title, sub: r.channel, thumb: thumb(r.id), dur: r.duration, cur: itemKey(it) === curKey,
          play: () => playYouTube(it, true), menu: (b) => queueEntries(it).concat([favEntry(it), plEntry(it, b)]) }));
      });
    } else if (listTab === 'favorites' || listTab === 'recent') {
      const fav = listTab === 'favorites';
      const src = fav ? LIB.fav : LIB.recent;
      el('libCount').textContent = fav ? src.length + (src.length === 1 ? ' song' : ' songs') : '';
      if (!helper.on) empty.innerHTML = (fav ? 'Favorites' : 'Recently played') + ' need <b>Radiolock</b> running on this PC.';
      else if (!src.length) empty.textContent = fav ? 'No favorites yet. Use the heart, or the ... menu on any song.' : 'Songs you play show up here.';
      const items = src.map(libToItem);
      items.forEach((it, i) => {
        const entries = (b) => fav
          ? queueEntries(it).concat([{ label: 'Remove from favorites', fn: () => toggleFav(it, false) }, plEntry(it, b)])
          : queueEntries(it).concat([favEntry(it), plEntry(it, b)]);
        frag.append(itemRow({ title: it.title, sub: it.channel, thumb: thumbFor(it), dur: it.duration, cur: itemKey(it) === curKey,
          play: () => playList(items, i, false), menu: entries }));
      });
    } else if (listTab === 'playlists') {
      renderPlaylists(frag, empty, curKey);
    } else {
      if (P.engine === 'embed') {
        empty.textContent = 'Up next is handled by YouTube without Radiolock running.';
      } else if (!P.queueMode) {
        empty.textContent = S.source === 'folder' ? 'Playing your folder. Use Play next on any song to start a queue.' :
          'Nothing queued yet. Songs you play start a radio of similar music.';
      } else {
        Q.items.slice(Math.max(0, Q.idx), Q.idx + 60).forEach((q, k) => {
          const i = Math.max(0, Q.idx) + k;
          const isCur = i === Q.idx;
          frag.append(itemRow({ title: q.title, sub: q.channel, thumb: thumbFor(q), dur: q.duration, cur: isCur, qi: i,
            drag: isCur ? null : { min: Q.idx + 1, move: queueMove },
            play: () => playQueueAt(i, true),
            menu: (b) => isCur ? [favEntry(q), plEntry(q, b)] : [
              { label: 'Play now', fn: () => playQueueAt(i, true) },
              { label: 'Move to top', fn: () => queueMove(i, Q.idx + 1) },
              { label: 'Remove from queue', fn: () => queueRemove(i) },
              favEntry(q),
              plEntry(q, b)
            ] }));
        });
      }
    }
    ul.append(frag);
  }

  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => { listTab = t.dataset.list; renderTabs(); renderList(); }));
  el('btnPlay').addEventListener('click', () => { if (P.playing) pause(); else play(); });
  el('btnNext').addEventListener('click', () => next());
  el('btnFav').addEventListener('click', () => toggleFav(currentAsItem()));
  el('btnShuffleFav').addEventListener('click', () => playList(LIB.fav.map(libToItem), 0, true));
  el('btnPlayFav').addEventListener('click', () => playList(LIB.fav.map(libToItem), 0, false));
  el('btnRepeat').addEventListener('click', () => {
    S.repeat = S.repeat === 'off' ? 'all' : (S.repeat === 'all' ? 'one' : 'off');
    save('rl_settings', S);
    renderRepeat();
    setNotice(S.repeat === 'off' ? 'Repeat off.' : (S.repeat === 'all' ? 'Repeat the playlist.' : 'Repeat this song.'));
  });
  el('plBack').addEventListener('click', () => { PL.open = null; renderTabs(); renderList(); });
  el('plPlay').addEventListener('click', () => { if (PL.open) playList(PL.open.items.map(libToItem), 0, false, PL.open.pid); });
  el('plShuffle').addEventListener('click', () => { if (PL.open) playList(PL.open.items.map(libToItem), 0, true, PL.open.pid); });
  el('plMore').addEventListener('click', (e) => { e.stopPropagation(); if (PL.open) openMenu(el('plMore'), playlistMenu(PL.open, el('plMore'))); });
  el('plNew').addEventListener('click', () => newPlaylist([]));
  el('plNameInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.keyCode === 13) { e.preventDefault(); finishRename(true); }
    else if (e.key === 'Escape') finishRename(false);
  });
  el('plNameInput').addEventListener('blur', () => finishRename(true));
  el('btnPrev').addEventListener('click', () => prev());
  el('artBox').parentElement.querySelector('.bar').addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const d = curDur();
    if (d > 0) seek(Math.max(0, Math.min(d - 3, (e.clientX - r.left) / r.width * d)));
  });

  // ---------- audio graph: visualizer, loudness leveling, volume ----------
  // source -> meter (loudness) and viz (bars); source -> level gain -> volume gain -> speakers.
  let graph = null, graphTried = false;
  function graphSetup() {
    if (graph || graphTried || P.engine !== 'audio' || !P.activated) return;
    graphTried = true;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC();
      ctx.resume().then(() => {
        if (ctx.state !== 'running') { graphTried = false; ctx.close(); return; }
        const src = ctx.createMediaElementSource(audio);
        const meter = ctx.createAnalyser();
        meter.fftSize = 2048;
        const viz = ctx.createAnalyser();
        viz.fftSize = 512; viz.smoothingTimeConstant = 0.5; viz.minDecibels = -100; viz.maxDecibels = -20;
        const level = ctx.createGain();
        const vol = ctx.createGain();
        src.connect(meter);
        src.connect(viz);
        src.connect(level);
        level.connect(vol);
        vol.connect(ctx.destination);
        graph = { ctx: ctx, meter: meter, viz: viz, level: level, vol: vol,
          fbuf: new Float32Array(meter.fftSize), vbuf: new Uint8Array(viz.frequencyBinCount), peak: [0, 0, 0, 0, 0] };
        applyVol();
        applyLevel(true);
        send('viz', { ok: true });
      }).catch((e) => { graphTried = false; log('audio graph: ' + e.name); });
    } catch (e) { log('audio graph: ' + e.name); }
  }

  // Loudness leveling: measure each song's average level, then gain it toward a common target.
  const LOUD_TARGET_DB = -18;
  const LOUD_SAMPLES = 280;
  const loudStore = load('rl_loud', {});
  const meterState = { key: '', sum: 0, n: 0, done: false };

  function meterReset() {
    const key = P.cur ? itemKey(P.cur.kind === 'folder' ? P.cur : { kind: 'yt', id: P.cur.id }) : '';
    meterState.key = key;
    meterState.sum = 0;
    meterState.n = 0;
    meterState.done = key in loudStore;
    applyLevel(true);
  }

  function levelDb() {
    if (!S.levelLoud2 || P.engine !== 'audio' || !meterState.key) return 0;
    if (meterState.key in loudStore) return loudStore[meterState.key];
    if (meterState.n < 40) return 0;
    return Math.max(-12, Math.min(9, LOUD_TARGET_DB - 10 * Math.log10(meterState.sum / meterState.n)));
  }

  function applyLevel(immediate) {
    if (!graph) return;
    const g = Math.pow(10, levelDb() / 20);
    graph.level.gain.setTargetAtTime(g, graph.ctx.currentTime, immediate ? 0.01 : 1.5);
  }

  function meterTick() {
    if (meterState.done || !S.levelLoud2) return;
    graph.meter.getFloatTimeDomainData(graph.fbuf);
    let ms = 0;
    for (let i = 0; i < graph.fbuf.length; i++) ms += graph.fbuf[i] * graph.fbuf[i];
    ms /= graph.fbuf.length;
    if (ms < 1e-5) return;
    meterState.sum += ms;
    meterState.n++;
    if (meterState.n % 30 === 0) applyLevel(false);
    if (meterState.n >= LOUD_SAMPLES) {
      meterState.done = true;
      loudStore[meterState.key] = Math.round(levelDb() * 10) / 10;
      const keys = Object.keys(loudStore);
      if (keys.length > 3000) delete loudStore[keys[0]];
      save('rl_loud', loudStore);
      applyLevel(false);
    }
  }

  // Read-only hook for automated tests.
  window.__rlVolume = () => (graph ? graph.vol.gain.value : audio.volume);

  const BANDS = [[1, 2], [3, 5], [6, 12], [13, 30], [31, 80]];
  setInterval(() => {
    if (!graph || P.engine !== 'audio' || audio.paused) return;
    if (graph.ctx.state !== 'running') { graph.ctx.resume().catch(() => {}); return; }
    meterTick();
    if (!S.visualizer) return;
    graph.viz.getByteFrequencyData(graph.vbuf);
    let out = '';
    for (let i = 0; i < BANDS.length; i++) {
      let s = 0, c = 0;
      for (let j = BANDS[i][0]; j <= BANDS[i][1]; j++) { s += graph.vbuf[j]; c++; }
      const avg = s / c;
      graph.peak[i] = Math.max(avg, graph.peak[i] * 0.992);
      out += graph.peak[i] < 8 ? 0 : Math.min(9, Math.floor(avg / graph.peak[i] * 9.4));
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

  // ---------- song sharing (relay on Cloudflare, notes encrypted here) ----------
  // Room and key both come from the sorted player names, which the relay never sees.
  const RELAY = 'wss://radiolock.ketiakhitam.workers.dev/r/';
  const share = { ws: null, room: '', key: null, note: '', want: false, lastSend: 0, sendT: null, pingT: null,
    retryT: null, fails: 0, sentReal: false, lastReal: '', peers: {} };

  async function sha256Hex(text) {
    const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
  }
  async function roomKey(src) {
    const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('radiolock-key|' + src));
    return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }
  function b64(u8) { let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); }
  function unb64(t) { const r = atob(t); const u = new Uint8Array(r.length); for (let i = 0; i < r.length; i++) u[i] = r.charCodeAt(i); return u; }

  async function onPeerCmd(a) {
    a = a || {};
    const src = String(a.room || ''), note = String(a.note || '');
    share.want = !!(RELAY && src && a.on);
    if (!share.want) { shareClose(); share.note = note; return; }
    try {
      const room = await sha256Hex('radiolock-room|' + src);
      if (room !== share.room) {
        shareClose();
        share.room = room;
        share.key = await roomKey(src);
        share.note = note;
        shareConnect();
      } else if (note !== share.note) {
        share.note = note;
        shareSend();
      }
    } catch (e) { log('sharing setup failed: ' + e.message); }
  }

  function shareClose() {
    const ws = share.ws;
    share.ws = null; share.room = ''; share.key = null;
    clearTimeout(share.retryT); clearTimeout(share.sendT); clearInterval(share.pingT);
    share.retryT = null; share.sendT = null; share.pingT = null;
    share.fails = 0; share.sentReal = false; share.lastReal = ''; share.peers = {};
    if (ws) {
      try { ws.close(); } catch (e) { log('sharing close: ' + e.message); }
      send('peerstate', { on: false });
    }
  }

  function shareConnect() {
    if (!share.room || share.ws) return;
    let ws;
    try { ws = new WebSocket(RELAY + share.room); } catch (e) { log('sharing connect: ' + e.message); return; }
    share.ws = ws;
    ws.onopen = () => {
      if (share.ws !== ws) return;
      share.fails = 0;
      send('peerstate', { on: true, room: share.room.slice(0, 6) });
      shareSend();
      share.pingT = setInterval(() => { try { ws.send('ping'); } catch (e) { log('sharing ping: ' + e.message); } }, 240000);
    };
    ws.onmessage = (e) => {
      if (share.ws !== ws || e.data === 'pong') return;
      let m;
      try { m = JSON.parse(e.data); } catch (err) { return; }
      if (m.type === 'note') shareRecv(m);
      else if (m.type === 'gone') shareGone(m.from);
    };
    ws.onclose = () => {
      if (share.ws !== ws) return;
      share.ws = null;
      clearInterval(share.pingT);
      send('peerstate', { on: false });
      share.fails++;
      const delays = [8000, 30000, 120000, 300000];
      if (share.want && share.room && share.fails <= 5) {
        share.retryT = setTimeout(() => { share.retryT = null; shareConnect(); }, delays[Math.min(share.fails - 1, delays.length - 1)]);
      }
    };
  }

  // The relay drops notes sent less than 1.5 s apart, so sends are spaced 2.2 s.
  function shareSend() {
    const ws = share.ws;
    if (!ws || ws.readyState !== 1 || !share.key) return;
    if (!share.note && !share.sentReal) return;
    const wait = 2200 - (Date.now() - share.lastSend);
    if (wait > 0) { if (!share.sendT) share.sendT = setTimeout(() => { share.sendT = null; shareSend(); }, wait); return; }
    share.lastSend = Date.now();
    const real = !!share.note;
    let body;
    if (real) {
      let o;
      try { o = JSON.parse(share.note); } catch (e) { log('sharing note unreadable'); return; }
      if (o.c && P.cur && P.cur.kind === 'yt') o.p = Math.max(0, Math.round(curTime()));
      body = JSON.stringify(o);
      share.lastReal = share.note;
    } else {
      let last = {};
      try { last = JSON.parse(share.lastReal || '{}'); } catch (e) { last = {}; }
      body = JSON.stringify({ off: 1, h: last.h || '', n: last.n || '' });
    }
    const iv = crypto.getRandomValues(new Uint8Array(12));
    crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, share.key, new TextEncoder().encode(body)).then((ct) => {
      const all = new Uint8Array(12 + ct.byteLength);
      all.set(iv, 0);
      all.set(new Uint8Array(ct), 12);
      try { ws.send(b64(all)); if (real) share.sentReal = true; send('peersent', { off: !real }); }
      catch (e) { log('sharing send: ' + e.message); }
    }).catch((e) => log('sharing encrypt: ' + e.name));
  }

  function shareRecv(m) {
    if (!share.key || typeof m.data !== 'string' || m.data.length > 2048) return;
    let all;
    try { all = unb64(m.data); } catch (e) { return; }
    if (all.length < 29) return;
    crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, share.key, all.slice(12)).then((pt) => {
      const o = JSON.parse(new TextDecoder().decode(pt));
      const nm = String(o.n || '').slice(0, 40), hr = String(o.h || '').slice(0, 40);
      if (!nm && !hr) return;
      share.peers[m.from] = { n: nm, h: hr };
      const idm = /^y:([A-Za-z0-9_-]{11})$/.exec(String(o.c || ''));
      let bs = String(o.b || '');
      if (!/^(gold|silver|dark|neon|glass|off)$/.test(bs)) bs = '';
      let ps = Number(o.p);
      if (!(ps >= 0 && ps < 36000)) ps = -1;
      send('peer', { n: nm, h: hr, id: idm ? idm[1] : '', t: String(o.t || '').replace(/[\u0000-\u001f]/g, '').slice(0, 60),
        off: !!o.off, b: bs, p: ps, age: Math.min(3600000, Math.max(0, Number(m.age) || 0)) });
    }).catch(() => { /* note from another room key or tampered, ignored by design */ });
  }

  function shareGone(from) {
    const p = share.peers[from];
    if (!p) return;
    delete share.peers[from];
    send('peer', { n: p.n, h: p.h, id: '', t: '', off: true, b: '', p: -1, age: 0 });
  }

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
      case 'playId':
        if (YT_ID.test(String(a[0]))) {
          if (S.source !== 'youtube') { switchSource('youtube'); send('source', { src: 'youtube' }); }
          playYouTube({ id: a[0], title: 'Loading...', channel: '', duration: 0 }, true, a[1] || 0);
        }
        break;
      case 'peer': onPeerCmd(a); break;
      case 'source': switchSource(a); break;
      case 'rescan': if (S.source === 'folder') loadFolder(!P.cur); break;
      case 'pickFolder': pickFolder(); break;
      case 'fav': toggleFav(currentAsItem()); break;
      case 'hotkeySet': setHotkey(String(a), false); break;
      case 'hotkeyClear': setHotkey(String(a), true); break;
      case 'hotkeysGet': sendHotkeys(); break;
      case 'logs': writeGameLog(a); break;
      case 'zoom': document.documentElement.style.zoom = String(Number(a) || 1); break;
      case 'repaint':
        document.documentElement.classList.toggle('dlmrp');
        window.dispatchEvent(new Event('resize'));
        break;
      default: log('unknown command ' + cmd);
    }
  }

  // Game log lines go to game.log next to the helper, so bugs can be traced without -condebug.
  function writeGameLog(lines) {
    if (!helper.on || !Array.isArray(lines) || !lines.length) return;
    const body = lines.map((l) => String(l).slice(0, 500)).join('\n');
    fetch(HELPER + '/log', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: body, cache: 'no-store' })
      .catch((e) => { console.warn('game log write failed', e); });
  }

  function applySettings(o) {
    const before = { source: S.source, folderPath: S.folderPath, visualizer: S.visualizer, skipAds: S.skipAds, levelLoud2: S.levelLoud2 };
    Object.keys(o).forEach((k) => { S[k] = o[k]; });
    save('rl_settings', S);
    if (S.source !== before.source) switchSource(S.source);
    else if (S.source === 'folder' && S.folderPath !== before.folderPath) loadFolder(true);
    if (!S.skipAds && P.adMuted) { P.adMuted = false; applyVol(); }
    if (S.visualizer && !before.visualizer) graphSetup();
    if (S.levelLoud2 !== before.levelLoud2) applyLevel(true);
    renderStatus();
  }

  window.addEventListener('hashchange', onHash);

  // ---------- boot ----------
  renderTabs();
  renderNow();
  renderList();
  renderStatus();
  renderRepeat();
  send('hello', { version: VERSION, saved: load('rl_settings', null) });
  listTab = S.source === 'folder' ? 'folder' : 'results';
  renderTabs();
  checkHelper().then(() => {
    if (S.source === 'folder') loadFolder(true);
    else maybeResumeYouTube();
    renderList();
  });
})();
