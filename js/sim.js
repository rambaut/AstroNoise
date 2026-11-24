/*
 * Monte-Carlo simulation of a small image patch containing a Gaussian target,
 * and canvas renderers for the patch and for its central row (the cross-section).
 */
(function () {
  'use strict';
  const W = 161, H = 81;
  const KEYS = ['dark', 'read', 'sky', 'tgt'];           // stacking order, bottom to top: target is always outermost
  const COLOR_VARS = { dark: '--c-dark', sky: '--c-sky', tgt: '--c-target', read: '--c-read' };
  const LABELS = { dark: 'Dark current', sky: 'Sky glow', tgt: 'Target', read: 'Read noise' };

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

  /**
   * One realisation of the mean of n subs. Returns the patch (total e- per sub)
   * and the per-component breakdown of the central row.
   */
  function field(c, t, n, sigmaPx, seed) {
    const R = rng(seed);
    const img = new Float32Array(W * H);
    const row = { dark: [], sky: [], tgt: [], read: [], total: [], expTgt: [] };
    const cx = (W - 1) / 2, cy = (H - 1) / 2;
    const muSky = c.r.sky * t * n, muDark = c.r.dark * t * n, sdRead = c.sen.rn * Math.sqrt(n);
    const profile = new Float64Array(W);
    for (let x = 0; x < W; x++) profile[x] = Math.exp(-((x - cx) * (x - cx)) / (2 * sigmaPx * sigmaPx));
    for (let y = 0; y < H; y++) {
      const fy = Math.exp(-((y - cy) * (y - cy)) / (2 * sigmaPx * sigmaPx));
      for (let x = 0; x < W; x++) {
        const muT = c.r.target * t * n * profile[x] * fy;
        if (y === cy) {
          const d = R.poisson(muDark) / n, s = R.poisson(muSky) / n, g = R.poisson(muT) / n, r = sdRead * R.normal() / n;
          row.dark.push(d); row.sky.push(s); row.tgt.push(g); row.read.push(r);
          row.total.push(d + s + g + r); row.expTgt.push(muT / n);
          img[y * W + x] = d + s + g + r;
        } else {
          img[y * W + x] = (R.poisson(muDark + muSky + muT) + sdRead * R.normal()) / n;
        }
      }
    }
    return { img, row };
  }

  function generate(c, s, seed) {
    const sigmaPx = Math.max(0.5, s.tgtFwhm / c.r.scale / 2.3548);
    const bg = (c.r.sky + c.r.dark) * s.sub;
    const peak = c.r.target * s.sub;
    const sd1 = Math.sqrt(bg + c.sen.rn * c.sen.rn);
    return {
      W, H, sigmaPx, bg, peak,
      expSky: c.r.sky * s.sub, expDark: c.r.dark * s.sub,
      single: Object.assign(field(c, s.sub, 1, sigmaPx, seed), { n: 1, sd: sd1 }),
      stack: Object.assign(field(c, s.sub, s.n, sigmaPx, seed + 7919), { n: s.n, sd: sd1 / Math.sqrt(s.n) })
    };
  }

  /** Greyscale render of a patch, stretched from just below the background to just above the peak. */
  function drawPatch(canvas, sim, f) {
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    const id = ctx.createImageData(W, H);
    const lo = sim.bg - 3 * f.sd;
    const hi = sim.bg + Math.max(sim.peak + 3 * f.sd, 5 * f.sd);
    for (let i = 0; i < W * H; i++) {
      const v = Math.max(0, Math.min(1, (f.img[i] - lo) / (hi - lo)));
      const g = Math.round(255 * Math.pow(v, 1 / 2.2));
      id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = g;
      id.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(id, 0, 0);
  }

  function sortOrder(row, key) {
    const idx = row.total.map((_, i) => i);
    if (key === 'pos') return idx;
    const arr = key === 'total' ? row.total : key === 'signal' ? row.expTgt : row[key];
    return idx.sort((a, b) => arr[a] - arr[b] || a - b);
  }

  /**
   * Draw the cross-section. opts: { view: 'raw' | 'cal', sort }
   * Returns geometry used for hover hit-testing.
   */
  function drawSection(canvas, sim, f, opts) {
    const css = getComputedStyle(canvas);
    const col = name => css.getPropertyValue(name).trim();
    const dpr = window.devicePixelRatio || 1;
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cw, ch);

    const m = { l: 66, r: 12, t: 10, b: 40 };
    const pw = cw - m.l - m.r, ph = ch - m.t - m.b;
    const row = f.row, order = sortOrder(row, opts.sort);
    const cal = opts.view === 'cal';
    const exp = { dark: () => sim.expDark, sky: () => sim.expSky, tgt: i => row.expTgt[i], read: () => 0 };
    // Value each component contributes to the column: raw electrons, or deviation from its expectation.
    const val = (k, i) => cal ? row[k][i] - exp[k](i) : row[k][i];
    const measured = i => cal ? row.total[i] - sim.expDark - sim.expSky : row.total[i];

    let yMin = 0, yMax = 0;
    for (let i = 0; i < W; i++) {
      let pos = 0, neg = 0;
      if (cal) KEYS.forEach(k => { const v = val(k, i); if (v > 0) pos += v; else neg += v; });
      else { pos = row.dark[i]; neg = row.dark[i] + row.read[i]; }
      const mv = measured(i);
      yMax = Math.max(yMax, pos, mv, cal ? row.expTgt[i] : 0);
      yMin = Math.min(yMin, neg, mv);
    }
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

    // Columns
    const colors = {}; KEYS.forEach(k => colors[k] = col(COLOR_VARS[k]));
    const rect = (x, a, b, c) => { ctx.fillStyle = c; const ya = sy(a), yb = sy(b); ctx.fillRect(x, Math.min(ya, yb), bw - gap, Math.abs(ya - yb)); };
    order.forEach((i, rank) => {
      const x = m.l + rank * bw;
      if (cal) {
        let up = 0, down = 0;
        KEYS.forEach(k => {
          const v = val(k, i);
          if (v > 0) { rect(x, up, up + v, colors[k]); up += v; }
          else if (v < 0) { rect(x, down + v, down, colors[k]); down += v; }
        });
      } else {
        // Cumulative stack whose top is the measured value. Read noise is signed:
        // a negative value is drawn last, as a bite out of what lies beneath it.
        const d = row.dark[i], r = row.read[i];
        rect(x, 0, d, colors.dark);
        if (r > 0) rect(x, d, d + r, colors.read);
        let top = d + r;
        ['sky', 'tgt'].forEach(k => { rect(x, top, top + row[k][i], colors[k]); top += row[k][i]; });
        if (r < 0) rect(x, d + r, d, colors.read);
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
    if (cal) step(i => row.expTgt[i], col('--c-expected'), 2);
    step(measured, col('--text-primary'), 1.25);

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

  window.Sim = { W, H, KEYS, LABELS, COLOR_VARS, generate, drawPatch, drawSection };
})();
