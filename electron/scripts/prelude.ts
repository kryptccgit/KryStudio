export const PRELUDE_FILE = 'krypt-prelude.js';
export const SCRIPT_FILE = 'script.js';
export const RUNNER_FILE = 'krypt-run.js';

export const PRELUDE = String.raw`
(function () {
  'use strict';
  var MAX_LOG_LINES = __LOG_LINES__;
  var MAX_LOG_CHARS = __LOG_CHARS__;
  var MAX_OUT = __OUT_CHARS__;
  var logs = [];
  function fmt(v) {
    if (typeof v === 'string') return v;
    try { var s = JSON.stringify(v); return s === undefined ? String(v) : s; } catch (e) { return String(v); }
  }
  function log() {
    if (logs.length >= MAX_LOG_LINES) return;
    var parts = [];
    for (var i = 0; i < arguments.length; i++) parts.push(fmt(arguments[i]));
    logs.push(parts.join(' ').slice(0, MAX_LOG_CHARS));
  }
  globalThis.console = { log: log, info: log, warn: log, error: log, debug: log };

  function mix(seed, salt) {
    var h = (seed >>> 0) ^ Math.imul((salt + 0x9e3779b9) | 0, 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
    h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
    return (h ^ (h >>> 16)) >>> 0;
  }
  function makeRand(seed) {
    var s = mix(seed, 0x5c1) || 0x9e3779b9;
    function rand() {
      s = (s + 0x6d2b79f5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    rand.int = function (lo, hi) { return lo + Math.floor(rand() * (hi - lo + 1)); };
    rand.range = function (lo, hi) { return lo + rand() * (hi - lo); };
    rand.chance = function (p) { return p > 0 && rand() < p; };
    rand.pick = function (items) { return items[Math.floor(rand() * items.length)]; };
    rand.weighted = function (weights) {
      var total = 0, i;
      for (i = 0; i < weights.length; i++) total += Math.max(0, weights[i]);
      if (!(total > 0)) return Math.floor(rand() * weights.length);
      var r = rand() * total;
      for (i = 0; i < weights.length; i++) { r -= Math.max(0, weights[i]); if (r < 0) return i; }
      return weights.length - 1;
    };
    rand.shuffle = function (items) {
      var a = items.slice();
      for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(rand() * (i + 1)); var x = a[i]; a[i] = a[j]; a[j] = x; }
      return a;
    };
    return rand;
  }

  function build(data) {
    var ctx = data;
    var steps = ctx.scaleSteps;
    var root = ctx.key;
    var rand = makeRand(ctx.seed);
    Math.random = rand;
    ctx.rand = rand;
    ctx.log = log;
    ctx.clamp = function (v, lo, hi) { return Math.min(hi, Math.max(lo, v)); };
    ctx.inScale = function (k) { return steps.indexOf((((k - root) % 12) + 12) % 12) >= 0; };
    ctx.snap = function (k) {
      for (var d = 0; d < 12; d++) {
        if (ctx.inScale(k - d)) return k - d;
        if (ctx.inScale(k + d)) return k + d;
      }
      return k;
    };
    ctx.degree = function (d, octave) {
      var n = steps.length;
      var o = Math.floor(d / n);
      var i = d - o * n;
      return ((octave === undefined ? 4 : octave) + 1) * 12 + root + steps[i] + 12 * o;
    };
    ctx.euclid = function (pulses, steps_, rotation) {
      var out = [];
      var n = Math.max(1, Math.floor(steps_));
      var k = Math.max(0, Math.min(n, Math.floor(pulses)));
      var r = Math.floor(rotation || 0);
      for (var i = 0; i < n; i++) {
        var j = (((i + r) % n) + n) % n;
        out.push(k > 0 && (j * k) % n < k);
      }
      return out;
    };
    ctx.chordAt = function (tick) {
      for (var i = 0; i < ctx.chords.length; i++) { var c = ctx.chords[i]; if (tick >= c.tick && tick < c.end) return c; }
      return null;
    };
    return ctx;
  }

  function invoke(json) {
    if (typeof run !== 'function') throw new TypeError('The script needs a function run(ctx) { … return notes }');
    var result = run(build(JSON.parse(json)));
    var out;
    try {
      out = JSON.stringify({ notes: result === undefined ? null : result, logs: logs });
    } catch (e) {
      throw new TypeError('run() must return plain data (an array of notes), not ' + (e && e.message ? e.message : 'that'));
    }
    if (out.length > MAX_OUT) throw new RangeError('run() returned too much data');
    return out;
  }
  Object.defineProperty(globalThis, '__kryptInvoke', { value: invoke, writable: false, configurable: false, enumerable: false });
})();
`;
