/*
 * Signal / noise model for deep-sky imaging with a CMOS camera.
 * Everything is in electrons per pixel unless stated otherwise.
 */
(function () {
  'use strict';

  // Photon flux of a magnitude-0 source in V: photons / s / m^2 / nm.
  const F0 = 1.0e8;
  // Bandwidth used to turn a V-equivalent surface brightness into an emission-line flux (nm).
  const V_BAND_NM = 88;

  // Typical zenith sky brightness (mag/arcsec^2) for Bortle classes 1-9.
  const BORTLE_SQM = [22.0, 21.9, 21.6, 21.1, 20.3, 19.3, 18.7, 18.2, 17.5];

  const FILTERS = [
    { id: 'L', name: 'Luminance / UV-IR cut', bw: 300 },
    { id: 'RGB', name: 'R, G or B filter', bw: 100 },
    { id: 'NB12', name: 'Narrowband 12 nm', bw: 12 },
    { id: 'NB7', name: 'Narrowband 7 nm', bw: 7 },
    { id: 'NB3', name: 'Narrowband 3 nm', bw: 3 }
  ];
  // A Bayer matrix limits each pixel of a colour camera to roughly one colour band.
  const OSC_MAX_BW = 100;

  function interp(table, x) {
    if (x <= table[0][0]) return table[0][1];
    for (let i = 1; i < table.length; i++) {
      if (x <= table[i][0]) {
        const [x0, y0] = table[i - 1], [x1, y1] = table[i];
        return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
      }
    }
    return table[table.length - 1][1];
  }

  /** Gain-dependent sensor properties. cam = {bits, fw, rn (curve), rnOverride} */
  function sensorAtGain(cam, gain) {
    const levels = Math.pow(2, cam.bits);
    const eAdu0 = cam.fw / levels;
    const eAdu = eAdu0 * Math.pow(10, -gain / 200);          // ZWO gain unit = 0.1 dB
    const fullWell = Math.min(cam.fw, eAdu * (levels - 1));
    const rnAnalog = cam.rnOverride > 0 ? cam.rnOverride : interp(cam.rn, gain);
    const quant = eAdu / Math.sqrt(12);                       // quantisation noise
    const rn = Math.sqrt(rnAnalog * rnAnalog + quant * quant);
    return {
      eAdu, fullWell, rnAnalog, quant, rn,
      dr: Math.log2(fullWell / rn),
      unityGain: 200 * Math.log10(eAdu0)
    };
  }

  function skyBrightness(s) {
    return s.skyMode === 'sqm' ? s.sqm : BORTLE_SQM[Math.max(1, Math.min(9, Math.round(s.bortle))) - 1];
  }

  /** Session wall-clock time for n subs of t seconds. */
  function sessionTime(s, n, t) {
    return n * (t + s.ditherTime);       // ditherTime is the average dither + settle overhead per sub
  }

  /** Largest number of subs of length t that fit into a session of T seconds. */
  function subsInSession(s, T, t) {
    return Math.max(1, Math.floor(T / (t + s.ditherTime) + 1e-6));
  }

  /** Rates that do not depend on sub length or number of subs. */
  function rates(s) {
    const aperture = s.fl / s.fr;                                         // mm
    const area = Math.PI / 4 * Math.pow(aperture / 1000, 2) * (1 - Math.pow(s.obs / 100, 2)); // m^2
    const scale = 206.265 * s.pix / s.fl;                                 // arcsec / pixel
    const pixArea = scale * scale;
    const filter = FILTERS.find(f => f.id === s.filter) || FILTERS[0];
    const bw = s.mono ? filter.bw : Math.min(filter.bw, OSC_MAX_BW);
    const mu = skyBrightness(s);
    const perMag0 = F0 * area * pixArea * s.qe * (s.thr / 100);           // e-/s/px/nm for mag 0 per arcsec^2
    const sky = perMag0 * Math.pow(10, -0.4 * mu) * bw;
    const tgtBw = s.tgtType === 'line' ? V_BAND_NM : bw;
    const target = perMag0 * Math.pow(10, -0.4 * s.tgtMag) * tgtBw;       // at the peak of the Gaussian
    const dark = s.dark0 * Math.pow(2, s.temp / s.darkDouble);
    const star0 = F0 * area * s.qe * (s.thr / 100) * bw;                 // e-/s from a magnitude-0 star
    return { aperture, area, scale, pixArea, bw, mu, sky, target, dark, star0 };
  }

  /** Per-sub and stacked statistics at one pixel receiving `targetRate` e-/s. */
  function stats(r, sen, t, n, targetRate) {
    const S = targetRate * t, B = r.sky * t, D = r.dark * t;
    const varRead = sen.rn * sen.rn;
    const variance = S + B + D + varRead;
    const bgVar = B + D + varRead;
    const snrSub = S / Math.sqrt(variance);
    const headroom = sen.fullWell - B - D;
    const drSub = headroom > 0 ? Math.max(0, Math.log2(headroom / Math.sqrt(bgVar))) : 0;
    return {
      S, B, D, varRead, variance, bgVar,
      snrSub, snr: snrSub * Math.sqrt(n),
      drSub, drStack: headroom > 0 ? drSub + 0.5 * Math.log2(n) : 0,
      wellFill: (S + B + D) / sen.fullWell,
      saturated: S + B + D >= sen.fullWell
    };
  }

  function compute(s) {
    const r = rates(s);
    const sen = sensorAtGain(s, s.gain);
    const st = stats(r, sen, s.sub, s.n, r.target);
    const integration = s.sub * s.n;
    const session = sessionTime(s, s.n, s.sub);
    // Sub length at which read noise raises the background noise by `swamp` percent.
    const k = 1 / (Math.pow(1 + s.swamp / 100, 2) - 1);
    const tSkyLimited = k * sen.rn * sen.rn / (r.sky + r.dark);
    // SNR an ideal camera (no read noise, dark current or overhead) reaches in the same wall-clock time.
    const snrIdeal = r.target * Math.sqrt(session) / Math.sqrt(r.target + r.sky);
    return {
      r, sen, st, integration, session,
      efficiency: integration / session,
      tSkyLimited, snrIdeal,
      tSaturate: sen.fullWell / (r.target + r.sky + r.dark),
      fov: [s.res[0] * r.scale / 3600, s.res[1] * r.scale / 3600]
    };
  }

  /** Error function: rational approximation 7.1.26 of Abramowitz & Stegun. */
  function erf(x) {
    const s = x < 0 ? -1 : 1, a = Math.abs(x), t = 1 / (1 + 0.3275911 * a);
    return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a));
  }

  /** Share of a star's light that lands in its central pixel (Gaussian seeing disc centred on the pixel). */
  function starPeakFraction(s, r) {
    const sigma = Math.max(0.35, s.seeing / r.scale / 2.3548);
    const e = erf(0.5 / (Math.SQRT2 * sigma));
    return e * e;
  }

  /**
   * Expected share of subs that survive. Sub-ruining events (gusts, guiding excursions, cloud) are
   * taken as random, on average `lossTime` minutes apart; one event during a sub loses it.
   */
  function keptFraction(s, t) {
    return s.lossOn && s.lossTime > 0 ? Math.exp(-t / (s.lossTime * 60)) : 1;
  }

  // Practical sub lengths considered by the recommendation (s).
  const REC_SUBS = [1, 2, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 300, 450, 600, 900, 1200, 1800];

  /**
   * Best sub length and gain for each filter, for a fixed total (integration if the session is planned
   * by exposure time, wall-clock time otherwise). Maximises the expected stack SNR at the target peak,
   * snrSub * sqrt(n * keptFraction), subject to the headroom limits that are switched on. Plans within
   * 1% of the best SNR are treated as ties and settled in favour of dynamic range.
   */
  function recommend(s) {
    const fixedInt = s.plan === 'int';
    const total = fixedInt ? s.totalInt * 3600 : sessionTime(s, s.n, s.sub);
    const gains = [];
    for (let g = 0; g <= s.gainMax; g += 10) gains.push(g);
    [s.hcg, Math.round(sensorAtGain(s, 0).unityGain)].forEach(g => { if (g > 0 && g < s.gainMax && !gains.includes(g)) gains.push(g); });
    gains.sort((a, b) => a - b);
    const sensors = gains.map(g => sensorAtGain(s, g));
    const subsFor = t => fixedInt ? Math.round(total / t) : Math.floor(total / (t + s.ditherTime) + 1e-6);

    // One candidate plan, or null when it is not allowed. `r` are the rates for the filter in use.
    function evaluate(r, frac, sen, t, n, limits) {
      if (n < 1) return null;
      const st = stats(r, sen, t, n, r.target);
      if (st.saturated) return null;
      const perMag0 = r.star0 * t * frac;                               // peak-pixel electrons from a mag-0 star
      const satStarMag = -2.5 * Math.log10((sen.fullWell - st.B - st.D) / perMag0);
      const starOk = !s.recStarOn || satStarMag <= s.recStarMag;
      const drOk = !s.recDrOn || st.drSub >= s.recDrMin;
      if (limits && !(starOk && drOk)) return { rejected: true, starOk, drOk, drSub: st.drSub, satStarMag };
      const kept = keptFraction(s, t);
      return { t, n, snr: st.snr * Math.sqrt(kept), snrNoLoss: st.snr, lost: 1 - kept, drSub: st.drSub, drStack: st.drStack, satStarMag, starOk, drOk };
    }

    const filters = FILTERS.map(f => {
      const r = rates(Object.assign({}, s, { filter: f.id }));
      const frac = starPeakFraction(s, r);
      let best = null, anyStar = false, maxDr = -Infinity, minStar = Infinity;
      const passing = [];
      const byGain = gains.map((g, gi) => REC_SUBS.map(t => {
        const c = evaluate(r, frac, sensors[gi], t, subsFor(t), true);
        if (!c) return null;
        if (c.starOk) { anyStar = true; maxDr = Math.max(maxDr, c.drSub); }
        minStar = Math.min(minStar, c.satStarMag);
        if (c.rejected) return null;
        c.gain = g;
        passing.push(c);
        return c;
      }));
      // SNR is often almost flat in gain, so among plans within 1% of the best SNR take the one
      // with the most single-sub dynamic range.
      const top = passing.reduce((m, c) => Math.max(m, c.snr), 0);
      passing.forEach(c => { if (c.snr >= 0.99 * top && (!best || c.drSub > best.drSub)) best = c; });
      if (!best) {
        const reason = !isFinite(minStar) ? 'The target itself fills the well, or the session is shorter than one sub.'
          : !anyStar ? `A magnitude ${s.recStarMag} star saturates in every plan; the brightest that can be kept is about magnitude ${minStar.toFixed(1)}.`
          : `No plan reaches ${s.recDrMin} stops of single-sub dynamic range; the most available is ${maxDr.toFixed(1)}.`;
        return { id: f.id, name: f.name, bw: r.bw, best: null, reason };
      }
      // The optimum is flat: report the span of sub lengths within 2% of the best at the chosen gain.
      const near = byGain[gains.indexOf(best.gain)].filter(c => c && c.snr >= 0.98 * best.snr).map(c => c.t);
      best.tRange = [Math.min.apply(null, near), Math.max.apply(null, near)];
      return { id: f.id, name: f.name, bw: r.bw, best };
    });

    const r0 = rates(s);
    const current = evaluate(r0, starPeakFraction(s, r0), sensorAtGain(s, s.gain), s.sub, s.n, false);
    const ok = filters.filter(f => f.best);
    return {
      fixedInt, total, filters,
      current,                                                           // null when the current plan saturates
      mine: filters.find(f => f.id === s.filter) || filters[0],
      top: ok.length ? ok.reduce((a, b) => b.best.snr > a.best.snr ? b : a) : null
    };
  }

  window.Model = {
    erf, starPeakFraction, keptFraction, recommend,
    FILTERS, BORTLE_SQM, OSC_MAX_BW,
    interp, sensorAtGain, skyBrightness, sessionTime, subsInSession, rates, stats, compute
  };
})();
