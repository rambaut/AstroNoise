/*
 * Minimal SVG line / stacked-area charts with a crosshair tooltip.
 * Colours are CSS custom properties so light and dark themes swap in one place.
 */
(function () {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const groups = {};

  function el(tag, attrs, parent, text) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }

  function niceTicks(min, max, count) {
    const span = max - min || 1;
    const raw = span / Math.max(1, count);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    const ticks = [];
    for (let v = Math.ceil(min / step - 1e-9) * step; v <= max + step * 1e-9; v += step) {
      ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    }
    return ticks;
  }

  function fmtNum(v) {
    const a = Math.abs(v);
    if (a === 0) return '0';
    if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M';
    if (a >= 1e4) return (v / 1e3).toFixed(0) + 'k';
    if (a >= 100) return v.toFixed(0);
    if (a >= 10) return v.toFixed(1).replace(/\.0$/, '');
    if (a >= 1) return v.toFixed(2).replace(/\.?0+$/, '');
    return v.toPrecision(2).replace(/\.?0+$/, '');
  }

  /**
   * cfg: {
   *   height, xLog, xDomain, yDomain, xTicks, xFmt, yFmt, xLabel, yLabel,
   *   series: [{ name, color, pts: [[x, y]], dash, ref }],   ref = recessive reference line
   *   stacked,            series values are shares that sum to 1
   *   markers: [{ x, label, strong }], point: { x, y }, endLabels, group, onPick
   * }
   */
  function draw(container, cfg) {
    const W = Math.max(220, container.clientWidth);
    const H = cfg.height || 200;
    const m = { l: cfg.yLabel ? 62 : 46, r: cfg.endLabels ? 96 : 14, t: cfg.markers && cfg.markers.some(k => k.label) ? 30 : 10, b: cfg.xLabel ? 42 : 26 };
    const pw = W - m.l - m.r, ph = H - m.t - m.b;
    const xFmt = cfg.xFmt || fmtNum, yFmt = cfg.yFmt || fmtNum;

    const [x0, x1] = cfg.xDomain;
    const lx = v => cfg.xLog ? Math.log10(v) : v;
    const sx = v => m.l + (lx(v) - lx(x0)) / (lx(x1) - lx(x0)) * pw;
    const ix = px => {
      const f = Math.max(0, Math.min(1, (px - m.l) / pw));
      const v = lx(x0) + f * (lx(x1) - lx(x0));
      return cfg.xLog ? Math.pow(10, v) : v;
    };

    let yMin = 0, yMax = 1;
    if (cfg.yDomain) [yMin, yMax] = cfg.yDomain;
    else if (!cfg.stacked) {
      yMax = 0;
      cfg.series.forEach(s => s.pts.forEach(p => { if (isFinite(p[1]) && p[1] > yMax) yMax = p[1]; }));
      if (cfg.point && cfg.point.y > yMax) yMax = cfg.point.y;
      yMax = yMax > 0 ? yMax * 1.08 : 1;
    }
    const yTicks = cfg.stacked ? [0, 0.25, 0.5, 0.75, 1] : niceTicks(yMin, yMax, Math.max(2, Math.floor(ph / 34)));
    if (!cfg.yDomain && !cfg.stacked) yMax = Math.max(yMax, yTicks[yTicks.length - 1]);
    const sy = v => m.t + ph - (v - yMin) / (yMax - yMin) * ph;

    container.innerHTML = '';
    container.classList.add('chart');
    const svg = el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': cfg.aria || '' }, container);

    // Grid and axes
    yTicks.forEach(t => {
      el('line', { x1: m.l, x2: m.l + pw, y1: sy(t), y2: sy(t), class: t === yMin ? 'axis' : 'grid' }, svg);
      el('text', { x: m.l - 8, y: sy(t) + 4, 'text-anchor': 'end', class: 'tick' }, svg, yFmt(t));
    });
    const xTicks = (cfg.xTicks || niceTicks(x0, x1, Math.max(2, Math.floor(pw / 80)))).filter(t => t >= x0 && t <= x1);
    let lastLabelX = -1e9;
    xTicks.forEach(t => {
      const x = sx(t);
      el('line', { x1: x, x2: x, y1: m.t + ph, y2: m.t + ph + 4, class: 'axis' }, svg);
      if (x - lastLabelX < 38) return;
      lastLabelX = x;
      el('text', { x, y: m.t + ph + 17, 'text-anchor': 'middle', class: 'tick' }, svg, xFmt(t));
    });
    if (cfg.yLabel) el('text', { x: 0, y: 0, transform: `translate(13,${m.t + ph / 2}) rotate(-90)`, 'text-anchor': 'middle', class: 'axis-label' }, svg, cfg.yLabel);
    if (cfg.xLabel) el('text', { x: m.l + pw / 2, y: H - 6, 'text-anchor': 'middle', class: 'axis-label' }, svg, cfg.xLabel);

    const clipId = 'clip' + Math.random().toString(36).slice(2);
    const cp = el('clipPath', { id: clipId }, el('defs', {}, svg));
    el('rect', { x: m.l, y: m.t - 2, width: pw, height: ph + 4 }, cp);
    const plot = el('g', { 'clip-path': `url(#${clipId})` }, svg);

    // Marks
    if (cfg.stacked) {
      const nPts = cfg.series[0].pts.length;
      const base = new Array(nPts).fill(0);
      cfg.series.forEach(s => {
        let top = '', bottom = '';
        let best = { h: 0, i: 0, mid: 0 };
        for (let i = 0; i < nPts; i++) {
          const x = sx(s.pts[i][0]), lo = base[i], hi = lo + s.pts[i][1];
          top += (i ? 'L' : 'M') + x.toFixed(1) + ',' + sy(hi).toFixed(1);
          bottom = 'L' + x.toFixed(1) + ',' + sy(lo).toFixed(1) + bottom;
          const h = sy(lo) - sy(hi);
          const edge = Math.min(x - m.l, m.l + pw - x);
          if (edge > s.name.length * 3.5 + 12 && h > best.h) best = { h, i, mid: (sy(lo) + sy(hi)) / 2, x };
          base[i] = hi;
        }
        el('path', { d: top + bottom + 'Z', class: 'area', style: `fill:var(${s.color})` }, plot);
        s._label = best;
      });
      cfg.series.forEach(s => {
        if (s._label.h > 22) {
          el('text', { x: s._label.x, y: s._label.mid + 4, 'text-anchor': 'middle', class: 'band-label' + (s.darkInk ? ' dark-ink' : '') }, plot, s.name);
        }
      });
    } else {
      cfg.series.forEach(s => {
        let d = '', pen = false;
        s.pts.forEach(p => {
          if (!isFinite(p[1])) { pen = false; return; }
          d += (pen ? 'L' : 'M') + sx(p[0]).toFixed(1) + ',' + sy(p[1]).toFixed(1);
          pen = true;
        });
        el('path', { d, class: 'line' + (s.ref ? ' ref' : ''), style: s.ref ? '' : `stroke:var(${s.color})` }, plot);
      });
    }

    // Vertical markers with labels in the top band
    const rows = [];
    (cfg.markers || []).filter(k => k.x >= x0 && k.x <= x1).forEach(k => {
      const x = sx(k.x);
      el('line', { x1: x, x2: x, y1: m.t, y2: m.t + ph, class: 'marker' + (k.strong ? ' strong' : '') }, svg);
      if (!k.label) return;
      const w = k.label.length * 6.2 + 8;
      const end = x + w > m.l + pw + m.r - 4;
      const span = end ? [x - w, x] : [x, x + w];
      let row = 0;
      while (rows[row] && rows[row].some(o => span[0] < o[1] && span[1] > o[0])) row++;
      (rows[row] = rows[row] || []).push(span);
      if (row > 1) return;
      el('text', { x: end ? x - 4 : x + 4, y: 11 + row * 13, 'text-anchor': end ? 'end' : 'start', class: 'marker-label' + (k.strong ? ' strong' : '') }, svg, k.label);
    });

    if (cfg.point && cfg.point.x >= x0 && cfg.point.x <= x1 && isFinite(cfg.point.y)) {
      el('circle', { cx: sx(cfg.point.x), cy: sy(cfg.point.y), r: 5, class: 'dot', style: `fill:var(${cfg.point.color || cfg.series[0].color})` }, svg);
    }

    if (cfg.endLabels) {
      const labels = cfg.series.map(s => {
        const p = s.pts.slice().reverse().find(q => isFinite(q[1]));
        return { s, y: p ? sy(p[1]) : NaN };
      }).filter(l => isFinite(l.y)).sort((a, b) => a.y - b.y);
      for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 14) labels[i].y = labels[i - 1].y + 14;
      const over = labels.length ? labels[labels.length - 1].y - (m.t + ph - 4) : 0;
      if (over > 0) labels.forEach(l => { l.y -= over; });
      labels.forEach(l => el('text', { x: m.l + pw + 8, y: l.y + 4, class: 'end-label' }, svg, l.s.short != null ? l.s.short : l.s.name));
    }

    // Hover layer
    const cross = el('line', { y1: m.t, y2: m.t + ph, class: 'crosshair', visibility: 'hidden' }, svg);
    const dots = cfg.stacked ? [] : cfg.series.map(s => el('circle', { r: 4, class: 'dot', visibility: 'hidden', style: s.ref ? '' : `fill:var(${s.color})` }, svg));
    const tip = document.createElement('div');
    tip.className = 'tooltip';
    tip.hidden = true;
    container.appendChild(tip);
    const xs = cfg.series[0].pts.map(p => p[0]);

    function nearest(xv) {
      let bi = 0, bd = Infinity;
      for (let i = 0; i < xs.length; i++) {
        const d = Math.abs(lx(xs[i]) - lx(xv));
        if (d < bd) { bd = d; bi = i; }
      }
      return bi;
    }
    function show(xv, withTip) {
      if (xv == null) {
        cross.setAttribute('visibility', 'hidden');
        dots.forEach(d => d.setAttribute('visibility', 'hidden'));
        tip.hidden = true;
        return;
      }
      const i = nearest(xv), x = sx(xs[i]);
      cross.setAttribute('x1', x); cross.setAttribute('x2', x);
      cross.setAttribute('visibility', 'visible');
      dots.forEach((d, k) => {
        const y = cfg.series[k].pts[i][1];
        d.setAttribute('visibility', isFinite(y) ? 'visible' : 'hidden');
        if (isFinite(y)) { d.setAttribute('cx', x); d.setAttribute('cy', sy(y)); }
      });
      if (!withTip) { tip.hidden = true; return; }
      const rowsHtml = cfg.series.map(s => {
        const y = s.pts[i][1];
        const val = !isFinite(y) ? '—' : cfg.stacked ? (y * 100).toFixed(y < 0.1 ? 1 : 0) + '%' : (cfg.tipFmt || yFmt)(y);
        const sw = s.ref ? '<i class="sw ref"></i>' : `<i class="sw" style="background:var(${s.color})"></i>`;
        return `<div class="row">${sw}<span>${s.name}</span><b>${val}</b></div>`;
      });
      if (cfg.stacked) rowsHtml.reverse();
      tip.innerHTML = `<div class="head">${(cfg.tipHead || xFmt)(xs[i])}</div>` + rowsHtml.join('');
      tip.hidden = false;
      const tw = tip.offsetWidth;
      tip.style.left = (x + 14 + tw > W ? x - 14 - tw : x + 14) + 'px';
      tip.style.top = m.t + 4 + 'px';
    }

    const inst = { show };
    if (cfg.group) (groups[cfg.group] = (groups[cfg.group] || []).filter(g => g.c !== container)).push({ c: container, inst });
    const peers = () => cfg.group ? groups[cfg.group].filter(g => g.c !== container && g.c.isConnected) : [];

    const hit = el('rect', { x: m.l, y: m.t, width: pw, height: ph, class: 'hit' + (cfg.onPick ? ' pick' : '') }, svg);
    hit.addEventListener('pointermove', e => {
      const xv = ix(e.clientX - svg.getBoundingClientRect().left);
      show(xv, true);
      peers().forEach(p => p.inst.show(xv, false));
    });
    hit.addEventListener('pointerleave', () => { show(null); peers().forEach(p => p.inst.show(null)); });
    if (cfg.onPick) hit.addEventListener('click', e => cfg.onPick(ix(e.clientX - svg.getBoundingClientRect().left)));
    return inst;
  }

  window.Charts = { draw, niceTicks, fmtNum };
})();
