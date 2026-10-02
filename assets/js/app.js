/* ==========================================================================
   app.js — UI layer
   ========================================================================== */
(function (global) {
  'use strict';

  var doc = document;
  var $ = function (sel, root) { return (root || doc).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || doc).querySelectorAll(sel)); };

  var TRACKS = ['vocals', 'backing', 'master'];
  var PREFS_KEY = 'resonance.prefs.v3';
  var DUR_KEY = 'resonance.durations.v1';
  var DEFAULT_VOLUME = { vocals: 1, backing: 0.7, master: 0.85 };

  var engine = new global.AudioEngine();

  var prefs = {
    mix: {},        // songId -> { v: {track: 0..1}, m: {track: bool} }
    theme: 'dark',
    repeat: 'off',
    shuffle: false,
    autoScroll: true,
    lyricOffsets: {}
  };

  var durations = {};

  var state = {
    songs: [],
    view: [],
    index: -1,
    song: null,
    lyrics: { lines: [], meta: {}, active: -1, synced: false },
    nodes: [],
    scrub: null,
    dragging: false,
    lastPct: -1,
    loadToken: 0,
    lyricToken: 0,
    audioError: false
  };

  /* ======================================================================
     DOM
     ====================================================================== */

  var dom = {};

  function cacheDom() {
    var ids = ['app', 'search', 'songlist', 'library-empty', 'library-count',
      'art', 'art-img', 'art-glow', 'art-fallback', 'art-veil', 'art-veil-text', 'stage-bg',
      'now-title', 'now-sub', 'progress-track', 'progress-fill', 'progress-buffer', 'progress-knob',
      'time-now', 'time-total', 'btn-play', 'btn-prev', 'btn-next',
      'btn-mix-reset', 'btn-shuffle', 'btn-repeat', 'repeat-badge', 'btn-theme', 'btn-help',
      'lyrics-scroll', 'lyrics-inner', 'lyrics-hint', 'lyrics-source', 'lyrics-pane',
      'off-val', 'off-minus', 'off-plus', 'off-reset', 'auto-scroll', 'btn-expand',
      'toast-host', 'help-overlay', 'btn-help-close'];

    ids.forEach(function (id) { dom[id] = doc.getElementById(id); });

    dom.artGlow = $('.art__glow');
    dom.helpBtn = dom['btn-help'];
  }

  /* ======================================================================
     Storage
     ====================================================================== */

  function readJSON(key, fallback) {
    try {
      var raw = global.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }

  function writeJSON(key, value) {
    try { global.localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode */ }
  }

  function loadPrefs() {
    var saved = readJSON(PREFS_KEY, null);
    if (!saved) return;
    if (saved.mix && typeof saved.mix === 'object') prefs.mix = saved.mix;
    if (saved.theme === 'light' || saved.theme === 'dark') prefs.theme = saved.theme;
    if (saved.repeat) prefs.repeat = saved.repeat;
    prefs.shuffle = !!saved.shuffle;
    prefs.autoScroll = saved.autoScroll !== false;
    prefs.lyricOffsets = saved.lyricOffsets && typeof saved.lyricOffsets === 'object' ? saved.lyricOffsets : {};
  }

  var savePrefsTimer = null;
  function savePrefs() {
    clearTimeout(savePrefsTimer);
    savePrefsTimer = setTimeout(function () { writeJSON(PREFS_KEY, prefs); }, 250);
  }

  /* ======================================================================
     Helpers
     ====================================================================== */

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  function formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '0:00';
    var total = Math.floor(seconds);
    var m = Math.floor(total / 60);
    var s = total % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function formatOffset(ms) {
    if (!ms) return '0 ms';
    return (ms > 0 ? '+' : '') + ms + ' ms';
  }

  function slugify(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  /**
   * Turns one library entry into a fully-resolved song. Paths are derived from
   * `dir` so a song only needs a folder, but any path can still be overridden
   * explicitly (cover, vocals, backing, lyrics).
   */
  function normalise(raw, i) {
    var dir = raw.dir || slugify(raw.title || raw.name) || ('song-' + (i + 1));
    var base = 'songs/' + dir + '/';

    return {
      id: dir,
      dir: dir,
      title: raw.title || raw.name || 'Untitled',
      artist: raw.artist || 'Unknown artist',
      album: raw.album || '',
      cover: raw.cover || base + 'cover.jpg',
      vocals: raw.vocals || raw.vocal || base + 'vocals.mp3',
      backing: raw.backing || raw.instrumental || base + 'backing.mp3',
      lyrics: raw.lyrics || raw.lrc || base + 'lyrics.lrc',
      mix: raw.mix || null
    };
  }

  function escapeHTML(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  var NOTE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l10-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="16" cy="16" r="3"></circle></svg>';

  function toast(message) {
    var host = dom['toast-host'];
    if (!host) return;
    var el = doc.createElement('div');
    el.className = 'toast';
    el.textContent = message;
    host.appendChild(el);
    setTimeout(function () {
      el.classList.add('is-out');
      setTimeout(function () { el.remove(); }, 260);
    }, 2000);
  }

  /* ======================================================================
     Library
     ====================================================================== */

  function loadLibrary() {
    var manifest = global.LIBRARY || [];
    var list = Array.isArray(manifest) ? manifest : (manifest.songs || []);
    state.songs = list.map(normalise).filter(function (song) {
      return song.vocals || song.backing;
    });

    dom['library-count'].textContent = state.songs.length;
    dom['library-empty'].hidden = state.songs.length > 0;

    if (!state.songs.length) {
      renderEmptyPlayer();
      return;
    }

    renderPlaylist();
    var lastId = readJSON('resonance.last', null);
    var target = lastId ? state.songs.findIndex(function (s) { return s.id === lastId; }) : 0;
    selectSong(target < 0 ? 0 : target, false);
  }

  function renderPlaylist() {
    var query = (dom.search.value || '').trim().toLowerCase();
    state.view = query ? state.songs.filter(function (song) {
      return (song.title + ' ' + song.artist + ' ' + song.album).toLowerCase().indexOf(query) > -1;
    }) : state.songs.slice();

    if (!state.view.length) {
      dom.songlist.innerHTML = '<li class="empty"><p>No matches for &ldquo;' + escapeHTML(query) + '&rdquo;</p></li>';
      return;
    }

    dom.songlist.innerHTML = state.view.map(function (song) {
      var active = state.song && song.id === state.song.id;
      var dur = durations[song.id];
      return '<li>' +
        '<button class="song' + (active ? ' is-active' : '') + '" data-id="' + escapeHTML(song.id) + '" role="option" aria-selected="' + (active ? 'true' : 'false') + '">' +
          '<span class="song__art">' +
            (song.cover ? '<img src="' + escapeHTML(song.cover) + '" alt="" loading="lazy" decoding="async" onerror="this.remove()">' : NOTE_ICON) +
            '<span class="song__bars"><i></i><i></i><i></i></span>' +
          '</span>' +
          '<span class="song__text">' +
            '<span class="song__title">' + escapeHTML(song.title) + '</span>' +
            '<span class="song__artist">' + escapeHTML(song.artist) + (song.album ? ' &middot; ' + escapeHTML(song.album) : '') + '</span>' +
          '</span>' +
          '<span class="song__dur" data-dur-for="' + escapeHTML(song.id) + '">' + (dur ? formatTime(dur) : '&middot;&middot;:&middot;&middot;') + '</span>' +
        '</button></li>';
    }).join('');

    probeVisibleDurations();
  }

  function probeVisibleDurations() {
    $$('[data-dur-for]', dom.songlist).forEach(function (el) {
      var id = el.getAttribute('data-dur-for');
      if (durations[id]) { el.textContent = formatTime(durations[id]); return; }
      var song = state.songs.find(function (s) { return s.id === id; });
      if (song) probeDuration(song, el);
    });
  }

  function probeDuration(song, el) {
    var src = song.backing || song.vocals;
    if (!src) return;
    var audio = new global.Audio();
    audio.preload = 'metadata';
    audio.onloadedmetadata = function () {
      if (isFinite(audio.duration) && audio.duration > 0) {
        durations[song.id] = audio.duration;
        writeJSON(DUR_KEY, durations);
        if (el && el.isConnected) el.textContent = formatTime(audio.duration);
        if (state.song && state.song.id === song.id) dom['time-total'].textContent = formatTime(audio.duration);
      }
      // No src reset here: clearing it aborts the request and makes the
      // browser log a spurious network error. The element is collectable now.
    };
    audio.src = src;
  }

  function updatePlaylistState() {
    $$('.song', dom.songlist).forEach(function (el) {
      var isActive = state.song && el.getAttribute('data-id') === state.song.id;
      el.classList.toggle('is-active', !!isActive);
      el.classList.toggle('is-playing', !!isActive && engine.isPlaying());
      el.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
  }

  /* ======================================================================
     Artwork + palette
     ====================================================================== */

  function setArtwork(song) {
    var art = dom.art;
    art.classList.remove('has-art');
    dom['art-img'].removeAttribute('src');
    art.style.removeProperty('--glow');
    dom['stage-bg'].classList.remove('is-on');
    dom['stage-bg'].style.backgroundImage = '';

    if (!song || !song.cover) return;

    var img = dom['art-img'];
    var onLoad = function () {
      if (state.song && state.song.id === song.id) {
        art.classList.add('has-art');
        dom['stage-bg'].classList.add('is-on');
        dom['stage-bg'].style.backgroundImage = 'url("' + song.cover.replace(/"/g, '%22') + '")';
        applyPalette(img);
      }
    };
    img.onload = onLoad;
    img.onerror = function () { art.classList.remove('has-art'); };
    img.src = song.cover;
    if (img.complete && img.naturalWidth) onLoad();
  }

  function applyPalette(img) {
    var canvas = doc.createElement('canvas');
    canvas.width = 20; canvas.height = 20;
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    try {
      ctx.drawImage(img, 0, 0, 20, 20);
      var data = ctx.getImageData(0, 0, 20, 20).data;
    } catch (e) { return; }

    var r = 0, g = 0, b = 0, n = 0;
    for (var i = 0; i < data.length; i += 4) {
      var weight = (data[i + 3] / 255);
      r += data[i] * weight; g += data[i + 1] * weight; b += data[i + 2] * weight;
      n += weight;
    }
    if (!n) return;
    r /= n; g /= n; b /= n;

    // Push saturation up so the glow reads as a colour, not grey.
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var luma = (r * 0.299 + g * 0.587 + b * 0.114);
    var boost = 1.45;
    var nr = clamp01((luma + (r - luma) * boost) / 255) * 255;
    var ng = clamp01((luma + (g - luma) * boost) / 255) * 255;
    var nb = clamp01((luma + (b - luma) * boost) / 255) * 255;
    if (max - min < 18) { nr = ng = nb = clamp01(luma / 255) * 255; }

    var color = 'rgb(' + Math.round(nr) + ',' + Math.round(ng) + ',' + Math.round(nb) + ')';
    dom.art.style.setProperty('--glow', color);
    dom['stage-bg'].style.setProperty('--tint', 'rgba(' + Math.round(nr) + ',' + Math.round(ng) + ',' + Math.round(nb) + ',.34)');
  }

  /* ======================================================================
     Now playing
     ====================================================================== */

  function renderEmptyPlayer() {
    dom['now-title'].textContent = 'Library is empty';
    dom['now-sub'].textContent = 'Add songs to songs/ and list them in data/library.js';
    dom['btn-play'].disabled = true;
  }

  function renderNowPlaying() {
    var song = state.song;
    if (!song) { renderEmptyPlayer(); return; }

    dom['now-title'].textContent = song.title;
    dom['now-sub'].innerHTML = escapeHTML(song.artist) + (song.album ? ' &middot; <b>' + escapeHTML(song.album) + '</b>' : '');
    dom['btn-play'].disabled = !state.song || !!state.audioError;
    doc.title = song.title + ' \u2014 ' + song.artist + ' \u00b7 Resonance';
    updateMediaSession(song);
  }

  function updateMediaSession(song) {
    if (!navigator.mediaSession) return;
    try {
      navigator.mediaSession.metadata = new global.MediaMetadata({
        title: song.title,
        artist: song.artist,
        album: song.album,
        artwork: song.cover ? [{ src: song.cover, sizes: '512x512', type: guessType(song.cover) }] : []
      });
      navigator.mediaSession.setActionHandler('play', function () { togglePlay(); });
      navigator.mediaSession.setActionHandler('pause', function () { togglePlay(); });
      navigator.mediaSession.setActionHandler('previoustrack', function () { playIndex(state.index - 1); });
      navigator.mediaSession.setActionHandler('nexttrack', function () { playIndex(state.index + 1); });
    } catch (e) { /* unsupported action */ }
  }

  function guessType(src) {
    var ext = src.split('.').pop().toLowerCase();
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    if (ext === 'webp') return 'image/webp';
    if (ext === 'png') return 'image/png';
    return 'image/jpeg';
  }

  /* ======================================================================
     Song loading / playback
     ====================================================================== */

  function setLoading(on, text) {
    dom.app.classList.toggle('is-loading', !!on);
    dom['art-veil'].hidden = !on;
    if (text) dom['art-veil-text'].textContent = text;
  }

  function selectSong(index, autoplay) {
    if (index < 0 || index >= state.songs.length) return;

    state.index = index;
    state.song = state.songs[index];
    writeJSON('resonance.last', state.song.id);

    applyMixForSong(state.song, 0);
    setArtwork(state.song);
    renderNowPlaying();
    updatePlaylistState();
    loadLyrics(state.song);
    updateOffsetLabel();

    var known = durations[state.song.id];
    dom['time-now'].textContent = '0:00';
    dom['time-total'].textContent = known ? formatTime(known) : '0:00';

    setLoading(true, 'Loading audio\u2026');

    var song = state.song;
    var request = ++state.loadToken;

    engine.load({ vocals: song.vocals, backing: song.backing })
      .then(function (result) {
        if (!result || request !== state.loadToken) return;
        setLoading(false);
        state.audioError = null;
        durations[song.id] = engine.duration();
        writeJSON(DUR_KEY, durations);
        dom['time-total'].textContent = formatTime(engine.duration());
        var cell = $('[data-dur-for="' + state.song.id + '"]', dom.songlist);
        if (cell) cell.textContent = formatTime(engine.duration());
        renderNowPlaying();

        if (result.missing && result.missing.length) {
          var label = result.missing.length > 1 ? 'Audio tracks' : result.missing[0] === 'vocals' ? 'Vocal track' : 'Backing track';
          toast(label + ' failed to load \u2014 check the path in data/library.js');
        }

        if (autoplay) return engine.play();
      })
      .catch(function (err) {
        if (request !== state.loadToken) return;
        setLoading(false);
        state.audioError = true;
        console.error('[app] load failed:', err);
        renderEmptyPlayerForError(err);
      });
  }

  function renderEmptyPlayerForError(err) {
    dom['now-title'].textContent = 'Playback error';
    dom['now-sub'].textContent = (err && err.message) || 'Unknown error';
  }

  function playIndex(index) {
    if (!state.songs.length) return;
    if (state.song && state.song.id === state.songs[((index % state.songs.length) + state.songs.length) % state.songs.length].id) {
      engine.play();
      return;
    }
    var wrapped = ((index % state.songs.length) + state.songs.length) % state.songs.length;
    selectSong(wrapped, true);
  }

  function nextIndex(step) {
    var count = state.songs.length;
    if (!count) return;
    if (prefs.shuffle) {
      if (count === 1) return state.index;
      var pick = state.index;
      while (pick === state.index) pick = Math.floor(Math.random() * count);
      return pick;
    }
    var target = state.index + step;
    if (target >= count) return prefs.repeat === 'all' ? 0 : count - 1;
    if (target < 0) return count - 1;
    return target;
  }

  function onTrackEnded() {
    if (prefs.repeat === 'one') { engine.seek(0); engine.play(); return; }
    var target = nextIndex(1);
    if (target === state.index && !prefs.repeat) { engine.pause(); engine.seek(0); return; }
    playIndex(target);
  }

  function togglePlay() {
    if (!state.song) {
      if (state.songs.length) selectSong(0, true);
      return;
    }
    if (!engine.isReady()) {
      if (engine.isLoading()) toast('Still loading\u2026');
      return;
    }
    engine.toggle().then(function () { syncTransport(); });
  }

  function syncTransport() {
    var playing = engine.isPlaying();
    dom.app.classList.toggle('is-playing', playing);
    updatePlaylistState();
    dom['btn-play'].setAttribute('aria-label', playing ? 'Pause' : 'Play');
    if (navigator.mediaSession) {
      navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    }
  }

  /* ======================================================================
     Progress + scrubbing
     ====================================================================== */

  function setProgress(pct) {
    if (pct === state.lastPct) return;
    state.lastPct = pct;
    var text = pct.toFixed(3) + '%';
    dom['progress-fill'].style.width = text;
    dom['progress-knob'].style.left = text;
    dom['progress-track'].setAttribute('aria-valuenow', Math.round(pct));
  }

  function ratioFromEvent(event) {
    var rect = dom['progress-track'].getBoundingClientRect();
    if (!rect.width) return 0;
    return clamp01((event.clientX - rect.left) / rect.width);
  }

  function bindProgress() {
    var track = dom['progress-track'];

    track.addEventListener('pointerdown', function (event) {
      if (!engine.isReady()) return;
      event.preventDefault();
      state.dragging = true;
      track.classList.add('is-scrubbing');
      track.setPointerCapture(event.pointerId);
      state.scrub = ratioFromEvent(event) * engine.duration();
    });

    track.addEventListener('pointermove', function (event) {
      if (!state.dragging) return;
      state.scrub = ratioFromEvent(event) * engine.duration();
    });

    function release(event) {
      if (!state.dragging) return;
      state.dragging = false;
      track.classList.remove('is-scrubbing');
      try { track.releasePointerCapture(event.pointerId); } catch (e) { /* noop */ }
      if (state.scrub != null) engine.seek(state.scrub);
      state.scrub = null;
    }

    track.addEventListener('pointerup', release);
    track.addEventListener('pointercancel', release);

    track.addEventListener('keydown', function (event) {
      if (!engine.isReady()) return;
      var step = event.shiftKey ? 30 : 5;
      if (event.key === 'ArrowRight') { engine.seek(engine.position() + step); event.preventDefault(); }
      else if (event.key === 'ArrowLeft') { engine.seek(engine.position() - step); event.preventDefault(); }
      else if (event.key === 'Home') { engine.seek(0); event.preventDefault(); }
      else if (event.key === 'End') { engine.seek(engine.duration()); event.preventDefault(); }
    });
  }

  /* ======================================================================
     Mixer
     ====================================================================== */

  /* ----------------------------------------------------------------------
   Per-song mixer state
   Each song keeps its own levels, so switching tracks and coming back
   restores the mix you had. Untouched songs fall back to the `mix` block
   in data/library.js, which is tuned per song by stem loudness.
   ---------------------------------------------------------------------- */

  function defaultsFor(song) {
    var v = {}, m = {};
    TRACKS.forEach(function (track) {
      v[track] = (song && song.mix && typeof song.mix[track] === 'number')
        ? clamp01(song.mix[track])
        : DEFAULT_VOLUME[track];
      m[track] = false;
    });
    return { v: v, m: m };
  }

  function mixFor(song) {
    if (!song) return null;
    var base = defaultsFor(song);
    var entry = prefs.mix[song.id];
    if (!entry || typeof entry !== 'object') { entry = prefs.mix[song.id] = base; }
    if (!entry.v || typeof entry.v !== 'object') entry.v = base.v;
    if (!entry.m || typeof entry.m !== 'object') entry.m = base.m;
    TRACKS.forEach(function (track) {
      if (typeof entry.v[track] !== 'number') entry.v[track] = base.v[track];
      if (typeof entry.m[track] !== 'boolean') entry.m[track] = false;
    });
    return entry;
  }

  function applyMixForSong(song, ramp) {
    var entry = mixFor(song);
    if (!entry) return;
    TRACKS.forEach(function (track) {
      engine.setVolume(track, entry.v[track], ramp);
      engine.setMuted(track, entry.m[track], ramp);
    });
    paintAllMixer();
  }

  function commitMix(track) {
    var entry = mixFor(state.song);
    if (!entry) return;
    entry.v[track] = engine.volume[track];
    entry.m[track] = engine.muted[track];
    savePrefs();
    paintMixer(track);
  }

  function buildMixer() {
    TRACKS.forEach(function (track) {
      var input = doc.getElementById('vol-' + track);

      input.addEventListener('input', function () {
        var value = parseInt(input.value, 10) / 100;
        engine.setVolume(track, value, 0);
        engine.setMuted(track, false, 0);
        commitMix(track);
      });

      var toggle = $('[data-mute="' + track + '"]');
      toggle.addEventListener('click', function () {
        engine.toggleMuted(track);
        commitMix(track);
      });
    });
  }

  function paintMixer(track) {
    var strip = $('.strip[data-track="' + track + '"]');
    var input = doc.getElementById('vol-' + track);
    var toggle = $('[data-mute="' + track + '"]');
    var label = $('[data-state-for="' + track + '"]');
    var muted = engine.muted[track];
    var value = engine.volume[track];

    input.value = Math.round(value * 100);
    input.style.setProperty('--pct', (muted ? 0 : value * 100) + '%');
    toggle.setAttribute('aria-pressed', muted ? 'true' : 'false');
    strip.classList.toggle('is-muted', muted);
    label.textContent = muted ? 'MUTE' : Math.round(value * 100);
  }

  function paintAllMixer() {
    if (!dom['vol-vocals']) return;
    TRACKS.forEach(paintMixer);
  }

  function bindMixReset() {
    dom['btn-mix-reset'].addEventListener('click', function () {
      if (!state.song) return;
      delete prefs.mix[state.song.id];
      applyMixForSong(state.song, 0.08);
      savePrefs();
      toast('Mix reset to song defaults');
    });
  }

  /* ======================================================================
     Lyrics
     ====================================================================== */

  function loadLyrics(song) {
    state.lyrics = { lines: [], meta: {}, active: -1, synced: false };
    state.nodes = [];
    state.lyricToken = (state.lyricToken || 0) + 1;
    var token = state.lyricToken;

    dom['lyrics-inner'].innerHTML = '<p class="lyrics__hint muted">Loading lyrics&hellip;</p>';
    dom['lyrics-source'].textContent = '';

    if (!song.lyrics) { renderNoLyrics('This song has no lyric file.'); return; }

    fetch(song.lyrics)
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      })
      .then(function (text) {
        if (token !== state.lyricToken) return;
        var parsed = global.LRC.parse(text);
        state.lyrics = { lines: parsed.lines, meta: parsed.meta, active: -1, synced: parsed.hasTiming };
        renderLyrics(song);
      })
      .catch(function (err) {
        if (token !== state.lyricToken) return;
        console.warn('[app] lyrics unavailable:', err);
        renderNoLyrics('Could not read ' + song.lyrics);
      });
  }

  function renderNoLyrics(message) {
    dom['lyrics-inner'].innerHTML = '<p class="lyrics__hint muted">' + escapeHTML(message) + '</p>';
    dom['lyrics-source'].textContent = '\u2014';
  }

  function renderLyrics(song) {
    var lines = state.lyrics.lines;
    if (!lines.length) { renderNoLyrics('Lyric file is empty.'); return; }

    var html = [];
    var prevTime = null;
    for (var i = 0; i < lines.length; i++) {
      // Insert breathing room when there is a long gap between lines.
      if (prevTime !== null && lines[i].time - prevTime > 7) html.push('<div class="lyrics__line is-blank" aria-hidden="true"></div>');
      if (!lines[i].text) {
        html.push('<div class="lyrics__line is-blank" aria-hidden="true"></div>');
      } else {
        html.push('<button class="lyrics__line" data-line="' + i + '" type="button" title="Jump to ' + formatTime(lines[i].time) + '">' + escapeHTML(lines[i].text) + '</button>');
      }
      prevTime = lines[i].time;
    }
    dom['lyrics-inner'].innerHTML = html.join('');
    state.nodes = $$('.lyrics__line[data-line]', dom['lyrics-inner']);
    applyLyricPadding();

    var meta = state.lyrics.meta;
    var parts = [];
    if (meta.ti) parts.push(meta.ti);
    if (meta.ar && meta.ar !== song.artist) parts.push(meta.ar);
    dom['lyrics-source'].textContent = parts.join(' \u00b7 ') || (state.lyrics.synced ? 'synced' : 'unsynced');

    state.lyrics.active = -1;
    dom['lyrics-scroll'].scrollTop = 0;
  }

  function applyLyricPadding() {
    var height = dom['lyrics-scroll'].clientHeight || 400;
    dom['lyrics-inner'].style.setProperty('--lyric-pad', Math.round(height * 0.42) + 'px');
  }

  function currentOffset() {
    if (!state.song) return 0;
    return prefs.lyricOffsets[state.song.id] || 0;
  }

  function updateOffsetLabel() {
    var ms = currentOffset();
    dom['off-val'].textContent = formatOffset(ms);
  }

  function nudgeOffset(deltaMs) {
    if (!state.song) return;
    var next = Math.max(-10000, Math.min(10000, currentOffset() + deltaMs));
    if (next === 0) delete prefs.lyricOffsets[state.song.id];
    else prefs.lyricOffsets[state.song.id] = next;
    savePrefs();
    updateOffsetLabel();
    state.lyrics.active = -1;
  }

  function bindLyrics() {
    dom['off-minus'].addEventListener('click', function () { nudgeOffset(-50); });
    dom['off-plus'].addEventListener('click', function () { nudgeOffset(50); });
    dom['off-reset'].addEventListener('click', function () {
      if (!state.song) return;
      delete prefs.lyricOffsets[state.song.id];
      savePrefs();
      updateOffsetLabel();
      state.lyrics.active = -1;
      toast('Lyric offset reset');
    });

    dom['auto-scroll'].checked = prefs.autoScroll;
    dom['auto-scroll'].addEventListener('change', function () {
      prefs.autoScroll = dom['auto-scroll'].checked;
      savePrefs();
    });

    dom['lyrics-scroll'].addEventListener('click', function (event) {
      var node = event.target.closest('.lyrics__line[data-line]');
      if (!node || !engine.isReady()) return;
      var index = parseInt(node.getAttribute('data-line'), 10);
      var line = state.lyrics.lines[index];
      if (!line) return;
      engine.seek(Math.max(0, line.time - currentOffset() / 1000));
      if (!engine.isPlaying()) togglePlay();
    });

    dom['btn-expand'].addEventListener('click', toggleLyricFocus);
  }

  function toggleLyricFocus() {
    var on = dom.app.classList.toggle('lyrics-focus');
    dom['btn-expand'].classList.toggle('is-on', on);
    setTimeout(function () {
      applyLyricPadding();
      scrollLyrics(true);
    }, 260);
  }

  function scrollLyrics(instant) {
    if (!prefs.autoScroll) return;
    var node = state.nodes[state.lyrics.active];
    if (!node) return;
    var view = dom['lyrics-scroll'];
    var target = node.offsetTop - view.clientHeight * 0.38 + node.offsetHeight / 2;
    if (instant) view.scrollTop = target;
    else view.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
  }

  function syncLyrics(position) {
    var lines = state.lyrics.lines;
    if (!state.lyrics.synced || !lines.length || !state.nodes.length) return;

    var index = global.LRC.indexAt(lines, position + currentOffset() / 1000);
    if (index === state.lyrics.active) return;

    var previous = state.nodes[state.lyrics.active];
    if (previous) previous.classList.remove('is-active', 'is-done');

    state.lyrics.active = index;

    for (var i = 0; i < state.nodes.length; i++) {
      var node = state.nodes[i];
      if (!node) continue;
      node.classList.toggle('is-active', i === index);
      node.classList.toggle('is-done', i < index);
    }

    scrollLyrics(false);
  }

  /* ======================================================================
     Frame loop
     ====================================================================== */

  function tick() {
    var duration = engine.duration();
    var position = state.dragging && state.scrub != null ? state.scrub : engine.position();
    var pct = duration > 0 ? clamp01(position / duration) * 100 : 0;

    setProgress(pct);
    dom['time-now'].textContent = formatTime(position);
    if (duration > 0) dom['time-total'].textContent = formatTime(duration);

    syncLyrics(position);

    if (engine.isPlaying() !== dom.app.classList.contains('is-playing')) syncTransport();

    requestAnimationFrame(tick);
  }

  /* ======================================================================
     Modes
     ====================================================================== */

  function applyTheme() {
    doc.documentElement.setAttribute('data-theme', prefs.theme);
  }

  function bindModes() {
    dom['btn-theme'].addEventListener('click', function () {
      prefs.theme = prefs.theme === 'dark' ? 'light' : 'dark';
      applyTheme();
      savePrefs();
    });

    dom['btn-shuffle'].addEventListener('click', function () {
      prefs.shuffle = !prefs.shuffle;
      dom['btn-shuffle'].classList.toggle('is-on', prefs.shuffle);
      dom['btn-shuffle'].setAttribute('aria-pressed', prefs.shuffle ? 'true' : 'false');
      savePrefs();
      toast('Shuffle ' + (prefs.shuffle ? 'on' : 'off'));
    });

    dom['btn-repeat'].addEventListener('click', function () {
      prefs.repeat = prefs.repeat === 'off' ? 'all' : prefs.repeat === 'all' ? 'one' : 'off';
      dom['btn-repeat'].classList.toggle('is-on', prefs.repeat !== 'off');
      dom['repeat-badge'].hidden = prefs.repeat !== 'one';
      savePrefs();
      toast('Repeat: ' + prefs.repeat);
    });

    dom['btn-play'].addEventListener('click', togglePlay);
    dom['btn-prev'].addEventListener('click', function () { playIndex(nextIndex(-1)); });
    dom['btn-next'].addEventListener('click', function () { playIndex(nextIndex(1)); });

    dom.songlist.addEventListener('click', function (event) {
      var button = event.target.closest('.song');
      if (!button) return;
      var id = button.getAttribute('data-id');
      var index = state.songs.findIndex(function (s) { return s.id === id; });
      if (index < 0) return;
      if (index === state.index && engine.isReady()) togglePlay();
      else selectSong(index, true);
    });

    var searchTimer = null;
    dom.search.addEventListener('input', function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(renderPlaylist, 90);
    });
    dom.search.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') { dom.search.value = ''; renderPlaylist(); dom.search.blur(); }
      if (event.key === 'Enter') {
        var first = state.view[0];
        if (first) {
          var index = state.songs.indexOf(first);
          if (index >= 0 && index !== state.index) selectSong(index, true);
          else togglePlay();
        }
      }
    });

    dom['progress-buffer'].style.width = '100%';
  }

  function syncModeUI() {
    applyTheme();
    dom['btn-shuffle'].classList.toggle('is-on', prefs.shuffle);
    dom['btn-shuffle'].setAttribute('aria-pressed', prefs.shuffle ? 'true' : 'false');
    dom['btn-repeat'].classList.toggle('is-on', prefs.repeat !== 'off');
    dom['repeat-badge'].hidden = prefs.repeat !== 'one';
    dom['auto-scroll'].checked = prefs.autoScroll;
  }

  /* ======================================================================
     Help overlay
     ====================================================================== */

  function toggleHelp(force) {
    var overlay = dom['help-overlay'];
    var show = force === undefined ? overlay.hidden : force;
    overlay.hidden = !show;
  }

  function bindHelp() {
    dom.helpBtn.addEventListener('click', function () { toggleHelp(); });
    dom['btn-help-close'].addEventListener('click', function () { toggleHelp(false); });
    dom['help-overlay'].addEventListener('click', function (event) {
      if (event.target === dom['help-overlay']) toggleHelp(false);
    });
  }

  /* ======================================================================
     Keyboard
     ====================================================================== */

  function isTyping(target) {
    return target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
  }

  function bindKeys() {
    doc.addEventListener('keydown', function (event) {
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      if (event.key === 'Escape') {
        if (!dom['help-overlay'].hidden) { toggleHelp(false); return; }
        if (dom.app.classList.contains('lyrics-focus')) { toggleLyricFocus(); return; }
      }

      if (event.key === '/' && !isTyping(event.target)) {
        event.preventDefault();
        dom.search.focus();
        dom.search.select();
        return;
      }

      if (isTyping(event.target)) return;

      switch (event.key) {
        case ' ':
          event.preventDefault(); togglePlay(); break;
        case 'ArrowRight': event.preventDefault(); engine.seek(engine.position() + 5); break;
        case 'ArrowLeft': event.preventDefault(); engine.seek(engine.position() - 5); break;
        case 'l': case 'L': engine.seek(engine.position() + 10); break;
        case 'j': case 'J': engine.seek(engine.position() - 10); break;
        case 'ArrowUp':
          event.preventDefault(); bumpMaster(5); break;
        case 'ArrowDown':
          event.preventDefault(); bumpMaster(-5); break;
        case 'n': case 'N': playIndex(nextIndex(1)); break;
        case 'p': case 'P': playIndex(nextIndex(-1)); break;
        case 'v': case 'V': flipMute('vocals'); break;
        case 'b': case 'B': flipMute('backing'); break;
        case 'm': case 'M': flipMute('master'); break;
        case '[': nudgeOffset(-50); toast('Lyric offset ' + formatOffset(currentOffset())); break;
        case ']': nudgeOffset(50); toast('Lyric offset ' + formatOffset(currentOffset())); break;
        case 'f': case 'F': toggleLyricFocus(); break;
        case '?': toggleHelp(); break;
        default:
          if (/^[0-9]$/.test(event.key) && engine.duration() > 0) {
            engine.seek(engine.duration() * (parseInt(event.key, 10) / 10));
          }
      }
    });
  }

  function bumpMaster(delta) {
    var next = clamp01(engine.volume.master + delta / 100);
    engine.setVolume('master', next, 0.05);
    engine.setMuted('master', false, 0.05);
    commitMix('master');
  }

  function flipMute(track) {
    var muted = engine.toggleMuted(track);
    commitMix(track);
    toast(track.charAt(0).toUpperCase() + track.slice(1) + (muted ? ' muted' : ' unmuted'));
  }

  /* ======================================================================
     Boot
     ====================================================================== */

  /**
   * Audio can only be fetched over http(s). Opening index.html directly
   * gives a library that lists songs but silently refuses to play them,
   * so say so loudly instead of leaving the user guessing.
   */
  function checkProtocol() {
    if (global.location.protocol !== 'file:') return;
    var notice = doc.getElementById('file-notice');
    var button = doc.getElementById('btn-start-server');
    if (notice) notice.hidden = false;
    if (!button) return;
    button.addEventListener('click', function () {
      var cmd = 'python tools/serve.py';
      if (global.navigator.clipboard && global.navigator.clipboard.writeText) {
        global.navigator.clipboard.writeText(cmd)
          .then(function () { toast('Copied to clipboard'); })
          .catch(function () { toast('Run: ' + cmd); });
      } else {
        toast('Run: ' + cmd);
      }
    });
  }

  function init() {
    cacheDom();
    checkProtocol();
    loadPrefs();
    durations = readJSON(DUR_KEY, {}) || {};
    syncModeUI();

    engine.onstate = function () { paintAllMixer(); };
    engine.onended = onTrackEnded;

    // Handle for debugging and the smoke test in tools/.
    global.__engine = engine;
    global.__state = state;

    buildMixer();
    TRACKS.forEach(function (track) {
      engine.setVolume(track, DEFAULT_VOLUME[track], 0);
      engine.setMuted(track, false, 0);
    });
    paintAllMixer();
    bindMixReset();
    bindProgress();
    bindLyrics();
    bindModes();
    bindHelp();
    bindKeys();

    // Browsers require a gesture before an AudioContext may run.
    ['pointerdown', 'keydown'].forEach(function (type) {
      doc.addEventListener(type, function once() {
        engine.resume().catch(function () { /* ignore */ });
        doc.removeEventListener(type, once);
      }, { once: true });
    });

    var resizeTimer = null;
    global.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(applyLyricPadding, 120);
    });

    loadLibrary();
    syncTransport();
    requestAnimationFrame(tick);
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
  else init();

})(window);