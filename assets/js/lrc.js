/* ==========================================================================
   lrc.js — LRC lyric parsing
   Supports: [ti:]/[ar:]/[al:]/[by:]/[offset:]/[length:] tags, multi-timestamp
   lines, centisecond & millisecond fractions, optional word-level markers.
   ========================================================================== */
(function (global) {
  'use strict';

  var TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  var META_TAG = /^\[(ti|ar|al|au|by|offset|length|re|ve|tool):(.*)\]$/i;
  // Karaoke word tags look like <mm:ss.xx> and are stripped from the text.
  var WORD_TAG = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g;

  function toSeconds(minutes, seconds, fraction) {
    var value = parseInt(minutes, 10) * 60 + parseInt(seconds, 10);
    if (fraction) value += parseInt(fraction, 10) / Math.pow(10, fraction.length);
    return value;
  }

  function cleanText(line) {
    return line
      .replace(TIME_TAG, '')
      .replace(WORD_TAG, '')
      .replace(/\s+$/, '')
      .trim();
  }

  /**
   * @param {string} raw
   * @returns {{meta: Object, lines: Array<{time:number,text:string,index:number}>, hasTiming:boolean}}
   */
  function parse(raw) {
    var meta = {};
    var lines = [];
    var hasTiming = false;

    if (typeof raw !== 'string' || !raw) return { meta: meta, lines: lines, hasTiming: hasTiming };

    // Strip a UTF-8 BOM so the first [ti:] tag is still recognised.
    var text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;

    text.split(/\r\n|\r|\n/).forEach(function (rawLine) {
      var line = rawLine.trim();
      if (!line) return;

      var metaMatch = line.match(META_TAG);
      if (metaMatch) {
        meta[metaMatch[1].toLowerCase()] = metaMatch[2].trim();
        return;
      }

      var stamps = [];
      var match;
      TIME_TAG.lastIndex = 0;
      while ((match = TIME_TAG.exec(line)) !== null) {
        stamps.push(toSeconds(match[1], match[2], match[3]));
      }
      if (!stamps.length) return;

      hasTiming = true;
      var text_ = cleanText(line);
      stamps.forEach(function (time) {
        lines.push({ time: time, text: text_, index: lines.length });
      });
    });

    lines.sort(function (a, b) {
      return a.time - b.time || a.index - b.index;
    });
    lines.forEach(function (line, i) { line.index = i; });

    return { meta: meta, lines: lines, hasTiming: hasTiming };
  }

  /** Index of the last line whose time is <= position, or -1. */
  function indexAt(lines, position) {
    var lo = 0, hi = lines.length - 1, found = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (lines[mid].time <= position) { found = mid; lo = mid + 1; }
      else { hi = mid - 1; }
    }
    return found;
  }

  /** Seconds until the line after `index`, or Infinity for the last line. */
  function durationOf(lines, index) {
    if (index < 0 || index + 1 >= lines.length) return Infinity;
    return Math.max(0.1, lines[index + 1].time - lines[index].time);
  }

  global.LRC = { parse: parse, indexAt: indexAt, durationOf: durationOf };

})(window);