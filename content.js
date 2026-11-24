/*
 * Read Aloud Player for Grok
 *
 * Runs in the page's MAIN world at document_start so it sees every way Grok can
 * play speech, including audio objects that never touch the DOM:
 *   1. HTMLMediaElement (new Audio(), <audio>, MediaSource streams)  -> full seek + speed
 *   2. Web Audio buffer sources (chunked streaming TTS)               -> pause/resume + progress
 *   3. window.speechSynthesis                                         -> seek (by text) + speed
 * Then renders a floating player in a closed shadow root.
 */
(() => {
  'use strict';
  if (window.__grokReadAloudPlayer) return;
  window.__grokReadAloudPlayer = true;

  /* ---------------------------------------------------------------- settings */

  const KEY = 'grok-read-aloud-player';
  const SPEEDS = [0.5, 0.75, 1, 1.15, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3];
  const SKIP = 10;
  const HL_COLORS = { yellow: '250,204,21', green: '74,222,128', blue: '96,165,250',
    pink: '244,114,182', orange: '251,146,60', purple: '167,139,250' };
  const settings = { rate: 1, collapsed: false, pos: null, hl: true, hlColor: 'yellow' };
  try { Object.assign(settings, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch {}
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch {} };

  // On x.com only act inside Grok, never on timeline videos/Spaces.
  const isX = /(^|\.)x\.com$/.test(location.hostname);
  const activeHere = () => !isX || location.pathname.startsWith('/i/grok');

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const rangeEnd = (r) => (r && r.length ? r.end(r.length - 1) : 0);
  const fmt = (s) => {
    s = isFinite(s) && s > 0 ? Math.floor(s) : 0;
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
  };

  /* ---------------------------------------------------------------- sources */

  let src = null; // active adapter

  function setSource(a) {
    if (src === a) return;
    if (src && src.dispose) src.dispose();
    src = a;
    if (src.canRate) src.setRate();
    hidden = false;
    everDocked = false;
    srcSince = performance.now();
    mount();
    render();
  }

  // 1. Media elements ------------------------------------------------------
  const origPlay = HTMLMediaElement.prototype.play;
  const MEDIA_EVENTS = ['play', 'playing', 'pause', 'ended', 'timeupdate', 'durationchange',
    'progress', 'ratechange', 'seeked', 'emptied', 'loadedmetadata', 'waiting'];

  // Grok streams read-aloud as an HTTP audio file with no length and no range support, so the
  // browser can't seek it (Grok's own skip doesn't work either). We download the same file in
  // the background and, on the first seek, swap the element over to that complete, seekable copy.
  const GROK_TTS = /\/read-response-audio/;

  // Streamed WAVs carry placeholder sizes; patch them so the blob reports its real duration.
  async function fixWav(blob) {
    const head = new DataView(await blob.slice(0, 4096).arrayBuffer());
    if (head.byteLength < 12 || head.getUint32(0) !== 0x52494646) return blob; // 'RIFF'
    const buf = await blob.arrayBuffer(), v = new DataView(buf);
    v.setUint32(4, buf.byteLength - 8, true);
    for (let o = 12; o + 8 <= Math.min(buf.byteLength, 4096); o += 8 + v.getUint32(o + 4, true)) {
      if (v.getUint32(o) === 0x64617461) { v.setUint32(o + 4, buf.byteLength - o - 8, true); break; } // 'data'
    }
    return new Blob([buf], { type: blob.type || 'audio/wav' });
  }

  const probeDuration = (url) => new Promise((resolve) => {
    const a = new Audio();
    const done = (d) => { resolve(d); a.removeAttribute('src'); a.load(); };
    a.preload = 'metadata';
    a.muted = true;
    a.addEventListener('loadedmetadata', () => {
      if (isFinite(a.duration)) done(a.duration);
      else a.currentTime = 1e7; // forces Chrome to scan to the real end
    });
    a.addEventListener('durationchange', () => { if (isFinite(a.duration) && a.duration > 0) done(a.duration); });
    a.addEventListener('error', () => done(0));
    setTimeout(() => done(0), 10000);
    a.src = url;
  });

  // Byte formats Chrome can feed through MediaSource as they download (seekable, no re-swaps)
  function mseType(type, b) {
    type = (type || '').split(';')[0].trim().toLowerCase();
    let t = { 'audio/mp3': 'audio/mpeg', 'audio/mpeg': 'audio/mpeg', 'audio/aac': 'audio/aac', 'audio/aacp': 'audio/aac',
      'audio/x-aac': 'audio/aac', 'audio/webm': 'audio/webm; codecs="opus"' }[type];
    if (!t && b && b.length > 3) {               // no useful Content-Type: sniff the first bytes
      if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) t = 'audio/mpeg';                   // ID3
      else if (b[0] === 0xff && (b[1] & 0xf6) === 0xf0) t = 'audio/aac';                         // ADTS
      else if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) t = 'audio/mpeg';                        // MPEG frame
      else if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) t = 'audio/webm; codecs="opus"';
    }
    return t && window.MediaSource && MediaSource.isTypeSupported(t) ? t : null;
  }

  function mediaAdapter(el) {
    let rateSet = settings.rate; // last rate we applied; anything else came from Grok's own button
    let full = null;             // null = not fetched, 'loading', false = failed, {url, duration, audio}
    let pendingSeek = null;      // {t, play}: a seek waiting for audio to arrive
    let livePcm = null, live = null; // decoded audio of the part downloaded so far, and its pause analysis
    let cur = null;              // the copy el plays from once it leaves Grok's stream: {url, duration, partial|mse}
    let settling = false, swapT = 0; // mid-swap: currentTime reads 0 until the new source is ready
    let parts = [], format = '', done = false;
    let ms = null;               // MediaSource fed with the download as it arrives: {ms, url, type, sb, fed}
    const ttsId = (/\/read-response-audio[^/]*\/([^/?#]+)/.exec(el.src) || [])[1]; // = Grok's responseId

    const applyRate = () => {
      rateSet = settings.rate;
      try { el.preservesPitch = true; el.defaultPlaybackRate = settings.rate; el.playbackRate = settings.rate; } catch {}
    };
    const playingNow = () => !el.paused && !el.ended;

    const feed = () => {
      if (!ms || !ms.sb || ms.sb.updating || ms.ms.readyState !== 'open') return;
      if (ms.fed < parts.length) {
        const add = parts.slice(ms.fed), buf = new Uint8Array(add.reduce((n, a) => n + a.length, 0));
        let o = 0;
        for (const a of add) { buf.set(a, o); o += a.length; }
        ms.fed = parts.length;
        try { ms.sb.appendBuffer(buf); } catch { /* quota or parse error: the WAV copy still works */ }
      } else if (done) { try { ms.ms.endOfStream(); } catch {} }
    };

    const prefetch = () => {
      const url = el.currentSrc || el.src;
      if (full !== null || !/^https?:/.test(url)) return;
      full = 'loading';
      (async () => {
        const r = await fetch(url, { credentials: 'include' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        // Read it as it streams in and decode what has arrived every ~1.5s: the word highlight
        // runs on the real audio, and skips can land anywhere already downloaded.
        const reader = r.body.getReader(), type = r.headers.get('content-type') || '';
        let bytes = 0, last = 0, busy = false;
        for (;;) {
          const { done: end, value } = await reader.read();
          if (end) break;
          if (!parts.length) {
            const t = mseType(type, value);
            format = (type || '?') + (t ? ' → MediaSource' : ' → WAV copies');
            if (t) { const m = new MediaSource(); ms = { ms: m, url: URL.createObjectURL(m), type: t, sb: null, fed: 0 }; }
          }
          parts.push(value); bytes += value.length;
          feed();
          if (!busy && bytes > 24000 && performance.now() - last > 1500) {
            busy = true; last = performance.now();
            decodePcm(new Blob(parts, { type })).then((pcm) => {
              if (!pcm || full !== 'loading' || (livePcm && pcm.duration <= livePcm.duration)) return;
              livePcm = pcm; live = findPauses(pcm, true);
              onData();
            }).finally(() => { busy = false; });
          }
        }
        done = true;
        feed();
        return new Blob(parts, { type });
      })()
        .then(async (blob) => {
          // Re-encode as plain WAV: compressed streams (AAC/MP3) seek by estimate and can land
          // seconds off, which knocks the word highlight out of sync. WAV seeks to the sample.
          const pcm = await decodePcm(blob);
          const u = URL.createObjectURL(pcm ? toWav(pcm) : await fixWav(blob));
          const d = pcm ? pcm.duration : await probeDuration(u);
          if (!d) { URL.revokeObjectURL(u); throw new Error('no duration'); }
          if (src && src.el !== el) { URL.revokeObjectURL(u); return; } // a newer read aloud took over
          full = { url: u, duration: d, audio: pcm && findPauses(pcm, false) };
          livePcm = null;
          onData();
        })
        .catch(() => { full = false; pendingSeek = null; render(); });
    };

    const swapTo = (t, resume, to) => {
      const old = cur;
      cur = to; settling = true; swapT = t;
      el.src = to.url;
      if (to.mse) {
        ms.ms.addEventListener('sourceopen', () => {
          try { ms.sb = ms.ms.addSourceBuffer(ms.type); } catch { return; }
          ms.sb.addEventListener('updateend', feed);
          feed();
        }, { once: true });
      }
      el.addEventListener('loadedmetadata', () => {
        el.currentTime = clamp(swapT, 0, to.duration - 0.05);
        applyRate();
        settling = false;
        if (resume) origPlay.call(el).catch(() => {});
        if (old && old.partial) URL.revokeObjectURL(old.url);
      }, { once: true });
    };
    // How far a seek can go right now
    const reach = () => {
      if (full && full.url) return Infinity;
      if (cur && cur.mse) return done ? Infinity : rangeEnd(el.buffered) - 0.5;
      return livePcm ? livePcm.duration - 4 : 0;
    };
    // Move onto a seekable copy that reaches t: the full one, the MediaSource feed, or a WAV of
    // what's downloaded so far
    const moveTo = (t, resume) => {
      if (full && full.url && !(cur && cur.mse)) { swapTo(t, resume, full); return true; }
      if (ms && !cur) {
        if (!livePcm || t > livePcm.duration - 0.5) return false;
        swapTo(t, resume, { url: ms.url, duration: Infinity, mse: true });
        return true;
      }
      if (!ms && livePcm && t < livePcm.duration - 2) {
        swapTo(t, resume, { url: URL.createObjectURL(toWav(livePcm)), duration: livePcm.duration, partial: true });
        return true;
      }
      return false;
    };
    // New audio arrived: apply a waiting seek, and keep a WAV copy from running out
    const onData = () => {
      if (pendingSeek && t0Ready(pendingSeek.t)) {
        const { t, play } = pendingSeek;
        pendingSeek = null;
        if (cur && cur.mse) { el.currentTime = t; if (play) origPlay.call(el).catch(() => {}); }
        else moveTo(t, play);
      } else if (cur && cur.partial && full && full.url && !settling) swapTo(el.currentTime, playingNow(), full);
      else topUp();
      park();
      render();
    };
    const t0Ready = (t) => t <= reach() || (full && full.url) || (livePcm && t < livePcm.duration - 2);
    // WAV fallback only: a partial copy is about to run out. Switch to a longer one, but only once
    // there's a few seconds more, so switches (each a tiny gap) stay rare.
    const topUp = () => {
      if (!cur || !cur.partial || settling || pendingSeek || el.currentTime < cur.duration - 1.5) return;
      const t = el.currentTime, play = playingNow();
      if (full && full.url) return swapTo(t, play, full);
      if (livePcm && livePcm.duration >= cur.duration + 3) return moveTo(t, play);
      if (play && t >= cur.duration - 0.5) { el.pause(); pendingSeek = { t, play: true }; } // out of audio: wait
    };
    // A paused live stream goes stale: Chrome drops the connection, and after resuming the audio
    // no longer lines up with currentTime (so the word highlight runs ahead). Park a paused
    // reading on a seekable copy at the same spot; resuming from there is exact.
    const park = () => {
      if (!cur && el.paused && !el.ended && el.currentTime > 0 && !pendingSeek) moveTo(el.currentTime, false);
    };
    const onEvt = (e) => {
      if (e.type === 'pause') park();
      if (e.type === 'timeupdate') topUp();
      // Grok's play button pressed while a skip waits for its audio: play once it lands, not from the old spot
      if (e.type === 'play' && pendingSeek) { pendingSeek.play = true; el.pause(); }
      if (e.type === 'ratechange' && Math.abs(el.playbackRate - rateSet) > 0.001) {
        // Grok's own speed button changed it: adopt that as the user's choice.
        settings.rate = rateSet = Math.round(el.playbackRate * 100) / 100;
        save();
      } else if ((e.type === 'loadedmetadata' || e.type === 'play') && Math.abs(el.playbackRate - settings.rate) > 0.001) {
        applyRate();
      }
      if (e.type === 'loadedmetadata' && !isFinite(el.duration) && !cur) prefetch();
      render();
    };
    MEDIA_EVENTS.forEach((t) => el.addEventListener(t, onEvt));
    if (GROK_TTS.test(el.src)) prefetch();

    return {
      kind: 'media', el, canRate: true, ttsId: ttsId && decodeURIComponent(ttsId),
      get analysis() { return (full && full.audio) || live; },
      get settling() { return settling; },
      get state() {
        return { format, pendingSeek, settling, cur: cur && { d: cur.duration, partial: !!cur.partial, mse: !!cur.mse },
          loaded: livePcm && livePcm.duration, full: full && (full.url ? full.duration : full) };
      },
      get canSeek() { return isFinite(el.duration) || full !== false; },
      get preparing() { return !!pendingSeek || (!isFinite(el.duration) && !livePcm && (full === null || full === 'loading')); },
      get playing() { return playingNow(); },
      get ended() { return el.ended; },
      get time() { return pendingSeek ? pendingSeek.t : settling ? swapT : el.currentTime || 0; },
      get duration() {
        if (full && full.duration) return full.duration;
        if (livePcm) return livePcm.duration;
        const d = el.duration;
        return isFinite(d) && d > 0 ? d : 0;
      },
      get streaming() { return !(full && full.url) && (!!livePcm || (!isFinite(el.duration) && el.readyState > 0)); },
      get buffered() { return full && full.url ? full.duration : livePcm ? livePcm.duration : rangeEnd(el.buffered) || el.currentTime; },
      toggle() {
        if (pendingSeek) { pendingSeek.play = !pendingSeek.play; render(); return; }
        if (el.paused || el.ended) {
          if (el.ended) el.currentTime = 0;
          origPlay.call(el).catch(() => {});
        } else el.pause();
      },
      seek(t) {
        t = Math.max(0, t);
        const play = pendingSeek ? pendingSeek.play : playingNow();
        // Past what has downloaded so far: go as far as we can rather than freeze (audio after
        // that point may not even be generated yet); the bar's lighter fill shows the limit.
        const r = reach();
        if (t > r && r > this.time + 1) t = r;
        if (settling) { pendingSeek = null; swapT = cur.mse ? t : clamp(t, 0, cur.duration - 0.05); return; }
        if (cur && (cur.mse || !cur.partial || t < cur.duration - 2)) {
          pendingSeek = null;
          el.currentTime = clamp(t, 0, cur.duration - 0.05);
          if (play && el.paused) origPlay.call(el).catch(() => {});
          return;
        }
        if (!cur && isFinite(el.duration)) { el.currentTime = clamp(t, 0, el.duration - 0.05); return; } // ordinary media
        if (moveTo(t, play)) { pendingSeek = null; return; }
        if (full !== false) {
          pendingSeek = { t, play };
          if (play) el.pause(); // don't keep talking from the old spot while we wait
          prefetch(); render();
        }
      },
      setRate: applyRate,
      dispose() {
        MEDIA_EVENTS.forEach((t) => el.removeEventListener(t, onEvt));
        if (cur && cur.partial && el.src !== cur.url) URL.revokeObjectURL(cur.url);
        if (full && full.url && el.src !== full.url) URL.revokeObjectURL(full.url);
        if (ms && el.src !== ms.url) URL.revokeObjectURL(ms.url);
      },
    };
  }

  function hookMedia(el) {
    if (!activeHere()) return;
    // Audio only; a detached <video> is sometimes used as an audio sink.
    if (!(el instanceof HTMLAudioElement) && !(el instanceof HTMLVideoElement && !el.isConnected)) return;
    if (isFinite(el.duration) && el.duration < 1.5) return; // UI blips, not speech
    if (src && src.el === el) return;
    setSource(mediaAdapter(el));
  }

  HTMLMediaElement.prototype.play = function () {
    try { hookMedia(this); } catch {}
    return origPlay.apply(this, arguments);
  };
  document.addEventListener('play', (e) => {
    if (e.target instanceof HTMLMediaElement) hookMedia(e.target);
  }, true);

  // 2. Web Audio --------------------------------------------------------------
  if (window.AudioBufferSourceNode) {
    const origStart = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (when, offset, dur) {
      try { hookBuffer(this, when || 0, offset || 0, dur); } catch {}
      return origStart.apply(this, arguments);
    };
  }

  function hookBuffer(node, when, offset, dur) {
    const buf = node.buffer;
    if (!activeHere() || !buf || buf.duration < 0.2) return;
    const ctx = node.context;
    let a = src && src.kind === 'webaudio' && src.ctx === ctx ? src : null;
    if (!a) { a = webAudioAdapter(ctx); setSource(a); }
    const len = (dur != null ? dur : buf.duration - offset) / (node.playbackRate.value || 1);
    a.add(node, Math.max(when, ctx.currentTime), len);
  }

  function webAudioAdapter(ctx) {
    let start = 0, end = 0, live = 0;
    const onState = () => render();
    ctx.addEventListener('statechange', onState);
    return {
      kind: 'webaudio', ctx, canSeek: false, canRate: false,
      add(node, at, len) {
        if (!end || at > end + 2) start = at; // gap > 2s = a new reading
        end = Math.max(end, at + len);
        live++;
        node.addEventListener('ended', () => { live--; render(); });
        render();
      },
      get playing() { return ctx.state === 'running' && live > 0; },
      get ended() { return live === 0; },
      get time() { return clamp(ctx.currentTime - start, 0, end - start); },
      get duration() { return Math.max(0, end - start); },
      get streaming() { return live > 0; },
      get buffered() { return this.duration; },
      toggle() { ctx.state === 'running' ? ctx.suspend() : ctx.resume(); },
      dispose() { ctx.removeEventListener('statechange', onState); },
    };
  }

  // 3. speechSynthesis --------------------------------------------------------
  const synth = window.speechSynthesis;
  const origSpeak = synth && synth.speak.bind(synth);
  const CPS = 14; // rough characters/second at 1x, for time estimates

  if (synth) {
    synth.speak = function (u) {
      try {
        if (activeHere() && u && u.text) {
          if (!(src && src.kind === 'speech' && (synth.speaking || synth.pending))) setSource(speechAdapter());
          src.add(u);
        }
      } catch {}
      return origSpeak(u);
    };
  }

  function speechAdapter() {
    const parts = [];
    let total = 0, pos = 0, own = null;
    const track = (u, base, isOwn) => {
      const ok = () => (isOwn ? own === u : !own);
      u.addEventListener('boundary', (e) => { if (ok()) { pos = base + e.charIndex; render(); } });
      u.addEventListener('start', () => { if (ok()) { pos = Math.max(pos, base); render(); } });
      u.addEventListener('end', () => { if (ok()) { pos = Math.max(pos, base + u.text.length); render(); } });
    };
    const seekChar = (c) => {
      const full = parts.map((p) => p.text).join('');
      c = clamp(Math.round(c), 0, Math.max(0, full.length - 1));
      while (c > 0 && !/\s/.test(full[c - 1])) c--; // snap to word start
      const tpl = parts[0].u;
      const u = new SpeechSynthesisUtterance(full.slice(c));
      u.voice = tpl.voice; u.lang = tpl.lang; u.pitch = tpl.pitch; u.volume = tpl.volume;
      u.rate = settings.rate;
      own = u; pos = c;
      track(u, c, true);
      synth.cancel();
      origSpeak(u);
      render();
    };
    return {
      kind: 'speech', canSeek: true, canRate: true,
      add(u) {
        parts.push({ u, text: u.text });
        track(u, total, false);
        total += u.text.length;
        u.rate = settings.rate;
      },
      get playing() { return synth.speaking && !synth.paused; },
      get ended() { return !synth.speaking && pos >= total; },
      get time() { return pos / (CPS * settings.rate); },
      get duration() { return total / (CPS * settings.rate); },
      streaming: false,
      get buffered() { return this.duration; },
      toggle() {
        if (synth.paused) synth.resume();
        else if (synth.speaking) synth.pause();
        else seekChar(pos >= total ? 0 : pos);
        setTimeout(render, 50);
      },
      seek(t) { if (total) seekChar(t * CPS * settings.rate); },
      setRate() { if (total && synth.speaking) seekChar(pos); },
      dispose() {},
    };
  }

  /* ---------------------------------------------------------------- controls */

  const skip = (d) => { if (src && src.canSeek) src.seek(src.time + d); };
  const toggle = () => { if (src) src.toggle(); };
  const setRate = (r) => {
    settings.rate = clamp(Math.round(r * 100) / 100, 0.25, 4);
    save();
    // Also store it in Grok's own persisted TTS setting so its "1x" label agrees after a reload
    if (isGrok) {
      try {
        const k = 'persist:useTextToSpeechStore', v = JSON.parse(localStorage.getItem(k) || 'null');
        if (v && v.state) { v.state.playbackRate = settings.rate; localStorage.setItem(k, JSON.stringify(v)); }
      } catch {}
    }
    if (src && src.canRate) src.setRate();
    render();
  };
  const stepRate = (dir) => {
    const i = SPEEDS.findIndex((s) => s >= settings.rate - 0.001);
    setRate(SPEEDS[clamp((i < 0 ? SPEEDS.length - 1 : i) + dir, 0, SPEEDS.length - 1)]);
  };

  // Alt+K play/pause · Alt+J / Alt+L ∓10s · Alt+[ / Alt+] speed · Alt+H word highlight. Uses e.code so macOS Option works.
  window.addEventListener('keydown', (e) => {
    if (!src || hidden || !e.altKey || e.ctrlKey || e.metaKey) return;
    const act = { KeyK: toggle, KeyJ: () => skip(-SKIP), KeyL: () => skip(SKIP),
      BracketLeft: () => stepRate(-1), BracketRight: () => stepRate(1),
      KeyH: () => { settings.hl = !settings.hl; save(); render(); } }[e.code];
    if (!act) return;
    e.preventDefault();
    e.stopPropagation();
    act();
  }, true);

  /* ---------------------------------------------------------------- UI */

  const ICON = {
    play: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M8 5.6v12.8a1 1 0 0 0 1.5.86l10.2-6.4a1 1 0 0 0 0-1.72L9.5 4.74A1 1 0 0 0 8 5.6z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><rect fill="currentColor" x="6.5" y="5" width="3.6" height="14" rx="1.2"/><rect fill="currentColor" x="13.9" y="5" width="3.6" height="14" rx="1.2"/></svg>',
    replay: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12a8 8 0 1 0 2.6-5.9"/><path d="M4 4v4.5h4.5"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 12a8.5 8.5 0 1 0 2.5-6"/><path d="M3.5 3.5V8H8"/><text x="12.2" y="15.6" font-size="7.5" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none" font-family="system-ui,sans-serif">10</text></svg>',
    fwd: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 12A8.5 8.5 0 1 1 18 6"/><path d="M20.5 3.5V8H16"/><text x="11.8" y="15.6" font-size="7.5" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none" font-family="system-ui,sans-serif">10</text></svg>',
    min: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 12h12"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M7 7l10 10M17 7L7 17"/></svg>',
    grip: '<svg viewBox="0 0 8 16" style="width:8px;height:16px"><g fill="currentColor"><circle cx="2" cy="3" r="1.2"/><circle cx="6" cy="3" r="1.2"/><circle cx="2" cy="8" r="1.2"/><circle cx="6" cy="8" r="1.2"/><circle cx="2" cy="13" r="1.2"/><circle cx="6" cy="13" r="1.2"/></g></svg>',
  };

  const CSS = `
    :host { all: initial; }
    .wrap { --fg: #f4f4f5; --bg: rgba(22, 22, 25, .88); --solid: #161619; --bd: rgba(255, 255, 255, .1);
      --sh: 0 12px 32px rgba(0, 0, 0, .35); --h: 46px;
      position: fixed; z-index: 2147483646; left: 50%; top: 68px; transform: translateX(-50%);
      font: 500 12px/1 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      color: var(--fg); -webkit-font-smoothing: antialiased; user-select: none; }
    .wrap.placed { transform: none; }
    .wrap[hidden] { display: none; }
    .bar { display: flex; align-items: center; gap: 4px; box-sizing: border-box;
      width: min(580px, calc(100vw - 32px)); height: var(--h); padding: 0 8px 0 2px;
      background: var(--bg); -webkit-backdrop-filter: blur(16px) saturate(150%); backdrop-filter: blur(16px) saturate(150%);
      border: 1px solid var(--bd); border-radius: 14px; box-shadow: var(--sh); }
    .collapsed .bar { display: none; }
    .grip { width: 16px; align-self: stretch; display: grid; place-items: center; cursor: grab;
      color: color-mix(in srgb, var(--fg) 28%, transparent); touch-action: none; }
    .grip:hover { color: color-mix(in srgb, var(--fg) 60%, transparent); }
    .grip:active { cursor: grabbing; }
    button { all: unset; box-sizing: border-box; cursor: pointer; display: inline-grid; place-items: center;
      border-radius: 8px; color: inherit; }
    button:focus-visible, .track:focus-visible { outline: 2px solid color-mix(in srgb, var(--fg) 70%, transparent); outline-offset: 1px; }
    button:disabled { opacity: .3; cursor: default; background: none !important; }
    svg { width: 18px; height: 18px; display: block; }
    .btn { width: 32px; height: 32px; border-radius: 50%; color: color-mix(in srgb, var(--fg) 80%, transparent); }
    .btn:hover { background: color-mix(in srgb, var(--fg) 9%, transparent); color: var(--fg); }
    .btn.sm svg { width: 15px; height: 15px; }
    .play { width: 34px; height: 34px; border-radius: 50%; background: var(--fg); color: var(--solid); margin: 0 2px; }
    .play:hover { transform: scale(1.04); }
    .play svg { width: 17px; height: 17px; }
    .time { font-variant-numeric: tabular-nums; font-size: 11.5px; color: color-mix(in srgb, var(--fg) 65%, transparent);
      min-width: 36px; text-align: center; }
    .track { position: relative; flex: 1; min-width: 40px; height: 26px; cursor: pointer; touch-action: none; outline: none; }
    .rail { position: absolute; left: 0; right: 0; top: 50%; height: 4px; margin-top: -2px; border-radius: 3px;
      background: color-mix(in srgb, var(--fg) 14%, transparent); overflow: hidden; transition: height .12s, margin .12s; }
    .track:hover .rail, .track.drag .rail { height: 6px; margin-top: -3px; }
    .buf, .fill { position: absolute; left: 0; top: 0; bottom: 0; width: 0; }
    .buf { background: color-mix(in srgb, var(--fg) 22%, transparent); }
    .fill { background: var(--fg); }
    .prep .rail { background-image: linear-gradient(90deg, transparent, color-mix(in srgb, var(--fg) 22%, transparent), transparent);
      background-size: 40% 100%; background-repeat: no-repeat; animation: sweep 1.2s linear infinite; }
    @keyframes sweep { from { background-position: -40% 0; } to { background-position: 140% 0; } }
    .thumb { position: absolute; left: 0; top: 50%; width: 13px; height: 13px; margin: -6.5px 0 0 -6.5px;
      border-radius: 50%; background: var(--fg); box-shadow: 0 1px 5px rgba(0, 0, 0, .35);
      transform: scale(0); transition: transform .12s; pointer-events: none; }
    .track:hover .thumb, .track.drag .thumb, .track:focus-visible .thumb { transform: scale(1); }
    .tip { position: absolute; bottom: calc(100% + 4px); left: 0; transform: translateX(-50%); padding: 4px 6px;
      border-radius: 6px; background: var(--fg); color: var(--solid); font-size: 11px; font-variant-numeric: tabular-nums;
      white-space: nowrap; pointer-events: none; opacity: 0; transition: opacity .1s; }
    .track:hover .tip, .track.drag .tip { opacity: 1; }
    .track.off { cursor: default; }
    .track.off .thumb, .track.off .tip { display: none; }
    .sw { position: relative; }
    .speed { height: 28px; min-width: 46px; padding: 0 8px; border-radius: 999px;
      background: color-mix(in srgb, var(--fg) 9%, transparent);
      font-variant-numeric: tabular-nums; font-size: 12px; font-weight: 600; }
    .speed:hover { background: color-mix(in srgb, var(--fg) 16%, transparent); }
    .menu { position: absolute; top: calc(100% + 8px); right: -4px; padding: 4px; min-width: 132px;
      display: grid; grid-template-columns: 1fr 1fr; gap: 2px;
      background: var(--solid); border: 1px solid var(--bd); border-radius: 12px;
      box-shadow: 0 12px 32px rgba(0, 0, 0, .3); }
    .menu[hidden] { display: none; }
    .low .menu, .docked .menu { top: auto; bottom: calc(100% + 8px); }
    .menu button { padding: 7px 10px; border-radius: 7px; font-variant-numeric: tabular-nums; justify-content: start; }
    .menu button:hover { background: color-mix(in srgb, var(--fg) 9%, transparent); }
    .menu button.on { background: var(--fg); color: var(--solid); }
    .hlbtn { width: 28px; height: 28px; border-radius: 50%; }
    .hlbtn:hover { background: color-mix(in srgb, var(--fg) 9%, transparent); }
    .dot { width: 13px; height: 13px; border-radius: 50%; background: rgb(var(--c, 250,204,21));
      box-shadow: inset 0 0 0 1px rgba(0, 0, 0, .18); }
    .hlbtn.off .dot { background: none; box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--fg) 45%, transparent); }
    .menu.colors { grid-template-columns: repeat(3, 30px); min-width: 0; }
    .menu.colors button { width: 30px; height: 30px; padding: 0; justify-content: center; }
    .menu.colors button.on { background: color-mix(in srgb, var(--fg) 14%, transparent); }
    .menu.colors button.on .dot { box-shadow: 0 0 0 2px var(--solid), 0 0 0 3.5px var(--fg); }
    .menu.colors .hloff { grid-column: 1 / -1; width: auto; height: 26px; font-size: 11.5px; }
    .menu.colors .hloff.on { background: var(--fg); color: var(--solid); }
    .pill { display: none; position: relative; width: 44px; height: 44px; border-radius: 50%;
      background: var(--bg); border: 1px solid var(--bd); box-shadow: var(--sh); color: var(--fg); }
    .collapsed .pill { display: grid; }
    .pill .ring { position: absolute; inset: 2px; width: 38px; height: 38px; transform: rotate(-90deg); }
    .pill .ico svg { width: 16px; height: 16px; }

    /* Docked: sits inline to the left of Grok's own read-aloud pill and borrows its look */
    .wrap.docked { transform: none; }
    .docked .bar { width: var(--w, 400px); border-radius: 999px; padding: 0 6px 0 4px;
      -webkit-backdrop-filter: none; backdrop-filter: none; }
    .docked .grip, .docked .play, .docked .min, .docked .close, .docked .pill { display: none !important; }
    .docked.collapsed .bar { display: flex; }

    @media (max-width: 480px) { .back, .fwd, .cur { display: none; } }
  `;

  let ui = null, hidden = false, raf = 0, drag = null, dragT = 0;

  function mount() {
    if (ui) return;
    const host = document.createElement('grok-read-aloud-player');
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>${CSS}</style>
      <div class="wrap" part="wrap">
        <div class="bar" role="toolbar" aria-label="Read aloud player">
          <div class="grip" title="Drag to move">${ICON.grip}</div>
          <button class="btn back" title="Back ${SKIP}s (Alt+J)" aria-label="Back ${SKIP} seconds">${ICON.back}</button>
          <button class="play" title="Play / pause (Alt+K)" aria-label="Play">${ICON.play}</button>
          <button class="btn fwd" title="Forward ${SKIP}s (Alt+L)" aria-label="Forward ${SKIP} seconds">${ICON.fwd}</button>
          <span class="time cur">0:00</span>
          <div class="track" role="slider" tabindex="0" aria-label="Seek" aria-valuemin="0">
            <div class="rail"><div class="buf"></div><div class="fill"></div></div>
            <div class="thumb"></div><div class="tip">0:00</div>
          </div>
          <span class="time dur">0:00</span>
          <div class="sw hlw" hidden>
            <button class="hlbtn" title="Highlight colour (Alt+H turns it on/off)" aria-label="Word highlight colour" aria-haspopup="true"><span class="dot"></span></button>
            <div class="menu colors" hidden>${Object.entries(HL_COLORS).map(([n, c]) =>
              `<button data-c="${n}" title="${n[0].toUpperCase() + n.slice(1)}" aria-label="${n}" style="--c:${c}"><span class="dot"></span></button>`).join('')}
              <button class="hloff" data-c="off">No highlight</button></div>
          </div>
          <div class="sw">
            <button class="speed" title="Playback speed (Alt+[ / Alt+])" aria-haspopup="true">1×</button>
            <div class="menu speeds" hidden>${SPEEDS.map((s) => `<button data-r="${s}">${s}×</button>`).join('')}</div>
          </div>
          <button class="btn sm min" title="Minimize" aria-label="Minimize">${ICON.min}</button>
          <button class="btn sm close" title="Hide until next read aloud" aria-label="Close">${ICON.close}</button>
        </div>
        <button class="pill" title="Expand player" aria-label="Expand player">
          <svg class="ring" viewBox="0 0 38 38"><circle cx="19" cy="19" r="17" fill="none" stroke="rgba(255,255,255,.15)" stroke-width="2.5"/>
            <circle class="arc" cx="19" cy="19" r="17" fill="none" stroke="#fafafa" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="106.8" stroke-dashoffset="106.8"/></svg>
          <span class="ico">${ICON.play}</span>
        </button>
      </div>`;
    const $ = (s) => root.querySelector(s);
    ui = { host, wrap: $('.wrap'), play: $('.play'), back: $('.back'), fwd: $('.fwd'), cur: $('.cur'), dur: $('.dur'),
      track: $('.track'), buf: $('.buf'), fill: $('.fill'), thumb: $('.thumb'), tip: $('.tip'),
      speed: $('.speed'), menu: $('.menu.speeds'), hlw: $('.hlw'), hlbtn: $('.hlbtn'), colors: $('.menu.colors'), pill: $('.pill'), arc: $('.arc'), pillIco: $('.pill .ico'), grip: $('.grip'),
      state: '' };

    ui.play.onclick = toggle;
    ui.back.onclick = () => skip(-SKIP);
    ui.fwd.onclick = () => skip(SKIP);
    $('.close').onclick = () => { hidden = true; render(); };
    $('.min').onclick = () => { settings.collapsed = true; save(); render(); };
    ui.pill.onclick = () => { settings.collapsed = false; save(); render(); };

    // speed menu
    ui.speed.onclick = (e) => { e.stopPropagation(); ui.menu.hidden = !ui.menu.hidden; };
    ui.speed.addEventListener('wheel', (e) => { e.preventDefault(); stepRate(e.deltaY < 0 ? 1 : -1); }, { passive: false });
    ui.menu.onclick = (e) => {
      const b = e.target.closest('button');
      if (b) { setRate(+b.dataset.r); ui.menu.hidden = true; }
    };
    // highlight colour menu
    ui.hlbtn.onclick = (e) => { e.stopPropagation(); ui.colors.hidden = !ui.colors.hidden; };
    ui.colors.onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.c === 'off') settings.hl = false;
      else { settings.hl = true; settings.hlColor = b.dataset.c; }
      save(); ui.colors.hidden = true; render();
    };
    // close menus on any outside press (the shadow root is closed, so check from both sides)
    const menus = [ui.menu, ui.colors];
    document.addEventListener('pointerdown', (e) => { if (!e.composedPath().includes(host)) menus.forEach((m) => { m.hidden = true; }); }, true);
    root.addEventListener('pointerdown', (e) => { menus.forEach((m) => { if (!m.parentNode.contains(e.target)) m.hidden = true; }); }, true);

    // scrubbing
    const tAt = (e) => {
      const r = ui.track.getBoundingClientRect();
      return clamp((e.clientX - r.left) / r.width, 0, 1) * (src ? src.duration : 0);
    };
    ui.track.addEventListener('pointermove', (e) => {
      if (!src || !src.canSeek) return;
      const t = tAt(e);
      if (drag) { dragT = t; if (src.kind === 'media') src.seek(t); render(); }
      showTip(t);
    });
    ui.track.addEventListener('pointerdown', (e) => {
      if (!src || !src.canSeek || !src.duration || e.button !== 0) return;
      ui.track.setPointerCapture(e.pointerId);
      drag = true; dragT = tAt(e);
      ui.track.classList.add('drag');
      render();
    });
    const endDrag = () => {
      if (!drag) return;
      drag = null;
      ui.track.classList.remove('drag');
      if (src) src.seek(dragT);
      render();
    };
    ui.track.addEventListener('pointerup', endDrag);
    ui.track.addEventListener('pointercancel', endDrag);
    ui.track.addEventListener('keydown', (e) => {
      if (!src || !src.canSeek) return;
      const k = { ArrowLeft: -5, ArrowRight: 5, ArrowDown: -5, ArrowUp: 5, PageDown: -30, PageUp: 30 }[e.key];
      if (k) skip(k);
      else if (e.key === 'Home') src.seek(0);
      else if (e.key === 'End') src.seek(src.duration);
      else return;
      e.preventDefault();
    });

    // dragging the whole player by its grip
    ui.grip.addEventListener('pointerdown', (e) => {
      const r = ui.wrap.getBoundingClientRect();
      const dx = e.clientX - r.left, dy = e.clientY - r.top;
      ui.grip.setPointerCapture(e.pointerId);
      const move = (ev) => place(ev.clientX - dx, ev.clientY - dy);
      const up = () => {
        ui.grip.removeEventListener('pointermove', move);
        ui.grip.removeEventListener('pointerup', up);
        const b = ui.wrap.getBoundingClientRect();
        settings.pos = { x: b.left, y: b.top };
        save();
      };
      ui.grip.addEventListener('pointermove', move);
      ui.grip.addEventListener('pointerup', up);
    });
    window.addEventListener('resize', () => settings.pos && place(settings.pos.x, settings.pos.y));

    (document.body || document.documentElement).appendChild(ui.host);
    if (settings.pos) place(settings.pos.x, settings.pos.y);
  }

  function place(x, y) {
    const r = ui.wrap.getBoundingClientRect();
    x = clamp(x, 8, Math.max(8, innerWidth - r.width - 8));
    y = clamp(y, 8, Math.max(8, innerHeight - r.height - 8));
    ui.wrap.classList.add('placed');
    ui.wrap.style.left = x + 'px';
    ui.wrap.style.top = y + 'px';
    ui.wrap.classList.toggle('low', y > innerHeight / 2);
  }

  function showTip(t) {
    const d = src.duration;
    ui.tip.textContent = d ? fmt(t) : 'Loading full audio…';
    ui.tip.style.left = (d ? (t / d) * 100 : 50) + '%';
  }

  /* --- docking next to Grok's own read-aloud pill [⏸ Voice 1x ×] --- */

  const isGrok = /(^|\.)grok\.com$/.test(location.hostname) || location.hostname === 'localhost'; // localhost = test/grok.html
  let dockedTo = null, everDocked = false, srcSince = 0;

  const RATE_TEXT = /^\s*\d(\.\d+)?\s*[x×]\s*$/i;
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };

  // Grok's pill = a small rounded container holding [play] [voice ▾] [1x] [✕].
  // Anchor on the speed button (by aria-label, or by its "1x" text since labels are translated),
  // then walk up to the nearest rounded ancestor with 3–6 buttons. Never anchor on "Stop":
  // the composer's stop-generating button uses that label too.
  function findGrokPill() {
    const seeds = new Set(document.querySelectorAll('button[aria-label="Playback rate"]'));
    for (const b of document.querySelectorAll('button')) if (RATE_TEXT.test(b.textContent)) seeds.add(b);
    for (const b of seeds) {
      if (!visible(b)) continue;
      for (let el = b.parentElement, i = 0; el && el !== document.body && i < 6; el = el.parentElement, i++) {
        const n = el.querySelectorAll('button').length;
        if (n > 6) break;
        if (n >= 3 && parseFloat(getComputedStyle(el).borderTopLeftRadius) >= 12 && visible(el)) return el;
      }
    }
    return null;
  }

  // Console helper if docking ever misbehaves: run __grokPlayerDebug() on grok.com
  window.__grokPlayerDebug = (words) => {
    if (words && follow && follow.A) return follow.tl.toks.map((t, k) => [t.text, +lerp(follow.A, follow.tl.start[k], 0, 1).toFixed(2)]);
    const pill = findGrokPill();
    return {
      source: src && { state: src.state, kind: src.kind, src: src.el && (src.el.currentSrc || src.el.src), duration: src.duration, time: src.time, playing: src.playing },
      pill: pill && pill.outerHTML.slice(0, 600),
      rateButtons: [...document.querySelectorAll('button')].filter((b) => RATE_TEXT.test(b.textContent)).map((b) => b.outerHTML.slice(0, 200)),
      docked: !!(ui && ui.wrap.classList.contains('docked')), hostParent: ui && ui.host.parentElement && ui.host.parentElement.outerHTML.slice(0, 300),
      hidden: ui && ui.wrap.hidden,
      highlight: follow && { id: follow.id, words: follow.tl && follow.tl.toks.length, anchors: follow.A && follow.A.length,
        synced: !!(src && src.analysis), word: follow.tl && follow.k >= 0 ? follow.tl.toks[follow.k].text : null },
    };
  };

  // Grok's pill gets nudged right (CSS translate only, layout untouched) so bar + pill sit
  // centered together where the pill alone used to be.
  let shifted = null;
  function shiftPill(pill, dx) {
    if (shifted && shifted !== pill) shifted.style.translate = '';
    shifted = dx ? pill : null;
    const v = dx ? Math.round(dx) + 'px 0' : '';
    if (pill && pill.style.translate !== v) pill.style.translate = v;
  }

  // The bar never goes inside Grok's DOM (React re-renders and clipped wrappers can hide it).
  // It stays in <body>, fixed-positioned, and is lined up beside Grok's pill on every tick.
  function dock() {
    if (!isGrok) return false;
    const pill = findGrokPill();
    if (!pill) { dockedTo = null; shiftPill(null, 0); return false; }
    dockedTo = pill;
    everDocked = true;
    if (ui.host.parentElement !== document.body) document.body.appendChild(ui.host);
    ui.wrap.classList.add('docked');
    matchTheme(pill);
    // Where the pill sits without our nudge (offsets ignore transforms, even mid-transition)
    const op = pill.offsetParent, opr = op && op.getBoundingClientRect();
    const left = op ? opr.left + op.clientLeft + pill.offsetLeft : pill.offsetLeft;
    const pw = pill.offsetWidth, top = pill.getBoundingClientRect().top;
    // Stay inside the chat column, not just the window
    let L = 16, R = innerWidth - 16;
    for (let el = pill.parentElement, i = 0; el && el !== document.body && i < 8; el = el.parentElement, i++) {
      if (el.offsetWidth >= pw + 300) { const c = el.getBoundingClientRect(); L = Math.max(L, c.left); R = Math.min(R, c.right); break; }
    }
    const h = pill.offsetHeight, gap = 8;
    let w = Math.min(460, R - L - pw - gap), x, y;
    if (w >= 220) {                                     // side by side, centered as a pair
      const total = w + gap + pw;
      x = clamp(left + pw / 2 - total / 2, L, R - total);
      y = top;
      shiftPill(pill, x + w + gap - left);
    } else {                                            // too narrow: sit just above the pill
      shiftPill(pill, 0);
      w = Math.min(460, innerWidth - 32); x = clamp(left + pw - w, 16, innerWidth - w - 16); y = top - h - gap;
    }
    const st = ui.wrap.style;
    st.left = x + 'px'; st.top = y + 'px';
    st.setProperty('--w', w + 'px');
    st.setProperty('--h', h + 'px');
    return true;
  }

  // Borrow Grok's pill colors so the bar matches light and dark themes (re-read each tick: theme can flip)
  function matchTheme(pill) {
    const cs = getComputedStyle(pill);
    const key = cs.color + cs.backgroundColor + cs.borderTopColor + pill.offsetHeight;
    if (key === ui.theme) return;
    ui.theme = key;
    const set = (k, v) => ui.wrap.style.setProperty(k, v);
    const bg = cs.backgroundColor;
    set('--fg', cs.color);
    if (bg && !/^transparent$|rgba\(.*,\s*0\)$/.test(bg)) { set('--bg', bg); set('--solid', bg); }
    set('--bd', cs.borderTopColor);
    set('--sh', cs.boxShadow);
    set('--h', pill.offsetHeight + 'px');
  }

  function undock() {
    shiftPill(null, 0);
    if (!ui.wrap.classList.contains('docked')) return;
    ui.wrap.classList.remove('docked');
    ui.wrap.removeAttribute('style');
    ui.theme = '';
    if (settings.pos) place(settings.pos.x, settings.pos.y);
  }

  /* --- word highlighting: follow along in the message being read --- */

  // Grok's audio has no word timings, so we build them. Each word is weighted by its syllables;
  // the audio is split at its silences; then one global best-fit (dynamic programming) matches
  // the text's sentence/clause breaks to those silences. Painted with the CSS Highlight API,
  // so Grok's DOM is never touched.
  const hlOK = !!(window.CSS && window.CSS.highlights && window.Highlight);
  const PAUSE_W = [0, 0.8, 1.6, 2.4]; // syllable-equivalents a break adds: none, clause, sentence, block
  const SYL_RATE = 4.4;               // syllables/second guess for the first second or two
  const SKIP_TEXT = 'pre, button, svg, style, script, textarea, .katex-mathml, [aria-hidden="true"], .sr-only';
  const BLOCK_TAG = /^(P|LI|H[1-6]|BLOCKQUOTE|TD|TH|DT|DD|DIV|TABLE|UL|OL)$/;

  function toWav(buf) {
    const ch = buf.getChannelData(0), n = ch.length, sr = buf.sampleRate;
    const v = new DataView(new ArrayBuffer(44 + n * 2));
    const str = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);   // PCM, mono
    v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, clamp(ch[i], -1, 1) * 0x7fff, true);
    return new Blob([v], { type: 'audio/wav' });
  }

  async function decodePcm(blob) {
    try { return await new OfflineAudioContext(1, 1, 24000).decodeAudioData(await (await fixWav(blob)).arrayBuffer()); }
    catch { return null; }
  }

  // Speech start/end and every silence ≥110ms, from 10ms loudness frames
  function findPauses(ab, partial) {
    const ch = ab.getChannelData(0), hop = Math.round(ab.sampleRate * 0.01); // 10ms frames
    const n = Math.floor(ch.length / hop), env = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = i * hop, e = j + hop; j < e; j++) s += ch[j] * ch[j];
      env[i] = Math.sqrt(s / hop);
    }
    const sorted = Float32Array.from(env).sort();
    const thr = Math.max(sorted[Math.floor(n * 0.1)] * 3, sorted[Math.floor(n * 0.9)] * 0.06, 1e-4);
    const pauses = [];
    let first = -1, last = -1, quiet = -1;
    for (let i = 0; i < n; i++) {
      if (env[i] > thr) {
        if (first < 0) first = i;
        else if (quiet >= 0 && i - quiet >= 11) pauses.push({ s: quiet / 100, e: i / 100 });
        quiet = -1; last = i;
      } else if (quiet < 0) quiet = i;
    }
    return { start: Math.max(0, first) / 100, end: (last + 1) / 100, pauses, partial };
  }

  // Rough spoken syllables in a token (English-centric; digits are read out as words)
  function syllables(tok) {
    if (/^[A-Z]{2,5}s?$/.test(tok.replace(/[^\p{L}]/gu, ''))) return tok.replace(/[^A-Z]/g, '').length; // "AI", "USA"
    const w = tok.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    let n = 0;
    for (const part of w.match(/[a-z]+/g) || []) {
      let v = (part.match(/[aeiouy]+/g) || []).length || 1;
      if (v > 1 && /[^aeiouy]e$/.test(part) && !/[^aeiouy]le$/.test(part)) v--;
      n += v;
    }
    n += (w.match(/\p{N}/gu) || []).length * 1.5;
    n += (w.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) || []).length;
    n += (w.match(/[^\p{Script=Latin}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\P{L}]/gu) || []).length * 0.4;
    n += (w.match(/[%&+=@#$€£]/g) || []).length * 1.5;
    return n;
  }

  function buildText(id) {
    const msg = id && document.getElementById('response-' + id);
    if (!msg) return null;
    let roots = [...msg.querySelectorAll('.response-content-markdown')]
      .filter((r) => !r.parentElement.closest('.response-content-markdown') && r.getClientRects().length);
    if (!roots.length) roots = [msg];
    const toks = [];
    let prevBlock = null, glue = false;
    for (const root of roots) {
      const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => (n.parentElement.closest(SKIP_TEXT) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
      });
      for (let node; (node = tw.nextNode());) {
        let block = node.parentElement;
        while (block !== root && !BLOCK_TAG.test(block.tagName)) block = block.parentElement;
        if (block !== prevBlock) { if (toks.length) toks[toks.length - 1].lvl = 3; glue = false; }
        prevBlock = block;
        const text = node.data;
        for (const m of text.matchAll(/\S+/g)) {
          const prev = toks[toks.length - 1];
          if (m.index === 0 && glue && prev) { prev.eNode = node; prev.e = m[0].length; prev.text += m[0]; } // "word" + "," split by markup
          else toks.push({ sNode: node, s: m.index, eNode: node, e: m.index + m[0].length, text: m[0], lvl: 0 });
        }
        glue = /\S$/.test(text);
      }
    }
    if (!toks.length) return null;
    const n = toks.length, start = new Float64Array(n + 1), syl = new Float64Array(n + 1);
    const sent = new Int32Array(n), sentStart = [0];
    let W = 0, S = 0;
    toks.forEach((t, k) => {
      if (/[.!?…]["'”’)\]]*$/.test(t.text)) t.lvl = Math.max(t.lvl, 2);
      else if (/[,;:—–]["'”’)\]]*$/.test(t.text) || /^[—–-]$/.test(t.text)) t.lvl = Math.max(t.lvl, 1);
      start[k] = W; syl[k] = S;
      sent[k] = sentStart.length - 1;
      const v = syllables(t.text);
      S += v; W += v + PAUSE_W[t.lvl];
      if (t.lvl >= 2 && k + 1 < n) sentStart.push(k + 1);
    });
    start[n] = W; syl[n] = S;
    return { toks, start, syl, sent, sentStart, total: W };
  }

  // Returns [weight, seconds] anchors. Nodes on the audio side are its silences (plus speech
  // start/end); nodes on the text side are phrase breaks (after , ; : . ! ? and block ends).
  // A path matches some silences to some breaks in order. Its cost = how far each stretch's
  // speech time is from (syllables / speaking rate), plus penalties for long silences with no
  // break and sentence ends with no silence. Each stretch's cost is capped, so one odd stretch
  // (text that isn't read aloud, a slow name) is written off instead of dragging everything after
  // it off course. The cheapest path over a few candidate speaking rates wins.
  const T_PEN = [0, 0.25, 1.2, 2];
  function align(tl, an) {
    if (!an) return [[0, 0], [tl.total, tl.total / SYL_RATE]];
    const TB = [0];
    for (let k = 1; k < tl.toks.length; k++) if (tl.toks[k - 1].lvl) TB.push(k);
    TB.push(tl.toks.length);
    const J = TB.length, syl = TB.map((k) => tl.syl[k]);
    const tCum = new Float64Array(J);
    for (let j = 1; j < J; j++) tCum[j] = tCum[j - 1] + T_PEN[tl.toks[TB[j] - 1] ? tl.toks[TB[j] - 1].lvl : 0];
    const P = an.pauses.filter((p) => p.s > an.start && p.e < an.end), m = P.length, N = m + 2;
    const sp = new Float64Array(N), aCum = new Float64Array(m + 1); // speech seconds before node; skip penalties
    let gap = 0;
    for (let i = 0; i < m; i++) {
      sp[i + 1] = P[i].s - an.start - gap; gap += P[i].e - P[i].s;
      aCum[i + 1] = aCum[i] + 0.4 + 5 * Math.max(0, P[i].e - P[i].s - 0.15);
    }
    sp[m + 1] = an.end - an.start - gap;
    const r0 = syl[J - 1] / Math.max(1, sp[m + 1]);
    const rates = an.partial ? [3, 3.4, 3.8, 4.2, 4.6, 5, 5.4, 5.8, 6.3, 6.8]
      : [0.84, 0.9, 0.95, 1, 1.05, 1.1, 1.18].map((f) => r0 * f);
    let best = null;
    for (const rate of rates) {
      const D = new Float64Array(N * J).fill(Infinity), B = new Int32Array(N * J).fill(-1);
      D[0] = 0;
      const last = an.partial ? m : m + 1;
      for (let i = 1; i <= last; i++) {
        const isEnd = i === m + 1, expect = sp[i] * rate, band = 40 + 0.4 * expect;
        const longP = !isEnd && P[i - 1].e - P[i - 1].s;
        for (let j = 1; j < J; j++) {
          if ((j === J - 1) !== isEnd) continue;
          if (!isEnd && Math.abs(syl[j] - expect) > band) continue;
          const lvl = tl.toks[TB[j] - 1].lvl;
          const match = lvl === 1 && longP > 0.7 ? 0.4 : 0;
          let bc = Infinity, bb = -1;
          for (let i2 = Math.max(0, i - 8); i2 < i; i2++) {
            const skipA = aCum[i - 1] - aCum[i2], T = sp[i] - sp[i2];
            for (let j2 = Math.max(0, j - 10); j2 < j; j2++) {
              const d = D[i2 * J + j2];
              if (d === Infinity) continue;
              const sy = syl[j] - syl[j2], lr = Math.log((T + 0.15) / (sy / rate + 0.15));
              const c = d + Math.min(lr * lr * 6 * Math.sqrt(sy + 1), 4.5) + skipA + tCum[j - 1] - tCum[j2] + match;
              if (c < bc) { bc = c; bb = i2 * J + j2; }
            }
          }
          D[i * J + j] = bc; B[i * J + j] = bb;
        }
      }
      let end = -1, cost = Infinity;
      if (!an.partial) { end = (m + 1) * J + J - 1; cost = D[end]; }
      else for (let i = 0; i <= m; i++) for (let j = 0; j < J - 1; j++) {
        const c = D[i * J + j] + aCum[m] - aCum[i]; // silences past the last match go unexplained
        if (c < cost) { cost = c; end = i * J + j; }
      }
      if (cost < (best ? best.cost : Infinity)) best = { cost, end, B, rate };
    }
    if (!best) return [[0, an.start], [tl.total, an.partial ? an.start + tl.total / SYL_RATE : an.end]];
    const path = [];
    for (let x = best.end; x > 0; x = best.B[x]) path.push(x);
    path.reverse();
    const A = [[0, an.start]];
    for (const x of path) {
      const i = Math.floor(x / J), j = x % J;
      if (i === m + 1) break;
      const k = TB[j], W = tl.start[k], pw = PAUSE_W[tl.toks[k - 1].lvl];
      if (W - pw > A[A.length - 1][0]) A.push([W - pw, P[i - 1].s]); // previous word ends as the silence starts
      if (W > A[A.length - 1][0]) A.push([W, P[i - 1].e]);           // next phrase starts as it ends
    }
    const [lw, lt] = A[A.length - 1];
    A.push([tl.total, an.partial ? lt + (tl.total - lw) / best.rate : Math.max(an.end, lt + 0.1)]);
    return A;
  }
  const lerp = (A, x, i, j) => {
    let k = 1;
    while (k < A.length - 1 && A[k][i] <= x) k++;
    const [a, b] = [A[k - 1], A[k]];
    return a[j] + (b[j] - a[j]) * clamp((x - a[i]) / ((b[i] - a[i]) || 1), 0, 1);
  };
  const tokenAt = (tl, W) => {
    let lo = 0, hi = tl.toks.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (tl.start[m] <= W) lo = m; else hi = m - 1; }
    return lo;
  };

  let follow = null;    // { id, tl, A, key, k, at }
  let userScrollAt = 0, autoScrollAt = 0;
  const NAV_KEYS = /^(PageUp|PageDown|ArrowUp|ArrowDown|Home|End| )$/;
  window.addEventListener('wheel', () => { userScrollAt = performance.now(); }, { capture: true, passive: true });
  window.addEventListener('touchmove', () => { userScrollAt = performance.now(); }, { capture: true, passive: true });
  window.addEventListener('keydown', (e) => { if (NAV_KEYS.test(e.key)) userScrollAt = performance.now(); }, true);

  function clearHighlight() {
    if (!hlOK || !follow || follow.k < 0) return;
    window.CSS.highlights.delete('grok-ra-word');
    window.CSS.highlights.delete('grok-ra-sentence');
    follow.k = -1;
  }

  function updateHighlight() {
    if (!hlOK || !settings.hl || !src || !src.ttsId || src.ended) return clearHighlight();
    if (!follow || follow.id !== src.ttsId) { clearHighlight(); follow = { id: src.ttsId, tl: null, k: -1, at: 0 }; }
    const f = follow;
    if (!f.tl || !f.tl.toks[0].sNode.isConnected || !f.tl.toks[f.tl.toks.length - 1].eNode.isConnected) {
      if (performance.now() - f.at < 1000) return clearHighlight(); // React swapped the text; retry soon
      f.at = performance.now();
      clearHighlight();
      f.tl = buildText(f.id); f.key = null;
      if (!f.tl) return;
    }
    let st = document.getElementById('grok-ra-hl');
    if (!st) {
      st = document.createElement('style');
      st.id = 'grok-ra-hl';
      (document.head || document.documentElement).appendChild(st);
    }
    const c = HL_COLORS[settings.hlColor] || HL_COLORS.yellow;
    const css = `::highlight(grok-ra-sentence){background-color:rgba(${c},.13)}` +
      `::highlight(grok-ra-word){background-color:rgba(${c},.45);color:inherit}`;
    if (st.textContent !== css) st.textContent = css;
    if (src.settling) return; // mid-seek: keep the last word until the new position is real
    const an = src.analysis;
    if (f.key !== (an || 'none')) { f.key = an || 'none'; f.A = align(f.tl, an); }
    const k = tokenAt(f.tl, lerp(f.A, src.time, 1, 0));
    if (k === f.k) return;
    try {
      const tk = f.tl.toks[k], s = f.tl.sentStart[f.tl.sent[k]];
      const next = f.tl.sentStart[f.tl.sent[k] + 1], e = next == null ? f.tl.toks.length - 1 : next - 1;
      const word = document.createRange(), line = document.createRange();
      word.setStart(tk.sNode, tk.s); word.setEnd(tk.eNode, tk.e);
      line.setStart(f.tl.toks[s].sNode, f.tl.toks[s].s); line.setEnd(f.tl.toks[e].eNode, f.tl.toks[e].e);
      const hw = new Highlight(word); hw.priority = 1;
      window.CSS.highlights.set('grok-ra-word', hw);
      window.CSS.highlights.set('grok-ra-sentence', new Highlight(line));
      f.k = k;
      followScroll(word);
    } catch { f.tl = null; } // text changed under us; rebuild next tick
  }

  // Keep the spoken word on screen, unless the user scrolled in the last few seconds
  function followScroll(range) {
    const now = performance.now();
    if (!src.playing || now - userScrollAt < 4000 || now - autoScrollAt < 700) return;
    const r = range.getBoundingClientRect();
    if (!r.height) return;
    const top = 72, bottom = (dockedTo ? dockedTo.getBoundingClientRect().top : innerHeight) - 24;
    if (r.top >= top && r.bottom <= bottom) return;
    let sc = range.startContainer.parentElement;
    for (; sc && sc !== document.body; sc = sc.parentElement) {
      const o = getComputedStyle(sc).overflowY;
      if ((o === 'auto' || o === 'scroll') && sc.scrollHeight > sc.clientHeight) break;
    }
    if (!sc || sc === document.body) sc = document.scrollingElement;
    autoScrollAt = now;
    sc.scrollBy({ top: r.top - (top + (bottom - top) * 0.3), behavior: 'smooth' });
  }

  // Alt+click any word in the message being read to jump the audio there
  document.addEventListener('click', (e) => {
    if (!e.altKey || !follow || !follow.tl || !follow.A || !src || !src.canSeek || src.ttsId !== follow.id) return;
    let node, off;
    if (document.caretPositionFromPoint) { const p = document.caretPositionFromPoint(e.clientX, e.clientY); node = p && p.offsetNode; off = p && p.offset; }
    else { const p = document.caretRangeFromPoint(e.clientX, e.clientY); node = p && p.startContainer; off = p && p.startOffset; }
    const toks = follow.tl.toks;
    let k = toks.findIndex((t) => (t.sNode === node && off >= t.s && (t.eNode !== node || off <= t.e)) || (t.eNode === node && t.sNode !== node && off <= t.e));
    if (k < 0) k = toks.findIndex((t) => t.sNode === node && t.s >= off);
    if (k < 0) return;
    e.preventDefault();
    e.stopPropagation();
    src.seek(lerp(follow.A, follow.tl.start[k], 0, 1));
  }, true);

  // Grok's pill mounts a moment after audio starts and may be re-rendered; keep checking.
  setInterval(() => { if (src && ui && !hidden) render(); }, 400);

  function render() {
    if (!ui || !src) return;
    let show = !hidden;
    if (dock()) {
      show = true; // docked: Grok's pill owns stop/close
    } else {
      undock();
      if (isGrok && src.kind === 'media') {
        // Grok's pill is gone = Grok stopped the read aloud; brief grace period while it mounts
        if (everDocked || performance.now() - srcSince < 1500) show = false;
      }
      // keep the floating player attached if the SPA re-renders <body>
      if (!ui.host.isConnected) (document.body || document.documentElement).appendChild(ui.host);
    }
    ui.wrap.hidden = !show;
    ui.wrap.classList.toggle('collapsed', !!settings.collapsed);
    if (!show) return clearHighlight();
    updateHighlight();

    const d = src.duration;
    const t = drag ? dragT : Math.min(src.time, d || Infinity);
    const p = d ? clamp(t / d, 0, 1) : 0;
    const pct = p * 100 + '%';

    const state = src.playing ? 'pause' : src.ended && src.canSeek ? 'replay' : 'play';
    if (state !== ui.state) {
      ui.state = state;
      ui.play.innerHTML = ICON[state];
      ui.pillIco.innerHTML = ICON[state];
      ui.play.setAttribute('aria-label', state === 'pause' ? 'Pause' : 'Play');
    }
    ui.fill.style.width = pct;
    ui.thumb.style.left = pct;
    ui.buf.style.width = (d ? clamp(src.buffered / d, 0, 1) * 100 : 0) + '%';
    ui.arc.style.strokeDashoffset = String(106.8 * (1 - p));
    ui.cur.textContent = fmt(t);
    ui.dur.textContent = d ? fmt(d) + (src.streaming ? '+' : '') : '–:––';
    ui.dur.title = src.preparing ? 'Loading the full audio so you can seek' : src.streaming ? 'Still streaming — length will grow' : '';
    ui.track.classList.toggle('prep', !!src.preparing);
    ui.track.classList.toggle('off', !src.canSeek);
    ui.track.setAttribute('aria-valuemax', String(Math.round(d)));
    ui.track.setAttribute('aria-valuenow', String(Math.round(t)));
    ui.track.setAttribute('aria-valuetext', `${fmt(t)} of ${fmt(d)}`);
    if (drag) showTip(t);
    ui.back.disabled = ui.fwd.disabled = !src.canSeek;
    ui.speed.disabled = !src.canRate;
    ui.speed.title = src.canRate ? 'Playback speed (Alt+[ / Alt+])' : 'Speed is fixed for this audio type';
    ui.speed.textContent = settings.rate + '×';
    for (const b of ui.menu.children) b.classList.toggle('on', +b.dataset.r === settings.rate);
    ui.hlw.hidden = !(hlOK && src.ttsId);
    ui.hlbtn.classList.toggle('off', !settings.hl);
    ui.hlbtn.style.setProperty('--c', HL_COLORS[settings.hlColor] || HL_COLORS.yellow);
    for (const b of ui.colors.children) b.classList.toggle('on', settings.hl ? b.dataset.c === settings.hlColor : b.dataset.c === 'off');

    if (src.playing && !raf) raf = requestAnimationFrame(() => { raf = 0; render(); });
  }

  // Hardware / OS media keys
  try {
    const ms = navigator.mediaSession;
    ms.setActionHandler('seekbackward', () => skip(-SKIP));
    ms.setActionHandler('seekforward', () => skip(SKIP));
  } catch {}
})();
