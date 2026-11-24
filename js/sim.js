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
    return { normal, poisson };
  }

  // Optional field stars, placed along the middle row so they appear in the cross-section.
  const STARS = [8, 10, 12, 14, 16, 18].map((mag, k) => ({ mag, x: 12 + k * 27, name: 'mag ' + mag }));

  function erf(x) {
    const s = x < 0 ? -1 : 1, a = Math.abs(x), t = 1 / (1 + 0.3275911 * a);
    return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a));
  }

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
    const sdRead = (n === 1 ? c.sen.rnAnalog : c.sen.rn) * Math.sqrt(n);
    const step = c.sen.eAdu / n;
    const digitise = v => Math.round(v / step) * step;
    const profile = new Float64Array(W);
    for (let x = 0; x < W; x++) profile[x] = Math.exp(-((x - cx) * (x - cx)) / (2 * sigmaPx * sigmaPx));
    for (let y = 0; y < H; y++) {
      const fy = Math.exp(-((y - cy) * (y - cy)) / (2 * sigmaPx * sigmaPx));
      for (let x = 0; x < W; x++) {
        const muT = c.r.target * t * n * profile[x] * fy;
        const muS = stars ? stars[y * W + x] * t * n : 0;
        if (y === cy) {
          const d = R.poisson(muDark) / n, s = R.poisson(muSky) / n, g = R.poisson(muT) / n;
          const p = muS > 0 ? R.poisson(muS) / n : 0;
          const raw = digitise(d + s + g + p + sdRead * R.normal() / n);
          const r = raw - (d + s + g + p);                    // read noise including the rounding error
          row.dark.push(d); row.sky.push(s); row.tgt.push(g); row.star.push(p); row.read.push(r);
          row.raw.push(raw); row.total.push(Math.min(raw, fw)); row.clip.push(raw > fw);
          row.expTgt.push(muT / n); row.expStar.push(muS / n); row.expSig.push((muT + muS) / n);
          img[y * W + x] = Math.min(raw, fw);
        } else {
          img[y * W + x] = Math.min(digitise((R.poisson(muDark + muSky + muT + muS) + sdRead * R.normal()) / n), fw);
        }
      }
    }
    row.anyClip = row.clip.some(Boolean);
    return { img, row, step };
  }

  function generate(c, s, seed) {
    const sigmaPx = Math.max(0.5, s.tgtFwhm / c.r.scale / 2.3548);
    const bg = (c.r.sky + c.r.dark) * s.sub;
    const peak = c.r.target * s.sub;
    const sd1 = Math.sqrt(bg + c.sen.rn * c.sen.rn);
    const stars = s.simStars ? starMap(c, s) : null;
    return {
      W, H, sigmaPx, bg, peak, fullWell: c.sen.fullWell, stars: s.simStars ? STARS : [],
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
      const v = st ? st(f.img[i]) : Math.pow(Math.max(0, Math.min(1, (f.img[i] - lo) / (hi - lo))), 1 / 2.2);
      const g = Math.round(255 * v);
      id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = g;
      id.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(id, 0, 0);
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

  window.Sim = { W, H, STARS, KEYS, LABELS, COLOR_VARS, generate, stretcher, drawPatch, drawSection };
})();
