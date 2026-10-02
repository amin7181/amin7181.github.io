/* ==========================================================================
   engine.js — dual-track Web Audio engine
   Vocals and backing are decoded into AudioBuffers and played from a shared
   AudioContext clock, so the two stems stay sample-locked no matter how long
   playback runs. Each stem has its own GainNode for independent volume.
   ========================================================================== */
(function (global) {
  'use strict';

  var TRACKS = ['vocals', 'backing'];

  function clamp(value, min, max) {
    return value < min ? min : value > max ? max : value;
  }

  function AudioEngine() {
    this.ctx = null;
    this.master = null;
    this.buses = null;          // { vocals: GainNode, backing: GainNode }

    this.buffers = { vocals: null, backing: null };
    this.sources = { vocals: null, backing: null };

    this.volume = { vocals: 1, backing: 1, master: 1 };
    this.muted = { vocals: false, backing: false, master: false };

    this.playing = false;
    this.loading = false;
    this._ready = false;
    this._offset = 0;           // seek position, seconds
    this._startedAt = 0;        // ctx.currentTime when playback last started
    this._duration = 0;
    this._loadToken = 0;
    this._abort = null;
    this._endTimer = null;

    this.onstate = function () {};
  }

  /* --- context ------------------------------------------------------------ */

  AudioEngine.prototype._ensureContext = function () {
    if (this.ctx) return this.ctx;
    var Ctor = global.AudioContext || global.webkitAudioContext;
    if (!Ctor) throw new Error('Web Audio API is not available in this browser.');
    this.ctx = new Ctor();

    this.master = this.ctx.createGain();
    this.buses = {};
    TRACKS.forEach(function (track) {
      var bus = this.ctx.createGain();
      bus.connect(this.master);
      this.buses[track] = bus;
    }, this);
    this.master.connect(this.ctx.destination);

    return this.ctx;
  };

  AudioEngine.prototype.resume = function () {
    if (!this.ctx) return Promise.resolve();
    if (this.ctx.state === 'suspended') return this.ctx.resume();
    return Promise.resolve();
  };

  /* --- loading ------------------------------------------------------------ */

  function fetchBuffer(ctx, url, signal, isCancelled) {
    return fetch(url, { signal: signal })
      .then(function (res) {
        if (!res.ok) throw new Error(url + ' -> HTTP ' + res.status);
        return res.arrayBuffer();
      })
      .then(function (buf) {
        if (isCancelled()) throw new Error('cancelled');
        return ctx.decodeAudioData(buf);
      });
  }

  /** Aborts any in-flight fetch from a superseded load. */
  AudioEngine.prototype.abortPending = function () {
    if (!this._abort) return;
    try { this._abort.abort(); } catch (e) { /* noop */ }
    this._abort = null;
  };

  /**
   * @param {{vocals?:string, backing:string}} files
   * @returns {Promise<Object|false>} `{missing: track[]}` when applied,
   *   or false if a newer load superseded this one.
   */
  AudioEngine.prototype.load = function (files) {
    var ctx = this._ensureContext();
    var token = ++this._loadToken;
    var self = this;
    var cancelled = function () { return token !== self._loadToken; };

    this.stopSources();
    this.abortPending();
    var controller = new AbortController();
    this._abort = controller;

    this.loading = true;
    this._ready = false;
    this.playing = false;
    this._offset = 0;
    this._duration = 0;
    this.buffers = { vocals: null, backing: null };
    this.onstate();

    var jobs = TRACKS.map(function (track) {
      var url = files && files[track];
      if (!url) return Promise.resolve({ track: track, skipped: true });
      return fetchBuffer(ctx, url, controller.signal, cancelled)
        .then(function (buffer) { return { track: track, buffer: buffer }; })
        .catch(function (err) {
          if (cancelled()) throw err;
          console.warn('[engine] could not load ' + track + ':', err);
          return { track: track, error: err };
        });
    });

    return Promise.all(jobs).then(function (results) {
      if (cancelled()) return false;

      var missing = [];
      results.forEach(function (entry) {
        if (!entry) return;
        if (entry.error || entry.skipped) missing.push(entry.track);
        else self.buffers[entry.track] = entry.buffer;
      });

      var lengths = TRACKS
        .map(function (t) { return self.buffers[t] ? self.buffers[t].duration : 0; })
        .filter(function (d) { return d > 0; });

      if (!lengths.length) throw new Error('No playable audio was loaded.');

      // The longer stem defines the timeline; playback stops when both end.
      self._abort = null;
      self._duration = Math.max.apply(null, lengths);
      self._ready = true;
      self.loading = false;
      self._applyGains(0);
      self.onstate();
      return { missing: missing };
    }).catch(function (err) {
      self._abort = null;
      if (cancelled()) return false;
      self.loading = false;
      self.onstate();
      throw err;
    });
  };

  /* --- gain --------------------------------------------------------------- */

  AudioEngine.prototype._effective = function (track) {
    return this.muted[track] ? 0 : this.volume[track];
  };

  AudioEngine.prototype._applyGains = function (rampSeconds) {
    if (!this.ctx) return;
    var now = this.ctx.currentTime;
    var tc = rampSeconds || 0;

    TRACKS.forEach(function (track) {
      var node = this.buses[track];
      var value = this._effective(track);
      if (tc > 0) {
        node.gain.cancelScheduledValues(now);
        node.gain.setValueAtTime(node.gain.value, now);
        node.gain.linearRampToValueAtTime(value, now + tc);
      } else {
        node.gain.setValueAtTime(value, now);
      }
    }, this);

    var masterValue = this.muted.master ? 0 : this.volume.master;
    if (tc > 0) {
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setValueAtTime(this.master.gain.value, now);
      this.master.gain.linearRampToValueAtTime(masterValue, now + tc);
    } else {
      this.master.gain.setValueAtTime(masterValue, now);
    }
  };

  AudioEngine.prototype.setVolume = function (track, value, rampSeconds) {
    if (!(track in this.volume)) return;
    this.volume[track] = clamp(value, 0, 1);
    this._applyGains(rampSeconds === undefined ? 0.04 : rampSeconds);
    this.onstate();
  };

  AudioEngine.prototype.setMuted = function (track, value, rampSeconds) {
    if (!(track in this.muted)) return;
    this.muted[track] = !!value;
    this._applyGains(rampSeconds === undefined ? 0.05 : rampSeconds);
    this.onstate();
  };

  AudioEngine.prototype.toggleMuted = function (track) {
    this.setMuted(track, !this.muted[track]);
    return this.muted[track];
  };

  /* --- transport ---------------------------------------------------------- */

  AudioEngine.prototype.stopSources = function () {
    TRACKS.forEach(function (track) {
      var source = this.sources[track];
      if (!source) return;
      source.onended = null;
      try { source.stop(); } catch (e) { /* already stopped */ }
      try { source.disconnect(); } catch (e) { /* noop */ }
      this.sources[track] = null;
    }, this);
    if (this._endTimer) {
      clearTimeout(this._endTimer);
      this._endTimer = null;
    }
  };

  AudioEngine.prototype._startSources = function (offset) {
    var self = this;
    var ctx = this._ensureContext();

    // Small lookahead gives the graph time to schedule cleanly.
    var when = ctx.currentTime + 0.02;
    this._startedAt = when;

    var started = 0;
    TRACKS.forEach(function (track) {
      var buffer = self.buffers[track];
      if (!buffer) return;
      if (offset >= buffer.duration - 0.02) return;

      var source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(self.buses[track]);
      source.onended = function () {
        if (self.sources[track] === source) self.sources[track] = null;
      };
      source.start(when, clamp(offset, 0, buffer.duration));
      self.sources[track] = source;
      started++;
    });

    if (!started) {
      this.playing = false;
      this._offset = this._duration;
      this.onstate();
      return false;
    }

    this.playing = true;

    var remaining = Math.max(0, (this._duration - offset) * 1000) + 120;
    this._endTimer = setTimeout(function () {
      self._endTimer = null;
      if (self.playing) self.onended();
    }, remaining);

    return true;
  };

  AudioEngine.prototype.play = function () {
    if (!this._ready) return Promise.resolve(false);
    var ctx = this._ensureContext();
    var self = this;

    return this.resume().then(function () {
      if (self.playing) return true;
      if (self._offset >= self._duration - 0.05) self._offset = 0;
      var ok = self._startSources(self._offset);
      self._applyGains(0.06);
      self.onstate();
      return ok;
    }).catch(function (err) {
      console.warn('[engine] play failed:', err);
      self.onstate();
      return false;
    });
  };

  AudioEngine.prototype.pause = function () {
    if (!this.playing) return;
    this._offset = this.position();
    this.stopSources();
    this.playing = false;
    this.onstate();
  };

  AudioEngine.prototype.dispose = function () {
    this.abortPending();
    this.stopSources();
    if (this.ctx) this.ctx.close().catch(function () { /* noop */ });
    this.ctx = null;
    this._ready = false;
  };

  AudioEngine.prototype.toggle = function () {
    return this.playing ? (this.pause(), Promise.resolve(false)) : this.play();
  };

  AudioEngine.prototype.seek = function (time) {
    // Guard: while loading, duration is still 0 and a clamp would silently
    // snap the playhead back to the start.
    if (!this._ready) return;
    var target = clamp(time, 0, this._duration);
    var wasPlaying = this.playing;
    if (wasPlaying) {
      this.stopSources();
      this.playing = false;
    }
    this._offset = target;
    if (wasPlaying) {
      this._startSources(target);
      this.onstate();
    } else {
      this.onstate();
    }
  };

  /* --- readout ------------------------------------------------------------ */

  AudioEngine.prototype.position = function () {
    if (!this.playing || !this.ctx) return this._offset;
    return clamp(this._offset + (this.ctx.currentTime - this._startedAt), 0, this._duration);
  };

  AudioEngine.prototype.duration = function () { return this._duration; };
  AudioEngine.prototype.isPlaying = function () { return this.playing; };
  AudioEngine.prototype.isReady = function () { return this._ready; };
  AudioEngine.prototype.isLoading = function () { return this.loading; };

  Object.defineProperty(AudioEngine.prototype, 'onended', {
    set: function (fn) { this._onended = typeof fn === 'function' ? fn : function () {}; },
    get: function () { return this._onended || function () {}; }
  });

  global.AudioEngine = AudioEngine;
  global.AUDIO_TRACKS = TRACKS;

})(window);