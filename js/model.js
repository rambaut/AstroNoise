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
    return { aperture, area, scale, pixArea, bw, mu, sky, target, dark };
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

  window.Model = {
    FILTERS, BORTLE_SQM, OSC_MAX_BW,
    interp, sensorAtGain, skyBrightness, sessionTime, subsInSession, rates, stats, compute
  };
})();
