/*
 * Monte-Carlo simulation of a small image patch containing a Gaussian target,
 * and canvas renderers for the patch and for its central row (the cross-section).
 */
(function () {
  'use strict';
  const W = 161, H = 81;
  const KEYS = ['dark', 'read', 'sky', 'tgt', 'star'];   // stacking order, bottom to top
  const COLOR_VARS = { dark: '--c-dark', sky: '--c-sky', tgt: '--c-target', read: '--c-read', star: '--c-star' };
  const LABELS = { dark: 'Dark current', sky: 'Sky glow', tgt: 'Target', read: 'Read noise', star: 'Stars' };

  function rng(seed) {
    let a = seed >>> 0;
    const u = () => {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const normal = () => Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u());
    const poisson = mu => {
      if (mu <= 0) return 0;
      if (mu > 40) return Math.max(0, Math.round(mu + Math.sqrt(mu) * normal()));
      const L = Math.exp(-mu);
      let k = 0, p = u();
      while (p > L) { k++; p *= u(); }
      return k;
    };
    // Restart the stream for one pixel and noise source. Every draw then depends only on the seed and
    // on which pixel it is for, so the noise pattern holds still while the settings change.
    const at = (pixel, source) => { a = (seed ^ Math.imul(pixel * 8 + source + 1, 0x9E3779B1)) >>> 0; };
    return { normal, poisson, at };
  }

  // Optional field stars, placed along the middle row so they appear in the cross-section.
  const STARS = [8, 10, 12, 14, 16, 18].map((mag, k) => ({ mag, x: 12 + k * 27, name: 'mag ' + mag }));

  const erf = Model.erf;

  /** Electron rate (e-/s) in every pixel from the stars: a Gaussian seeing disc integrated over each pixel. */
  function starMap(c, s) {
    const map = new Float64Array(W * H);
    const sigma = Math.max(0.35, s.seeing / c.r.scale / 2.3548), k = Math.SQRT2 * sigma;
    const reach = Math.ceil(6 * sigma) + 1, cy = (H - 1) / 2;
    const frac = d => 0.5 * (erf((d + 0.5) / k) - erf((d - 0.5) / k));
    STARS.forEach(st => {
      const rate = c.r.star0 * Math.pow(10, -0.4 * st.mag);
      for (let dy = -reach; dy <= reach; dy++) {
        for (let dx = -reach; dx <= reach; dx++) {
          const x = st.x + dx, y = cy + dy;
          if (x >= 0 && x < W && y >= 0 && y < H) map[y * W + x] += rate * frac(dx) * frac(dy);
        }
      }
    });
    return map;
  }

  /**
   * One realisation of the mean of n subs. Returns the patch (e- per sub) and the per-component
   * breakdown of the central row. Each sub clips at the full well, so the mean cannot exceed it either.
   */
  function field(c, t, n, sigmaPx, seed, stars) {
    const R = rng(seed);
    const fw = c.sen.fullWell;
    const img = new Float32Array(W * H);
    const row = { dark: [], sky: [], tgt: [], star: [], read: [], raw: [], total: [], clip: [], expTgt: [], expStar: [], expSig: [] };
    const cx = (W - 1) / 2, cy = (H - 1) / 2;
    const muSky = c.r.sky * t * n, muDark = c.r.dark * t * n;
    // A single sub is digitised exactly: analogue read noise, then rounding to whole ADU. The mean of
    // n subs can take values 1/n ADU apart; there the rounding error of each sub is treated as noise.
    const { sdRead, step, digitise } = digitiser(c.sen, n);
    const profile = new Float64Array(W);
    for (let x = 0; x < W; x++) profile[x] = Math.exp(-((x - cx) * (x - cx)) / (2 * sigmaPx * sigmaPx));
    for (let y = 0; y < H; y++) {
      const fy = Math.exp(-((y - cy) * (y - cy)) / (2 * sigmaPx * sigmaPx));
      for (let x = 0; x < W; x++) {
        const muT = c.r.target * t * n * profile[x] * fy;
        const muS = stars ? stars[y * W + x] * t * n : 0;
        if (y === cy) {
          const i = y * W + x;
          const draw = (source, mu) => { R.at(i, source); return R.poisson(mu) / n; };
          const d = draw(0, muDark), s = draw(1, muSky), g = draw(2, muT), p = muS > 0 ? draw(3, muS) : 0;
          R.at(i, 4);
          const raw = digitise(d + s + g + p + sdRead * R.normal() / n);
          const r = raw - (d + s + g + p);                    // read noise including the rounding error
          row.dark.push(d); row.sky.push(s); row.tgt.push(g); row.star.push(p); row.read.push(r);
          row.raw.push(raw); row.total.push(Math.min(raw, fw)); row.clip.push(raw > fw);
          row.expTgt.push(muT / n); row.expStar.push(muS / n); row.expSig.push((muT + muS) / n);
          img[y * W + x] = Math.min(raw, fw);
        } else {
          R.at(y * W + x, 0);
          const photons = R.poisson(muDark + muSky + muT + muS);
          R.at(y * W + x, 4);
          img[y * W + x] = Math.min(digitise((photons + sdRead * R.normal()) / n), fw);
        }
      }
    }
    row.anyClip = row.clip.some(Boolean);
    return { img, row, step };
  }

  /**
   * How the mean of n subs is digitised. A single sub is exact: analogue read noise, then rounding
   * to whole ADU. The mean of n subs moves in steps of 1/n ADU, and each sub's rounding error is
   * treated as extra read noise. `sdRead` is the read noise of the sum of the n subs.
   */
  function digitiser(sen, n) {
    const step = sen.eAdu / n;
    return { step, sdRead: (n === 1 ? sen.rnAnalog : sen.rn) * Math.sqrt(n), digitise: v => Math.round(v / step) * step };
  }

  /** K independent values of one pixel that collects `mu` electrons per sub, as the mean of n subs. */
  function samplePixel(sen, mu, n, K, seed) {
    const R = rng(seed), { sdRead, digitise } = digitiser(sen, n);
    const out = new Float64Array(K);
    R.at(0, 0);
    for (let k = 0; k < K; k++) out[k] = Math.min(digitise((R.poisson(mu * n) + sdRead * R.normal()) / n), sen.fullWell);
    return out;
  }

  function moments(a) {
    let m = 0, v = 0;
    for (let i = 0; i < a.length; i++) m += a[i];
    m /= a.length;
    for (let i = 0; i < a.length; i++) v += (a[i] - m) * (a[i] - m);
    return { mean: m, sd: Math.sqrt(v / Math.max(1, a.length - 1)) };
  }

  /** Background noise (e-, per-sub scale) measured from a fresh sample of sky-only pixels in a stack of n subs. */
  function measuredNoise(c, sim, n, seed) {
    return moments(samplePixel(c.sen, sim.bg, n, 2000, seed + 31 * n)).sd;
  }

  /** Up to `count` sub counts spaced geometrically from 1 to n. */
  function subSteps(n, count) {
    const out = [];
    for (let i = 0; i < count; i++) {
      const k = Math.max(1, Math.round(Math.pow(n, i / (count - 1))));
      if (!out.includes(k)) out.push(k);
    }
    return out;
  }

  /** One more patch, for a stack of n subs, from the same scene as `sim`. */
  function extraFrame(c, s, sim, n, seed) {
    if (n === 1) return sim.single;
    if (n === s.n) return sim.stack;
    return Object.assign(field(c, s.sub, n, sim.sigmaPx, seed + 104729 * n, sim.starRates), { n, sd: sim.single.sd / Math.sqrt(n) });
  }

  function generate(c, s, seed) {
    const sigmaPx = Math.max(0.5, s.tgtFwhm / c.r.scale / 2.3548);
    const bg = (c.r.sky + c.r.dark) * s.sub;
    const peak = c.r.target * s.sub;
    const sd1 = Math.sqrt(bg + c.sen.rn * c.sen.rn);
    const stars = s.simStars ? starMap(c, s) : null;
    return {
      W, H, sigmaPx, bg, peak, fullWell: c.sen.fullWell, stars: s.simStars ? STARS : [], starRates: stars,
      expSky: c.r.sky * s.sub, expDark: c.r.dark * s.sub,
      single: Object.assign(field(c, s.sub, 1, sigmaPx, seed, stars), { n: 1, sd: sd1 }),
      stack: Object.assign(field(c, s.sub, s.n, sigmaPx, seed + 7919, stars), { n: s.n, sd: sd1 / Math.sqrt(s.n) })
    };
  }

  /**
   * Non-linear screen stretch of the kind used to preview linear astronomical data: values are scaled so
   * the full well is 1, the black point is set just below the background, and a midtones transfer
   * function lifts the background to a quarter of the output range. Returns electrons -> 0..1.
   */
  function stretcher(sim, f) {
    const fw = sim.fullWell;
    const med = sim.bg / fw, sd = f.sd / fw;
    const c0 = Math.min(Math.max(0, med - 2.8 * sd), 0.99);
    const mtf = (m, x) => x <= 0 ? 0 : x >= 1 ? 1 : (m - 1) * x / ((2 * m - 1) * x - m);
    const medC = Math.min(Math.max((med - c0) / (1 - c0), 1e-9), 0.999);
    const m = mtf(0.25, medC);
    const fn = e => mtf(m, Math.min(1, Math.max(0, (e / fw - c0) / (1 - c0))));
    fn.black = c0 * fw;
    return fn;
  }

  /** Greyscale render of a patch: the non-linear stretch, or a linear one from the background to the peak. */
  function drawPatch(canvas, sim, f, stretched) {
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    const id = ctx.createImageData(W, H);
    const lo = sim.bg - 3 * f.sd;
    const hi = sim.bg + Math.max(sim.peak + 3 * f.sd, 5 * f.sd);
    const st = stretched ? stretcher(sim, f) : null;
    for (let i = 0; i < W * H; i++) {
      const v = st ? st(f.img[i]) : f.img[i] >= sim.fullWell ? 1 : Math.pow(Math.max(0, Math.min(1, (f.img[i] - lo) / (hi - lo))), 1 / 2.2);
      const g = Math.round(255 * v);
      id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = g;
      id.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(id, 0, 0);
  }

  /**
   * Histogram of image brightness for both patches: number of pixels (log scale) against brightness
   * on a 0..1 scale. Brightness is the pixel value as a fraction of full well (or its stretched value),
   * so pixels clipped at black pile up at 0 and saturated ones at 1. `zoom` narrows the axis to the
   * range of values present; `log` puts brightness on a log scale, which leaves out pixels at zero.
   *
   * With `curve`, the same axis (always linear brightness) carries the stretch curve of each image
   * instead: brightness in along the axis, stretched brightness out, 0 to 1, up the side.
   */
  function drawHist(canvas, sim, stretched, zoom, log, curve) {
    if (curve) stretched = false;
    const css = getComputedStyle(canvas);
    const col = name => css.getPropertyValue(name).trim();
    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cw, ch);
    const m = { l: 30, r: 12, t: 6, b: 30 };
    const pw = cw - m.l - m.r, ph = ch - m.t - m.b;
    const BINS = Math.max(16, Math.min(128, Math.floor(pw / 2)));
    const frames = [sim.single, sim.stack].map(f => {
      const st = stretched ? stretcher(sim, f) : null, b = new Float64Array(f.img.length);
      for (let i = 0; i < b.length; i++) b[i] = st ? st(f.img[i]) : Math.max(0, Math.min(1, f.img[i] / sim.fullWell));
      return b;
    });
    // Axis range: 0..1, or the range of the data when zoomed. A log axis starts at the smallest value above zero.
    let min = Infinity, minPos = Infinity, max = 0;
    frames.forEach(b => { for (let i = 0; i < b.length; i++) { const v = b[i]; if (v < min) min = v; if (v > max) max = v; if (v > 0 && v < minPos) minPos = v; } });
    if (!isFinite(minPos)) minPos = 1e-6;
    let lo = log ? minPos : zoom ? min : 0, hi = zoom ? max : 1;
    if (log) { lo = Math.log10(lo); hi = Math.log10(Math.max(hi, minPos)); }
    if (hi - lo < 1e-9) { lo -= log ? 0.05 : 0.005; hi += log ? 0.05 : 0.005; }
    const pos = v => ((log ? Math.log10(v) : v) - lo) / (hi - lo);        // 0..1 along the axis
    const count = b => {
      const h = new Array(BINS).fill(0);
      for (let i = 0; i < b.length; i++) {
        if (log && b[i] <= 0) continue;
        const t = pos(b[i]);
        if (t < -1e-9 || t > 1 + 1e-9) continue;
        h[Math.max(0, Math.min(BINS - 1, Math.floor(t * BINS)))]++;
      }
      return h;
    };
    const total = W * H, top = Math.log10(total);
    const y = n => m.t + ph - (n < 1 ? 0 : (Math.log10(n) + 0.15) / (top + 0.15)) * ph;
    const bw = pw / BINS;

    ctx.font = '10px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
    const gridLine = (yy, label) => {
      yy = Math.round(yy) + 0.5;
      ctx.strokeStyle = col('--grid'); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(m.l, yy); ctx.lineTo(m.l + pw, yy); ctx.stroke();
      ctx.fillStyle = col('--text-muted');
      ctx.fillText(label, m.l - 4, yy);
    };
    if (curve) {
      [0, 0.25, 0.5, 0.75, 1].forEach(v => gridLine(m.t + ph * (1 - v), String(v)));
      [[sim.single, col('--c-stretch')], [sim.stack, col('--c-metric')]].forEach(([f, color]) => {
        const st = stretcher(sim, f);
        ctx.beginPath();
        for (let px = 0; px <= pw; px++) {
          const x = lo + px / pw * (hi - lo), v = log ? Math.pow(10, x) : x;
          const yy = m.t + ph * (1 - st(v * sim.fullWell));
          if (px) ctx.lineTo(m.l + px, yy); else ctx.moveTo(m.l + px, yy);
        }
        ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
      });
    } else {
      for (let p = 0; Math.pow(10, p) <= total; p++) { const n = Math.pow(10, p); gridLine(y(n), n >= 1000 ? n / 1000 + 'k' : String(n)); }
      const series = (h, color, fillAlpha) => {
        ctx.beginPath(); ctx.moveTo(m.l, m.t + ph);
        h.forEach((n, k) => { ctx.lineTo(m.l + k * bw, y(n)); ctx.lineTo(m.l + (k + 1) * bw, y(n)); });
        ctx.lineTo(m.l + pw, m.t + ph); ctx.closePath();
        ctx.globalAlpha = fillAlpha; ctx.fillStyle = color; ctx.fill();
        ctx.globalAlpha = 1; ctx.strokeStyle = color; ctx.lineWidth = 1.25; ctx.lineJoin = 'round'; ctx.stroke();
      };
      series(count(frames[0]), col('--c-stretch'), 0.3);
      series(count(frames[1]), col('--c-metric'), 0.3);
    }

    ctx.strokeStyle = col('--axis'); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(m.l, m.t + ph + 0.5); ctx.lineTo(m.l + pw, m.t + ph + 0.5); ctx.stroke();
    ctx.fillStyle = col('--text-muted'); ctx.textBaseline = 'top';
    const fmt = v => v === 0 ? '0' : Math.abs(v) < 1e-4 ? v.toExponential(0).replace('e-', 'e−') : String(+v.toPrecision(2));
    const val = t => { const x = lo + t * (hi - lo); return log ? Math.pow(10, x) : x; };
    let ticks = [0, 0.25, 0.5, 0.75, 1];
    if (log) {
      // The two ends, plus whole decades that are not crowded against them.
      ticks = [0, 1];
      for (let d = Math.ceil(lo); d <= Math.floor(hi); d++) { const t = (d - lo) / (hi - lo); if (t > 0.18 && t < 0.82) ticks.push(t); }
      if (ticks.length === 2) ticks.push(0.5);
    }
    ticks.forEach(t => {
      const x = m.l + t * pw;
      ctx.textAlign = t === 0 ? 'left' : t === 1 ? 'right' : 'center';
      ctx.fillText(fmt(val(t)), t === 1 ? x + 8 : x, m.t + ph + 4);
      ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, m.t + ph); ctx.lineTo(Math.round(x) + 0.5, m.t + ph + 3); ctx.stroke();
    });
    ctx.textAlign = 'center';
    ctx.fillText((curve ? 'Linear brightness in' : stretched ? 'Stretched brightness' : 'Brightness') + (log ? ' (log scale)' : ' (1 = full well)'), m.l + pw / 2, m.t + ph + 17);
  }

  // ---------- small side plots ----------
  const FONT = '10px system-ui, -apple-system, "Segoe UI", sans-serif';
  const fmtTick = v => v === 0 ? '0' : Math.abs(v) >= 10000 ? +(v / 1000).toPrecision(2) + 'k' : Math.abs(v) < 0.01 ? v.toExponential(0).replace('e-', 'e−') : String(+v.toPrecision(2));

  /** 1-2-5 ticks inside [lo, hi] for a log axis, thinned to about `want`. */
  function logTicks(lo, hi, want) {
    let t = [];
    for (let d = Math.floor(Math.log10(lo)); d <= Math.ceil(Math.log10(hi)); d++) [1, 2, 5].forEach(k => { const v = k * Math.pow(10, d); if (v >= lo * 0.999 && v <= hi * 1.001) t.push(v); });
    if (t.length > want) { const dec = t.filter(v => Math.abs(Math.log10(v) - Math.round(Math.log10(v))) < 1e-9); if (dec.length >= 2) t = dec; }
    while (t.length > want) t = t.filter((_, i) => i % 2 === 0);
    return t;
  }
  function linTicks(lo, hi, want) {
    const raw = (hi - lo) / want, mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 5, 10].map(k => k * mag).find(v => v >= raw);
    const t = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) t.push(+v.toPrecision(10));
    return t;
  }

  /**
   * Axes for a small canvas plot. cfg = {xDomain, yDomain, xLog, yLog, xTitle, yTicks: false to hide,
   * top: extra top margin for marker labels}. Returns the context and the scale functions.
   */
  function miniPlot(canvas, cfg) {
    const css = getComputedStyle(canvas);
    const col = name => css.getPropertyValue(name).trim();
    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cw, ch);
    const m = { l: cfg.yTicks === false ? 8 : 30, r: 12, t: 6 + (cfg.top || 0), b: 30 };
    const pw = cw - m.l - m.r, ph = ch - m.t - m.b;
    const tr = (log, d) => v => ((log ? Math.log10(v) : v) - (log ? Math.log10(d[0]) : d[0])) / ((log ? Math.log10(d[1]) : d[1]) - (log ? Math.log10(d[0]) : d[0]));
    const fx = tr(cfg.xLog, cfg.xDomain), fy = tr(cfg.yLog, cfg.yDomain);
    const X = v => m.l + fx(v) * pw, Y = v => m.t + ph - fy(v) * ph;
    ctx.font = FONT;
    if (cfg.yTicks !== false) {
      ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
      (cfg.yLog ? logTicks(cfg.yDomain[0], cfg.yDomain[1], 4) : linTicks(cfg.yDomain[0], cfg.yDomain[1], 4)).forEach(v => {
        const yy = Math.round(Y(v)) + 0.5;
        ctx.strokeStyle = col('--grid'); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(m.l, yy); ctx.lineTo(m.l + pw, yy); ctx.stroke();
        ctx.fillStyle = col('--text-muted'); ctx.fillText(fmtTick(v), m.l - 4, yy);
      });
    }
    ctx.strokeStyle = col('--axis'); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(m.l, m.t + ph + 0.5); ctx.lineTo(m.l + pw, m.t + ph + 0.5); ctx.stroke();
    ctx.fillStyle = col('--text-muted'); ctx.textBaseline = 'top'; ctx.textAlign = 'center';
    (cfg.xLog ? logTicks(cfg.xDomain[0], cfg.xDomain[1], 4) : linTicks(cfg.xDomain[0], cfg.xDomain[1], 4)).forEach(v => {
      const x = X(v);
      ctx.fillText(fmtTick(v), Math.max(m.l + 6, Math.min(m.l + pw - 4, x)), m.t + ph + 4);
      ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, m.t + ph); ctx.lineTo(Math.round(x) + 0.5, m.t + ph + 3); ctx.stroke();
    });
    ctx.fillText(cfg.xTitle, m.l + pw / 2, m.t + ph + 17);
    const clip = fn => { ctx.save(); ctx.beginPath(); ctx.rect(m.l, m.t - 1, pw, ph + 1); ctx.clip(); fn(); ctx.restore(); };
    return { ctx, X, Y, col, m, pw, ph, clip };
  }

  /**
   * Values taken by a sky-only pixel and by the target-peak pixel over many repeats, in a stack of
   * n subs: sampled histograms with the expected normal curves. `domain` is shared between plots.
   */
  function drawDist(canvas, c, sim, n, domain, seed) {
    const P = miniPlot(canvas, { xDomain: domain, yDomain: [0, 1], yTicks: false, top: 12, xTitle: 'Pixel value (e⁻, mean per sub)' });
    const { ctx, X, m, pw, ph } = P, K = 4000, BINS = Math.max(24, Math.floor(pw / 2));
    const rn2 = c.sen.rn * c.sen.rn, binW = (domain[1] - domain[0]) / BINS;
    const items = [['Sky', sim.bg, P.col('--c-sky'), 1], ['Target', sim.bg + sim.peak, P.col('--c-target'), 2]].map(([name, mu, color, src]) => {
      const h = new Array(BINS).fill(0);
      samplePixel(c.sen, mu, n, K, seed + src * 977 + n).forEach(v => { const b = Math.floor((v - domain[0]) / binW); if (b >= 0 && b < BINS) h[b]++; });
      const sd = Math.sqrt((mu + rn2) / n);
      return { name, mu, color, h, sd, peak: K * binW / (sd * Math.sqrt(2 * Math.PI)) };
    });
    const top = Math.max.apply(null, items.map(it => Math.max(it.peak, Math.max.apply(null, it.h)))) * 1.05;
    const y = v => m.t + ph - Math.min(1, v / top) * ph;
    P.clip(() => items.forEach(it => {
      ctx.beginPath(); ctx.moveTo(m.l, m.t + ph);
      it.h.forEach((v, k) => { ctx.lineTo(m.l + k * pw / BINS, y(v)); ctx.lineTo(m.l + (k + 1) * pw / BINS, y(v)); });
      ctx.lineTo(m.l + pw, m.t + ph); ctx.closePath();
      ctx.globalAlpha = 0.3; ctx.fillStyle = it.color; ctx.fill(); ctx.globalAlpha = 1;
      ctx.beginPath();
      for (let px = 0; px <= pw; px++) {
        const v = domain[0] + px / pw * (domain[1] - domain[0]), z = (v - it.mu) / it.sd;
        const yy = y(it.peak * Math.exp(-0.5 * z * z));
        if (px) ctx.lineTo(m.l + px, yy); else ctx.moveTo(m.l + px, yy);
      }
      ctx.strokeStyle = it.color; ctx.lineWidth = 1.75; ctx.lineJoin = 'round'; ctx.stroke();
    }));
    // Direct labels: sky to the left of its mean, target to the right, so they never collide.
    ctx.font = FONT; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = P.col('--text-primary');
    ctx.textAlign = 'right'; ctx.fillText('Sky', Math.max(m.l + 18, X(items[0].mu) - 3), m.t - 3);
    ctx.textAlign = 'left'; ctx.fillText('Target peak', Math.min(m.l + pw - 56, X(items[1].mu) + 3), m.t - 3);
    [items[0], items[1]].forEach(it => {
      ctx.strokeStyle = it.color; ctx.lineWidth = 1; ctx.setLineDash([2, 2]);
      ctx.beginPath(); ctx.moveTo(X(it.mu), m.t); ctx.lineTo(X(it.mu), m.t + ph); ctx.stroke(); ctx.setLineDash([]);
    });
  }
  /** x-range for the two distribution plots: wide enough for the single-sub spread. */
  function distDomain(c, sim) {
    const rn2 = c.sen.rn * c.sen.rn;
    const lo = sim.bg - 4 * Math.sqrt(sim.bg + rn2), hi = sim.bg + sim.peak + 4 * Math.sqrt(sim.bg + sim.peak + rn2);
    return [lo, Math.min(hi, Math.max(c.sen.fullWell * 1.05, lo + 1))];
  }

  /** Background noise measured in the simulation as subs are added, against the 1/sqrt(N) law. */
  function drawNoiseVsSubs(canvas, c, sim, s, seed) {
    const n = Math.max(2, s.n), sd1 = Math.sqrt(sim.bg + c.sen.rn * c.sen.rn);
    const P = miniPlot(canvas, { xLog: true, yLog: true, xDomain: [1, n], yDomain: [sd1 / Math.sqrt(n) / 1.6, sd1 * 1.6], xTitle: 'Number of subs stacked (log scale)' });
    const { ctx, X, Y, m, pw } = P;
    ctx.strokeStyle = P.col('--text-muted'); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(X(1), Y(sd1)); ctx.lineTo(X(n), Y(sd1 / Math.sqrt(n))); ctx.stroke();
    ctx.font = FONT; ctx.fillStyle = P.col('--text-secondary'); ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText('Theory: 1/√N', X(Math.pow(n, 0.45)), Y(sd1 / Math.pow(n, 0.225)) - 5);
    subSteps(s.n, 8).forEach(k => {
      const sd = measuredNoise(c, sim, k, seed);
      if (!(sd > 0)) return;
      ctx.beginPath(); ctx.arc(X(Math.max(1, k)), Y(sd), 3.5, 0, 2 * Math.PI);
      ctx.fillStyle = P.col('--c-metric'); ctx.fill();
      ctx.strokeStyle = P.col('--surface'); ctx.lineWidth = 1.5; ctx.stroke();
    });
  }

  /** Photon transfer curve of a single sub: measured noise against mean signal, with its three regimes. */
  function drawPtc(canvas, c, sim, seed) {
    const fw = c.sen.fullWell, rn = c.sen.rn;
    const xd = [Math.min(1, rn * rn / 10), fw * 2.5], yd = [Math.min(rn, Math.sqrt(xd[0])) / 2, Math.sqrt(fw) * 2.5];
    const P = miniPlot(canvas, { xLog: true, yLog: true, xDomain: xd, yDomain: yd, top: 22, xTitle: 'Mean signal in one sub (e⁻, log scale)' });
    const { ctx, X, Y, m, pw, ph } = P;
    const curve = (fn, color, dash, width) => P.clip(() => {
      ctx.beginPath();
      for (let px = 0; px <= pw; px++) { const S = Math.pow(10, Math.log10(xd[0]) + px / pw * Math.log10(xd[1] / xd[0])); const yy = Y(fn(S)); if (px) ctx.lineTo(m.l + px, yy); else ctx.moveTo(m.l + px, yy); }
      ctx.setLineDash(dash); ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke(); ctx.setLineDash([]);
    });
    curve(() => rn, P.col('--c-read'), [4, 3], 1.5);
    curve(S => Math.sqrt(S), P.col('--text-muted'), [4, 3], 1.5);
    curve(S => Math.sqrt(S + rn * rn), P.col('--text-muted'), [], 1.5);
    ctx.font = FONT;
    // Operating points of the current plan, labelled in two rows above the plot.
    [['Sky', sim.bg, 1], ['Target', sim.bg + sim.peak, 0], ['Full well', fw, 1]].forEach(([name, v, rowIdx]) => {
      if (!(v >= xd[0] && v <= xd[1])) return;
      const x = Math.round(X(v)) + 0.5;
      ctx.strokeStyle = P.col('--axis'); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, m.t - (rowIdx ? 1 : 12)); ctx.lineTo(x, m.t + ph); ctx.stroke();
      ctx.fillStyle = P.col('--text-secondary'); ctx.textBaseline = 'alphabetic';
      ctx.textAlign = name === 'Target' ? 'left' : name === 'Sky' ? 'right' : 'center';
      ctx.fillText(name, Math.max(m.l + 10, Math.min(m.l + pw - 18, x + (name === 'Target' ? 3 : name === 'Sky' ? -3 : 0))), m.t - (rowIdx ? 3 : 13));
    });
    const LEVELS = 30;
    for (let i = 0; i < LEVELS; i++) {
      const S = Math.pow(10, Math.log10(xd[0]) + (i + 0.5) / LEVELS * Math.log10(xd[1] / xd[0]));
      const sd = moments(samplePixel(c.sen, S, 1, 400, seed + 61 * i)).sd;
      const below = !(sd >= yd[0]);                        // clipped at full well: the noise collapses
      ctx.beginPath(); ctx.arc(X(S), below ? m.t + ph - 3 : Y(sd), 3, 0, 2 * Math.PI);
      if (below) { ctx.strokeStyle = P.col('--c-metric'); ctx.lineWidth = 1.5; ctx.stroke(); }
      else { ctx.fillStyle = P.col('--c-metric'); ctx.fill(); ctx.strokeStyle = P.col('--surface'); ctx.lineWidth = 1; ctx.stroke(); }
    }
  }

  function sortOrder(row, key) {
    const idx = row.total.map((_, i) => i);
    if (key === 'pos') return idx;
    const arr = key === 'total' ? row.total : key === 'signal' ? row.expSig : row[key];
    return idx.sort((a, b) => arr[a] - arr[b] || a - b);
  }

  /** The cross-section after the non-linear stretch: one value per pixel on a 0..1 scale. */
  function drawStretched(canvas, sim, f, opts) {
    const css = getComputedStyle(canvas);
    const col = name => css.getPropertyValue(name).trim();
    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cw, ch);

    const starLabels = sim.stars.length && opts.sort === 'pos';
    const m = { l: 66, r: 12, t: starLabels ? 26 : 14, b: 40 };
    const pw = cw - m.l - m.r, ph = ch - m.t - m.b;
    const row = f.row, order = sortOrder(row, opts.sort);
    const st = stretcher(sim, f);
    const sy = v => m.t + ph - v * ph;
    const bw = pw / W, gap = bw >= 4 ? 1 : 0;
    ctx.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;

    // One faint line per ADC level, for as long as neighbouring levels are far enough apart to see.
    let levels = 0, prevY = Infinity;
    ctx.strokeStyle = col('--grid');
    for (let k = Math.ceil(st.black / f.step); levels < 400; k++) {
      const v = st(k * f.step), y = sy(v);
      if (v >= 1 || prevY - y < 3 && levels > 0) break;
      if (prevY - y >= 3) {
        ctx.beginPath(); ctx.moveTo(m.l, Math.round(y) + 0.5); ctx.lineTo(m.l + pw, Math.round(y) + 0.5); ctx.stroke();
        levels++;
      }
      prevY = y;
    }
    [0, 0.25, 0.5, 0.75, 1].forEach(t => {
      const y = Math.round(sy(t)) + 0.5;
      if (t === 0 || levels < 2) {
        ctx.strokeStyle = t === 0 ? col('--axis') : col('--grid');
        ctx.beginPath(); ctx.moveTo(m.l, y); ctx.lineTo(m.l + pw, y); ctx.stroke();
      }
      ctx.fillStyle = col('--text-muted'); ctx.textAlign = 'right';
      ctx.fillText(t.toFixed(2), m.l - 8, y);
    });

    // Columns: one stretched value per pixel
    const ink = col('--c-stretch'), grey = col('--c-clipped');
    order.forEach((i, rank) => {
      const y = sy(st(row.total[i]));
      ctx.fillStyle = row.clip[i] ? grey : ink;
      ctx.fillRect(m.l + rank * bw, y, bw - gap, m.t + ph - y);
    });
    ctx.strokeStyle = col('--c-expected'); ctx.lineWidth = 2; ctx.lineJoin = 'round';
    ctx.beginPath();
    order.forEach((i, rank) => {
      const x = m.l + rank * bw, y = sy(st(sim.expDark + sim.expSky + row.expSig[i]));
      if (rank === 0 || opts.sort !== 'pos') ctx.moveTo(x, y); else ctx.lineTo(x, y);
      ctx.lineTo(x + bw - (opts.sort !== 'pos' ? gap : 0), y);
    });
    ctx.stroke();

    // Clipping level
    ctx.strokeStyle = col('--text-secondary'); ctx.lineWidth = 1;
    ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.moveTo(m.l, sy(1) + 0.5); ctx.lineTo(m.l + pw, sy(1) + 0.5); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = col('--text-secondary'); ctx.textAlign = 'right';
    ctx.fillText('1.0 = full well: clipped', m.l + pw - 4, sy(1) + 10);

    if (starLabels) {
      ctx.textAlign = 'center';
      sim.stars.forEach(s => ctx.fillText(s.name, m.l + (s.x + 0.5) * bw, 10));
    }
    ctx.fillStyle = col('--text-muted'); ctx.textAlign = 'center';
    const xl = opts.sort === 'pos' ? 'Position along the cross-section (pixels from centre)' : 'Pixels ranked by ' + opts.sortLabel + ' (rank, low → high)';
    if (opts.sort === 'pos') {
      for (let p = 0; p < W; p += 20) ctx.fillText(String(p - (W - 1) / 2), m.l + (p + 0.5) * bw, m.t + ph + 12);
    }
    ctx.fillStyle = col('--text-secondary');
    ctx.font = '12px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.fillText(xl, m.l + pw / 2, ch - 9);
    ctx.save();
    ctx.translate(12, m.t + ph / 2); ctx.rotate(-Math.PI / 2);
    ctx.fillText(opts.yLabel, 0, 0);
    ctx.restore();
    return { m, bw, order, pw, ph, levels };
  }

  /**
   * Draw the cross-section. opts: { view: 'raw' | 'cal', sort, showFullWell }
   * Returns geometry used for hover hit-testing.
   */
  function drawSection(canvas, sim, f, opts) {
    if (opts.view === 'str') return drawStretched(canvas, sim, f, opts);
    const css = getComputedStyle(canvas);
    const col = name => css.getPropertyValue(name).trim();
    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cw, ch);

    const starLabels = sim.stars.length && opts.sort === 'pos';
    const m = { l: 66, r: 12, t: starLabels ? 26 : 10, b: 40 };
    const pw = cw - m.l - m.r, ph = ch - m.t - m.b;
    const row = f.row, order = sortOrder(row, opts.sort);
    const cal = opts.view === 'cal';
    const bgMean = sim.expDark + sim.expSky;
    const exp = { dark: () => sim.expDark, sky: () => sim.expSky, tgt: i => row.expTgt[i], star: i => row.expStar[i], read: () => 0 };
    // Value each component contributes to the column: raw electrons, or deviation from its expectation.
    const val = (k, i) => cal ? row[k][i] - exp[k](i) : row[k][i];
    const measured = i => cal ? row.total[i] - bgMean : row.total[i];
    const fwLevel = cal ? sim.fullWell - bgMean : sim.fullWell;      // where a pixel clips, on this axis

    let yMin = 0, yMax = 0;
    for (let i = 0; i < W; i++) {
      let pos = 0, neg = 0;
      if (cal && !row.clip[i]) KEYS.forEach(k => { const v = val(k, i); if (v > 0) pos += v; else neg += v; });
      else if (!cal) { pos = Math.max(row.dark[i], row.raw[i]); neg = row.dark[i] + row.read[i]; }
      const mv = measured(i);
      yMax = Math.max(yMax, pos, mv, cal ? row.expSig[i] : 0);
      yMin = Math.min(yMin, neg, mv);
    }
    // Show the full-well level when the data come anywhere near it, and never scale far beyond it:
    // clipped pixels just run off the top.
    const nearWell = yMax >= 0.3 * fwLevel;
    if (nearWell) yMax = Math.max(Math.min(yMax, fwLevel * 1.22), opts.showFullWell ? fwLevel * 1.04 : 0);
    if (yMax - yMin <= 0) yMax = yMin + 1;
    const pad = (yMax - yMin) * 0.06;
    yMax += pad; if (yMin < 0) yMin -= pad;
    const sy = v => m.t + ph - (v - yMin) / (yMax - yMin) * ph;
    const bw = pw / W, gap = bw >= 4 ? 1 : 0;

    // Grid
    ctx.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;
    Charts.niceTicks(yMin, yMax, Math.max(2, Math.floor(ph / 40))).forEach(t => {
      const y = Math.round(sy(t)) + 0.5;
      ctx.strokeStyle = t === 0 ? col('--axis') : col('--grid');
      ctx.beginPath(); ctx.moveTo(m.l, y); ctx.lineTo(m.l + pw, y); ctx.stroke();
      ctx.fillStyle = col('--text-muted'); ctx.textAlign = 'right';
      ctx.fillText(Charts.fmtNum(t), m.l - 8, y);
    });

    ctx.save();
    ctx.beginPath(); ctx.rect(m.l, m.t, pw, ph); ctx.clip();

    // Columns
    const colors = {}; KEYS.forEach(k => colors[k] = col(COLOR_VARS[k]));
    const grey = col('--c-clipped');
    const rect = (x, a, b, c) => { ctx.fillStyle = c; const ya = sy(a), yb = sy(b); ctx.fillRect(x, Math.min(ya, yb), bw - gap, Math.abs(ya - yb)); };
    order.forEach((i, rank) => {
      const x = m.l + rank * bw;
      if (cal) {
        if (row.clip[i]) { rect(x, 0, row.raw[i] - bgMean, grey); return; }   // no usable value left
        let up = 0, down = 0;
        KEYS.forEach(k => {
          const v = val(k, i);
          if (v > 0) { rect(x, up, up + v, colors[k]); up += v; }
          else if (v < 0) { rect(x, down + v, down, colors[k]); down += v; }
        });
      } else {
        // Cumulative stack whose top is the pixel's value. Read noise is signed: a negative value is
        // drawn last, as a bite out of what lies beneath it. Anything above the full well is lost.
        const cap = row.clip[i] ? fwLevel : Infinity;
        const seg = (a, b, c) => { if (Math.min(a, b) < cap) rect(x, a, Math.min(b, cap), c); };
        const d = row.dark[i], r = row.read[i];
        seg(0, d, colors.dark);
        if (r > 0) seg(d, d + r, colors.read);
        let top = d + r;
        ['sky', 'tgt', 'star'].forEach(k => { seg(top, top + row[k][i], colors[k]); top += row[k][i]; });
        if (r < 0) seg(d + r, d, colors.read);
        if (row.clip[i]) rect(x, fwLevel, row.raw[i], grey);
      }
    });

    const step = (fn, color, width) => {
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = 'round';
      ctx.beginPath();
      order.forEach((i, rank) => {
        const x = m.l + rank * bw, y = sy(fn(i));
        // Joined steps along the cross-section; separate ticks once the pixels are re-ordered.
        if (rank === 0 || opts.sort !== 'pos') ctx.moveTo(x, y); else ctx.lineTo(x, y);
        ctx.lineTo(x + bw - (opts.sort !== 'pos' ? gap : 0), y);
      });
      ctx.stroke();
    };
    if (cal) step(i => row.expSig[i], col('--c-expected'), 2);
    step(measured, col('--text-primary'), 1.25);
    ctx.restore();

    // Full well of a single sub
    if (opts.showFullWell) {
      const label = 'Full well ' + Math.round(sim.fullWell).toLocaleString('en-US') + ' e⁻';
      ctx.fillStyle = col('--text-secondary'); ctx.textAlign = 'right';
      if (nearWell) {
        const y = Math.round(sy(fwLevel)) + 0.5;
        ctx.strokeStyle = col('--text-secondary'); ctx.lineWidth = 1;
        ctx.setLineDash([6, 4]);
        ctx.beginPath(); ctx.moveTo(m.l, y); ctx.lineTo(m.l + pw, y); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillText(label + (cal ? ' (less the background)' : ''), m.l + pw - 4, y - 8);
      } else {
        ctx.fillText(label + ' is far above this scale ↑', m.l + pw - 4, m.t + 8);
      }
    }

    // Star labels
    if (starLabels) {
      ctx.fillStyle = col('--text-secondary'); ctx.textAlign = 'center';
      sim.stars.forEach(st => ctx.fillText(st.name, m.l + (st.x + 0.5) * bw, 10));
    }

    // X axis
    ctx.fillStyle = col('--text-muted'); ctx.textAlign = 'center';
    const xl = opts.sort === 'pos' ? 'Position along the cross-section (pixels from centre)' : 'Pixels ranked by ' + opts.sortLabel + ' (rank, low → high)';
    if (opts.sort === 'pos') {
      for (let p = 0; p < W; p += 20) ctx.fillText(String(p - (W - 1) / 2), m.l + (p + 0.5) * bw, m.t + ph + 12);
    }
    ctx.fillStyle = col('--text-secondary');
    ctx.font = '12px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.fillText(xl, m.l + pw / 2, ch - 9);
    ctx.save();
    ctx.translate(12, m.t + ph / 2); ctx.rotate(-Math.PI / 2);
    ctx.fillText(opts.yLabel, 0, 0);
    ctx.restore();

    return { m, bw, order, pw, ph };
  }

  window.Sim = { W, H, STARS, KEYS, LABELS, COLOR_VARS, generate, stretcher, drawPatch, drawHist, drawSection,
    samplePixel, moments, measuredNoise, subSteps, extraFrame, drawDist, distDomain, drawNoiseVsSubs, drawPtc };
})();
