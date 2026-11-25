/* State, controls and rendering for the AstroNoise dashboard. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const STORE = 'astronoise.state.v2';

  // Width of the simulated target (Gaussian FWHM, arcseconds). Fixed: it only sets the scale of the picture.
  const TGT_FWHM = 100;
  // Common targets: [id, name, peak surface brightness (V-equivalent mag/arcsec^2), spectrum].
  // Approximate, representative values for the named part of each object.
  const TARGETS = [
    ['m42', 'M42 Orion Nebula, core', 17.0, 'line'],
    ['m57', 'M57 Ring Nebula', 18.5, 'line'],
    ['m27', 'M27 Dumbbell Nebula', 20.5, 'line'],
    ['m8', 'M8 Lagoon Nebula', 21.0, 'line'],
    ['ngc2244', 'Rosette Nebula', 22.5, 'line'],
    ['ngc7000', 'NGC 7000 North America Nebula', 23.0, 'line'],
    ['ic434', 'IC 434 behind the Horsehead', 23.5, 'line'],
    ['veil', 'Veil Nebula filaments', 24.0, 'line'],
    ['sh2', 'Faint Sharpless emission nebula', 25.5, 'line'],
    ['m13', 'M13 globular cluster, core', 17.5, 'cont'],
    ['m31core', 'M31 Andromeda Galaxy, core', 17.0, 'cont'],
    ['m31disc', 'M31 Andromeda Galaxy, outer disc', 22.5, 'cont'],
    ['m51', 'M51 Whirlpool Galaxy, arms', 21.0, 'cont'],
    ['m81', 'M81 Bode\'s Galaxy, arms', 22.0, 'cont'],
    ['m33', 'M33 Triangulum Galaxy, disc', 22.5, 'cont'],
    ['m101', 'M101 Pinwheel Galaxy, outer arms', 23.0, 'cont'],
    ['m45', 'M45 Pleiades reflection nebula', 22.0, 'cont'],
    ['iris', 'NGC 7023 Iris Nebula, outer dust', 24.0, 'cont'],
    ['dark', 'Dark nebula dust (e.g. LDN 1235)', 25.5, 'cont'],
    ['ifn', 'Integrated flux nebula', 26.5, 'cont'],
    ['tidal', 'Galaxy tidal stream', 27.5, 'cont']
  ];
  const TYPE_NAMES = { line: 'Emission nebulae', cont: 'Galaxies, clusters and dust' };

  const DEFAULTS = {
    fl: 500, fr: 5, obs: 0, thr: 85,
    camId: 'asi2600mm', pix: 3.76, qe: 91, bits: 16, fw: 50000, dark0: 0.003, darkDouble: 6, rnOverride: 0,
    gain: 100, temp: -10,
    skyMode: 'bortle', bortle: 5, sqm: 20.3, filter: 'L',
    tgtId: 'm101', tgtMag: 23, tgtFwhm: 100, tgtType: 'cont',
    sub: 120, plan: 'n', n: 60, totalInt: 2, totalSession: 2.17,
    ditherTime: 10, swamp: 5,
    simFrame: 'single', simView: 'raw', simSort: 'pos', simStars: false, simHistZoom: false, simHistLog: false, seeing: 2.5
  };

  let state = Object.assign({}, DEFAULTS);
  try { Object.assign(state, JSON.parse(localStorage.getItem(STORE) || '{}')); } catch (e) { /* ignore */ }
  // Settings can also be passed in the URL, e.g. index.html#sub=300&n=24&camId=asi533mc&theme=dark
  new URLSearchParams(location.hash.slice(1)).forEach((v, k) => {
    if (k === 'theme' && (v === 'dark' || v === 'light')) document.documentElement.dataset.theme = v;
    else if (typeof DEFAULTS[k] === 'boolean') state[k] = v === 'true' || v === '1';
    else if (k in DEFAULTS) state[k] = typeof DEFAULTS[k] === 'number' ? (isFinite(parseFloat(v)) ? parseFloat(v) : state[k]) : v;
  });
  state.tgtFwhm = TGT_FWHM;
  // A stored or URL-supplied brightness that no longer matches the named target makes it a custom one.
  (function () {
    const t = TARGETS.find(x => x[0] === state.tgtId);
    const h = new URLSearchParams(location.hash.slice(1));
    // A target named in the URL sets its own brightness and spectrum unless the URL gives those too.
    if (t && h.has('tgtId')) { if (!h.has('tgtMag')) state.tgtMag = t[2]; if (!h.has('tgtType')) state.tgtType = t[3]; }
    if (!t || t[2] !== state.tgtMag || t[3] !== state.tgtType) state.tgtId = 'custom';
  })();
  let seed = 12345;
  const N_MAX = 1000000;

  const camera = () => CAMERAS.find(c => c.id === state.camId) || CAMERAS[0];
  /** Model parameters: UI state plus the fixed properties of the selected camera. */
  function params() {
    const cam = camera();
    return Object.assign({}, state, { qe: state.qe / 100, rn: cam.rn, mono: cam.mono, res: cam.res });
  }

  // ---------- formatting ----------
  const trim = s => s.replace(/\.0+$/, '');
  function fmtDur(s) {
    if (!isFinite(s)) return '—';
    if (s < 1) return Math.round(s * 1000) + ' ms';
    if (s < 60) return trim(s.toFixed(s < 10 ? 1 : 0)) + ' s';
    if (s < 3600) { const m = s / 60; return trim(m.toFixed(m < 10 ? 1 : 0)) + ' min'; }
    let h = Math.floor(s / 3600), m = Math.round((s - h * 3600) / 60);
    if (m === 60) { h++; m = 0; }
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  function fmtE(v) {
    const a = Math.abs(v);
    if (a === 0) return '0';
    if (a >= 100) return Math.round(v).toLocaleString('en-US');
    if (a >= 10) return v.toFixed(1);
    if (a >= 0.1) return v.toFixed(2);
    return v.toPrecision(2);
  }
  const fmtSigned = v => (v >= 0 ? '+' : '−') + fmtE(Math.abs(v));
  const fmtSub = t => t < 60 ? trim(String(+t.toPrecision(3))) + ' s' : trim((t / 60).toFixed(1)) + ' min';
  const SUB_AXIS = 'Sub-exposure length (seconds or minutes, log scale)';
  const SUB_TICKS = [0.1, 0.3, 1, 3, 10, 30, 60, 120, 300, 600, 1800];

  // ---------- explanations shown by the "i" buttons ----------
  const INFO = {
    sim: `<h4>Simulated pixels</h4>
      <p>One random realisation of a small patch of sky containing a Gaussian target. The chart shows the middle row of the patch (marked by the ticks beside each image), one column per pixel.</p>
      <p><b>Raw electrons.</b> Each column is stacked, from the bottom: dark current, read noise, sky glow, target, then any star light. The top of the column, traced by the black line, is the value the camera records. Read noise includes the rounding to whole ADU and can be negative, in which case it is drawn as a bite out of what lies beneath it.</p>
      <p><b>Noise after sky subtraction.</b> The expected (mean) sky glow and dark current are subtracted from every pixel — the same constant everywhere. What is left of each source is its random departure from its mean, positive or negative: sky shot noise, dark shot noise, target shot noise and read noise. The black line is the background-subtracted pixel value, which scatters around the pink expected-signal curve. This is a perfect subtraction; real background estimates and dark frames add a little noise of their own.</p>
      <p><b>Stretched.</b> What the data look like after a non-linear screen stretch, on a scale where 0 is black and 1 is the full well. The black point is set just below the background and a midtones curve lifts the background to a quarter of the range, so the faintest values are spread out the most. That is where the camera's digitisation shows: each pixel is recorded as a whole number of ADU, and when those steps are large compared with the noise (low gain, a 12-bit ADC, short subs) the values fall onto a few visible levels, drawn as faint lines. Pixels at 1.0 are clipped. The mean of N subs can take values 1/N of an ADU apart, which is why stacking smooths the posterisation away. The two images use the same stretch in this mode.</p>
      <p><b>Full well.</b> For a single sub, the dashed line marks the full well at the current gain. A pixel cannot record more than this: anything above it is drawn grey and lost. The mean of many subs has no full well of its own, but a pixel that clips in the subs is still clipped in their mean.</p>
      <p><b>Stars.</b> Adds six stars, of magnitude 8 to 18 in steps of two, along the middle row. Each is a Gaussian disc whose width is the seeing set in the Sky panel. They show how quickly bright stars clip compared with the faint target.</p>
      <p><b>Frame.</b> A single sub, or the mean of all the subs in the plan: averaging N subs shrinks every noise term by √N while the signal stays put.</p>
      <p><b>Sort.</b> Re-orders the pixels by one source so its distribution can be compared with the others.</p>
      <p>The two images are stretched from just below the background to just above the target peak.</p>
      <p><b>Histogram.</b> Below the two image patches is a histogram of image brightness: the number of pixels (log scale) at each brightness from 0 to 1, for the single sub and for the stack. Brightness is the pixel value as a fraction of full well, or the stretched value in the Stretched view. Pixels clipped to black pile up at 0 and saturated pixels at 1. Unstretched deep-sky data sits in a thin spike near 0, which is why images need stretching. <b>Zoom</b> narrows the axis to the range of values actually present, without changing the values. <b>Log</b> puts brightness on a logarithmic scale, which spreads out the faint end; pixels at exactly zero cannot be shown on it and are left out. Gaps or a comb pattern show the ADC's discrete levels.</p>`,
    tradeoff: `<h4>Sub-exposure trade-off</h4>
      <p>The total wall-clock time is held at its current value while the sub length varies, so longer subs mean fewer of them.</p>
      <p><b>Stack SNR.</b> Signal ÷ noise at the target peak after stacking. Short subs lose out twice: read noise is paid once per sub, and each sub costs dither and settle time. The grey line is an ideal camera with no read noise, dark current or overhead. The curve stops at the "Well full" marker: in longer subs the target peak, with the sky and dark current under it, fills the well, so the pixel is clipped and has no meaningful SNR.</p>
      <p><b>Sky-limited marker.</b> The sub length at which read noise raises the background noise by the allowed penalty (5% by default, set in the Sky panel). Beyond it, longer subs gain very little.</p>
      <p><b>Dynamic range.</b> log₂ of the headroom left above the background (full well − sky − dark) divided by the background noise. Stacking N subs adds ½·log₂N stops. Longer subs fill the well with sky and so lose headroom: bright stars clip sooner.</p>
      <p><b>Share of variance.</b> Noise sources add as variances (σ²), so this shows how much of each sub's noise each source is responsible for.</p>
      <p>Click any of the three charts to set the sub length.</p>`,
    time: `<h4>SNR as the session goes on</h4>
      <p>Stack SNR at the target peak against wall-clock time for the current sub length. SNR grows with the square root of time: four times the time for twice the SNR.</p>
      <p>The grey line is an ideal camera with no read noise, no dark current and no time lost between subs — the limit set by the sky and the target's own photon noise. The gap between the lines is what read noise, dark current and overhead cost you.</p>`,
    budget: `<h4>Noise budget for one sub</h4>
      <p>Electrons collected by the pixel at the target peak in one sub, and the noise each source contributes.</p>
      <p>Photon arrival and dark current follow Poisson statistics, so their noise is the square root of their mean count. Read noise is added once per sub, whatever its length.</p>
      <p>Independent noise sources add in quadrature: total² = target + sky + dark + read². "Share of variance" is each term's fraction of that sum.</p>
      <p>SNR = target ÷ total noise. Averaging N subs divides the noise by √N.</p>`,
    gain: `<h4>Gain</h4>
      <p>ZWO gain settings are in units of 0.1 dB: every 60 units halves the number of electrons per ADU, and with it the full well.</p>
      <p><b>Read noise</b> falls as gain rises, with a sharp drop where the sensor switches to high conversion gain (HCG), if it has that mode. The curve includes quantisation noise from the ADC (e⁻/ADU ÷ √12), which matters at low gain on 12-bit cameras.</p>
      <p><b>Sensor dynamic range</b> is log₂(full well ÷ read noise) for a single frame with no sky.</p>
      <p><b>Stack SNR</b> uses the current exposure plan. If it is flat, the subs are already sky-limited and extra gain only costs full well. The curve stops at the "Well full" marker, the gain at which the shrinking full well is filled by the target peak in a single sub.</p>
      <p>Click any chart to set the gain.</p>`,
    exposure: `<h4>Exposure</h4>
      <p>Choose the sub length, then plan the session by number of subs, total exposure time or total wall-clock time. The other two are calculated.</p>
      <p>Wall-clock time = number of subs × (sub length + dither and settle time). Enter the dither time as an average per sub: dithering for 30 s every third frame is 10 s.</p>
      <p>Sensor temperature sets the dark current, which doubles for every few degrees of warming (6 °C by default, set in the Camera panel).</p>`,
    telescope: `<h4>Telescope</h4>
      <p>Aperture = focal length ÷ focal ratio. Pixel scale = 206.265 × pixel size (µm) ÷ focal length (mm), in arcseconds per pixel.</p>
      <p>For extended objects and sky glow, the electrons per pixel depend on aperture area × the patch of sky each pixel sees, which works out as (pixel size ÷ focal ratio)². Focal length changes the image scale, not the per-pixel rate.</p>
      <p>Central obstruction is a percentage of the aperture diameter. Transmission covers mirrors, lenses and the filter's peak throughput.</p>`,
    camera: `<h4>Camera</h4>
      <p>Presets are approximate transcriptions of published ZWO specifications. Check them against the data sheet for your camera; every value here can be edited.</p>
      <p>Full well at gain 0 and the ADC bit depth set the electrons per ADU. The read-noise curve comes from the preset; enter an override to use a single value instead.</p>
      <p>Dark current is given at 0 °C and scaled to the sensor temperature using the doubling interval.</p>
      <p>Colour cameras are treated per pixel: the Bayer matrix limits each pixel to roughly a 100 nm band.</p>`,
    sky: `<h4>Sky</h4>
      <p>Sky brightness in magnitudes per square arcsecond, either from a Bortle class or a measured SQM reading. Typical zenith values used: Bortle 1 = 22.0, 2 = 21.9, 3 = 21.6, 4 = 21.1, 5 = 20.3, 6 = 19.3, 7 = 18.7, 8 = 18.2, 9 = 17.5.</p>
      <p>The sky is treated as a flat spectrum, so the sky electron rate scales with the filter bandwidth. Narrowband filters cut sky glow by the ratio of the bandwidths.</p>
      <p><b>Allowed read-noise penalty</b> defines "sky-limited": the sub length at which read noise adds this percentage to the background noise.</p>`,
    target: `<h4>Target</h4>
      <p>A Gaussian patch of light with the given peak surface brightness and a fixed width of ${TGT_FWHM}″ (full width at half maximum). All SNR figures refer to the pixel at its peak, so the width only changes how the simulated picture looks.</p>
      <p><b>Object</b> offers common targets with a representative peak surface brightness (in brackets, mag/″²) and spectrum. These are approximate figures for the named part of each object; real objects vary a great deal across their extent. Changing the brightness or spectrum by hand switches the object to Custom.</p>
      <p><b>Continuum</b> targets (galaxies, reflection nebulae, star clusters) emit across the spectrum, so a narrower filter passes proportionally less of their light.</p>
      <p><b>Emission-line</b> targets are given as the V-band-equivalent brightness of the line, and keep that flux through any filter that contains the line. This is why narrowband filters work so well on them under bright skies.</p>`
  };
  function infoButton(key, title) {
    return key ? `<button type="button" class="info" data-info="${key}" aria-label="About ${title}" aria-expanded="false">i</button>` : '';
  }
  function initInfo() {
    const pop = document.createElement('div');
    pop.id = 'info-pop'; pop.hidden = true; pop.setAttribute('role', 'dialog');
    document.body.appendChild(pop);
    let owner = null;
    const close = () => { if (owner) owner.setAttribute('aria-expanded', 'false'); owner = null; pop.hidden = true; };
    document.querySelectorAll('h2[data-info]').forEach(h => h.insertAdjacentHTML('beforeend', infoButton(h.dataset.info, h.textContent)));
    document.addEventListener('click', e => {
      const b = e.target.closest('button.info');
      if (!b) { if (!e.target.closest('#info-pop')) close(); return; }
      e.preventDefault();                                  // keep a <summary> from toggling its section
      if (owner === b) { close(); return; }
      close();
      owner = b; b.setAttribute('aria-expanded', 'true');
      pop.innerHTML = INFO[b.dataset.info];
      pop.hidden = false;
      const r = b.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
      const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left));
      const below = r.bottom + 8 + h <= window.innerHeight || r.top < h + 16;
      pop.style.left = left + window.scrollX + 'px';
      pop.style.top = (below ? r.bottom + 8 : r.top - h - 8) + window.scrollY + 'px';
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  }

  // ---------- controls ----------
  const SECTIONS = [
    { title: 'Exposure', info: 'exposure', open: true, readout: 'exp', readoutAfter: 'totalSession', fields: [
      { key: 'sub', label: 'Sub-exposure', unit: 's', kind: 'range', log: true, min: 0.1, max: 1800 },
      { key: 'plan', label: 'Plan the session by', kind: 'select',
        options: [['n', 'Number of subs'], ['int', 'Total exposure time'], ['session', 'Total wall-clock time']] },
      { key: 'n', label: 'Number of subs', kind: 'range', log: true, min: 1, max: 5000, int: true, showIf: s => s.plan === 'n' },
      { key: 'totalInt', label: 'Total exposure time', unit: 'h', kind: 'range', log: true, min: 0.01, max: 100, showIf: s => s.plan === 'int' },
      { key: 'totalSession', label: 'Total wall-clock time', unit: 'h', kind: 'range', log: true, min: 0.01, max: 100, showIf: s => s.plan === 'session' },
      { key: 'ditherTime', label: 'Dither and settle time', unit: 's', kind: 'number', min: 0, max: 300, step: 1,
        hint: 'Average time lost per sub between exposures.' },
      { key: 'gain', label: 'Gain', kind: 'range', min: 0, max: 700, step: 1, int: true },
      { key: 'temp', label: 'Sensor temperature', unit: '°C', kind: 'range', min: -30, max: 40, step: 1 }
    ] },
    { title: 'Telescope', info: 'telescope', open: true, readout: 'scope', fields: [
      { key: 'fl', label: 'Focal length', unit: 'mm', kind: 'number', min: 10, max: 10000, step: 10 },
      { key: 'fr', label: 'Focal ratio', unit: 'f/', kind: 'number', min: 0.9, max: 50, step: 0.1 },
      { key: 'obs', label: 'Central obstruction', unit: '% dia.', kind: 'number', min: 0, max: 70, step: 1 },
      { key: 'thr', label: 'Optics and filter transmission', unit: '%', kind: 'number', min: 5, max: 100, step: 1 }
    ] },
    { title: 'Camera', info: 'camera', open: true, readout: 'cam', fields: [
      { key: 'camId', label: 'Model', kind: 'select', options: CAMERAS.map(c => [c.id, `${c.name} — ${c.sensor}, ${c.mono ? 'mono' : 'colour'}`]) },
      { key: 'pix', label: 'Pixel size', unit: 'µm', kind: 'number', min: 0.5, max: 30, step: 0.01 },
      { key: 'qe', label: 'Peak QE', unit: '%', kind: 'number', min: 1, max: 100, step: 1 },
      { key: 'bits', label: 'ADC', unit: 'bits', kind: 'number', min: 8, max: 16, step: 1, int: true },
      { key: 'fw', label: 'Full well at gain 0', unit: 'e⁻', kind: 'number', min: 100, max: 500000, step: 100 },
      { key: 'dark0', label: 'Dark current at 0 °C', unit: 'e⁻/s', kind: 'number', min: 0, max: 100, step: 0.001 },
      { key: 'darkDouble', label: 'Dark current doubles every', unit: '°C', kind: 'number', min: 2, max: 15, step: 0.1 },
      { key: 'rnOverride', label: 'Read noise override', unit: 'e⁻', kind: 'number', min: 0, max: 50, step: 0.1,
        hint: '0 uses the preset read-noise curve for the selected gain.' }
    ] },
    { title: 'Sky', info: 'sky', open: true, readout: 'sky', fields: [
      { key: 'skyMode', label: 'Sky brightness from', kind: 'select', options: [['bortle', 'Bortle class'], ['sqm', 'Measured SQM value']] },
      { key: 'bortle', label: 'Bortle class', kind: 'range', min: 1, max: 9, step: 1, int: true, showIf: s => s.skyMode === 'bortle' },
      { key: 'sqm', label: 'Sky brightness', unit: 'mag/″²', kind: 'range', min: 16, max: 22.2, step: 0.05, showIf: s => s.skyMode === 'sqm' },
      { key: 'filter', label: 'Filter', kind: 'select', options: Model.FILTERS.map(f => [f.id, `${f.name} (${f.bw} nm)`]) },
      { key: 'seeing', label: 'Seeing (star FWHM)', unit: '″', kind: 'number', min: 0.5, max: 10, step: 0.1,
        hint: 'Sets the size of the stars in the simulated pixels.' },
      { key: 'swamp', label: 'Allowed read-noise penalty', unit: '%', kind: 'number', min: 1, max: 50, step: 1,
        hint: 'Sets the "sky-limited" sub length: the point where read noise adds this much to the sky background noise.' }
    ] },
    { title: 'Target', info: 'target', open: true, readout: 'tgt', fields: [
      { key: 'tgtId', label: 'Object', kind: 'select',
        groups: ['line', 'cont'].map(ty => [TYPE_NAMES[ty], TARGETS.filter(t => t[3] === ty).map(t => [t[0], `${t[1]} (${t[2].toFixed(1)})`])])
          .concat([['Other', [['custom', 'Custom']]]]),
        hint: 'Fills in the brightness and spectrum below. Values are approximate.' },
      { key: 'tgtMag', label: 'Peak surface brightness', unit: 'mag/″²', kind: 'range', min: 14, max: 28, step: 0.1 },
      { key: 'tgtType', label: 'Spectrum', kind: 'select',
        options: [['cont', 'Continuum (galaxy, reflection nebula)'], ['line', 'Emission line (Hα, OIII, SII)']],
        hint: 'A continuum target dims as the filter narrows. An emission-line target keeps its V-equivalent flux through any filter.' }
    ] }
  ];
  // Order of the panels in the sidebar.
  const PANEL_ORDER = ['Target', 'Exposure', 'Sky', 'Camera', 'Telescope'];
  SECTIONS.sort((x, y) => PANEL_ORDER.indexOf(x.title) - PANEL_ORDER.indexOf(y.title));
  const FIELDS = {};
  SECTIONS.forEach(sec => sec.fields.forEach(f => FIELDS[f.key] = f));

  const toPos = (f, v) => f.log ? 1000 * Math.log(v / f.min) / Math.log(f.max / f.min) : v;
  const fromPos = (f, p) => {
    if (!f.log) return p;
    const v = f.min * Math.pow(f.max / f.min, p / 1000);
    return f.int ? Math.round(v) : v >= 10 ? Math.round(v) : +v.toPrecision(2);
  };
  const shown = v => typeof v === 'number' ? +v.toPrecision(6) : v;

  function buildControls() {
    const root = $('controls');
    SECTIONS.forEach(sec => {
      const d = document.createElement('details');
      d.open = sec.open;
      d.innerHTML = `<summary><span>${sec.title}</span>${infoButton(sec.info, sec.title)}</summary>`;
      sec.fields.forEach(f => {
        const w = document.createElement('div');
        w.className = 'field'; w.id = 'w-' + f.key;
        let h = `<label for="f-${f.key}">${f.label}</label>`;
        if (f.kind === 'select') {
          const opts = list => list.map(o => `<option value="${o[0]}">${o[1]}</option>`).join('');
          h += `<select id="f-${f.key}">${f.groups ? f.groups.map(g => `<optgroup label="${g[0]}">${opts(g[1])}</optgroup>`).join('') : opts(f.options)}</select>`;
        } else {
          h += `<span class="num"><input type="number" id="f-${f.key}" min="${f.min}" max="${f.max}" step="${f.log ? 'any' : f.step}">${f.unit || ''}</span>`;
          if (f.kind === 'range') {
            h += f.log
              ? `<input type="range" id="r-${f.key}" min="0" max="1000" step="1" aria-label="${f.label}">`
              : `<input type="range" id="r-${f.key}" min="${f.min}" max="${f.max}" step="${f.step}" aria-label="${f.label}">`;
          }
        }
        if (f.hint) h += `<div class="hint">${f.hint}</div>`;
        w.innerHTML = h;
        d.appendChild(w);
        const input = w.querySelector('#f-' + f.key);
        input.addEventListener('change', () => set(f.key, f.kind === 'select' ? input.value : parseFloat(input.value)));
        const slider = w.querySelector('#r-' + f.key);
        if (slider) slider.addEventListener('input', () => set(f.key, fromPos(f, parseFloat(slider.value))));
      });
      if (sec.readout) {
        const r = document.createElement('div');
        r.className = 'readout'; r.id = 'ro-' + sec.readout;
        if (sec.readoutAfter) d.querySelector('#w-' + sec.readoutAfter).after(r);
        else d.appendChild(r);
      }
      root.appendChild(d);
    });
  }

  function syncControls() {
    const cam = camera();
    FIELDS.gain.max = cam.gainMax;
    for (const key in FIELDS) {
      const f = FIELDS[key], input = $('f-' + key), slider = $('r-' + key);
      if (f.showIf) $('w-' + key).hidden = !f.showIf(state);
      if (document.activeElement !== input || f.kind === 'select') input.value = f.kind !== 'select' && !f.int ? +state[key].toPrecision(4) : shown(state[key]);
      if (f.kind !== 'select') input.max = f.max;
      if (slider) {
        if (!f.log) slider.max = f.max;
        if (document.activeElement !== slider) slider.value = toPos(f, state[key]);
      }
    }
  }

  /** Derive the number of subs from the planned quantity, and keep the other totals in step. */
  function reconcile() {
    const per = state.sub + state.ditherTime;
    if (state.plan === 'int') state.n = Math.round(state.totalInt * 3600 / state.sub);
    else if (state.plan === 'session') state.n = Math.floor(state.totalSession * 3600 / per + 1e-6);
    state.n = Math.max(1, Math.min(N_MAX, state.n));
    if (state.plan !== 'int') state.totalInt = state.n * state.sub / 3600;
    if (state.plan !== 'session') state.totalSession = state.n * per / 3600;
  }

  // ---------- settings files ----------
  const CHOICES = { simFrame: ['single', 'stack'], simView: ['raw', 'cal', 'str'], simSort: ['pos', 'signal', 'tgt', 'star', 'sky', 'dark', 'read', 'total'] };

  /** Replace the state with settings read from a file. Unknown keys and invalid values are ignored. */
  function applySettings(data) {
    const src = data && typeof data === 'object' && data.settings && typeof data.settings === 'object' ? data.settings : data;
    if (!src || typeof src !== 'object' || Array.isArray(src)) throw new Error('This is not an AstroNoise settings file.');
    const next = Object.assign({}, DEFAULTS);
    let used = 0;
    for (const k in DEFAULTS) {
      if (!(k in src)) continue;
      const v = src[k], f = FIELDS[k];
      if (typeof v !== typeof DEFAULTS[k]) continue;
      if (typeof v === 'number') {
        if (!isFinite(v)) continue;
        next[k] = f && k !== 'gain' ? Math.max(f.min, Math.min(f.max, f.int ? Math.round(v) : v)) : v;
      } else if (typeof v === 'string') {
        const allowed = CHOICES[k] || (f && (f.groups ? [].concat(...f.groups.map(g => g[1])) : f.options).map(o => o[0]));
        if (allowed && !allowed.includes(v)) continue;
        next[k] = v;
      } else next[k] = v;
      used++;
    }
    if (!used) throw new Error('No AstroNoise settings were found in this file.');
    state = next;
    state.gain = Math.max(0, Math.min(camera().gainMax, Math.round(state.gain)));
    state.tgtFwhm = TGT_FWHM;
    const t = TARGETS.find(x => x[0] === state.tgtId);
    if (!t || t[2] !== state.tgtMag || t[3] !== state.tgtType) state.tgtId = 'custom';
    reconcile(); syncControls(); schedule();
  }

  function initSettingsFiles() {
    const saveDlg = $('save-dlg'), loadDlg = $('load-dlg'), name = $('save-name'), err = $('load-error'), drop = $('drop'), file = $('load-file');
    $('save-open').addEventListener('click', () => {
      name.value = 'astronoise-' + camera().id + '-' + new Date().toISOString().slice(0, 10);
      saveDlg.showModal(); name.select();
    });
    $('save-cancel').addEventListener('click', () => saveDlg.close());
    $('save-form').addEventListener('submit', () => {
      // Keep the name safe for any file system, and add the extension.
      const base = name.value.trim().replace(/\.json$/i, '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '-') || 'astronoise-settings';
      const body = JSON.stringify({ app: 'AstroNoise', version: 1, saved: new Date().toISOString(), settings: state }, null, 2);
      const url = URL.createObjectURL(new Blob([body + '\n'], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url; a.download = base + '.json';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });

    const fail = msg => { err.textContent = msg; err.hidden = false; };
    const read = f => {
      if (!f) return;
      err.hidden = true;
      const reader = new FileReader();
      reader.onerror = () => fail(`Could not read "${f.name}".`);
      reader.onload = () => {
        let data;
        try { data = JSON.parse(reader.result); } catch (e) { fail(`"${f.name}" is not a valid JSON file.`); return; }
        try { applySettings(data); loadDlg.close(); } catch (e) { fail(e.message); }
      };
      reader.readAsText(f);
    };
    $('load-open').addEventListener('click', () => { err.hidden = true; file.value = ''; loadDlg.showModal(); });
    $('load-cancel').addEventListener('click', () => loadDlg.close());
    $('load-pick').addEventListener('click', () => file.click());
    file.addEventListener('change', () => read(file.files[0]));
    ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', e => read(e.dataTransfer.files[0]));
    // A file dropped beside the zone must not navigate the browser away from the page.
    ['dragover', 'drop'].forEach(ev => loadDlg.addEventListener(ev, e => e.preventDefault()));
    // Clicking the backdrop closes either dialog.
    [saveDlg, loadDlg].forEach(d => d.addEventListener('click', e => { if (e.target === d) d.close(); }));
  }

  function set(key, value) {
    const f = FIELDS[key];
    if (f && f.kind !== 'select') {
      if (!isFinite(value)) { syncControls(); return; }
      value = Math.max(f.min, Math.min(f.max, f.int ? Math.round(value) : value));
    }
    state[key] = value;
    if (key === 'tgtId') {
      const t = TARGETS.find(x => x[0] === value);
      if (t) { state.tgtMag = t[2]; state.tgtType = t[3]; }
    }
    if (key === 'tgtMag' || key === 'tgtType') state.tgtId = 'custom';
    if (key === 'camId') {
      const cam = camera();
      Object.assign(state, { pix: cam.pix, qe: cam.qe * 100, bits: cam.bits, fw: cam.fw, dark0: cam.dark0, rnOverride: 0,
        gain: cam.defGain, temp: cam.cooled ? -10 : 20 });
    }
    reconcile();
    syncControls();
    schedule();
  }

  // ---------- rendering ----------
  let pending = false;
  function schedule() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; render(); });
  }

  function render() {
    const p = params();
    const c = Model.compute(p);
    try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (e) { /* ignore */ }
    renderReadouts(p, c);
    renderTiles(p, c);
    renderAlerts(p, c);
    renderTradeoff(p, c);
    renderTime(p, c);
    renderBudget(p, c);
    renderGain(p, c);
    renderSim(p, c);
  }

  function renderReadouts(p, c) {
    const { r, sen } = c;
    const totals = { n: `Number of subs <b>${p.n.toLocaleString('en-US')}</b>`, int: `Total exposure time <b>${fmtDur(c.integration)}</b>`,
      session: `Total wall-clock time <b>${fmtDur(c.session)}</b>` };
    $('ro-exp').innerHTML = Object.keys(totals).filter(k => k !== p.plan).map(k => totals[k]).join('<br>');
    $('ro-scope').innerHTML = `Aperture <b>${trim(r.aperture.toFixed(1))} mm</b> · <b>${r.scale.toFixed(2)}″</b> per pixel · field <b>${c.fov[0].toFixed(2)}° × ${c.fov[1].toFixed(2)}°</b>`;
    const unity = sen.unityGain >= 0 && sen.unityGain <= camera().gainMax ? ` · unity gain ${Math.round(sen.unityGain)}` : '';
    $('ro-cam').innerHTML = `At gain ${p.gain}: read noise <b>${fmtE(sen.rn)} e⁻</b> · <b>${fmtE(sen.eAdu)} e⁻/ADU</b> · full well <b>${fmtE(sen.fullWell)} e⁻</b>${unity}<br>Dark current at ${p.temp} °C: <b>${fmtE(r.dark)} e⁻/s</b>`;
    const bayer = !p.mono && r.bw < (Model.FILTERS.find(f => f.id === p.filter) || {}).bw ? ' (limited by the Bayer matrix)' : '';
    $('ro-sky').innerHTML = `<b>${r.mu.toFixed(2)} mag/″²</b> gives <b>${fmtE(r.sky)} e⁻/s</b> per pixel · ${r.bw} nm passband${bayer}`;
    $('ro-tgt').innerHTML = `<b>${fmtE(r.target)} e⁻/s</b> per pixel at the peak · FWHM <b>${trim((p.tgtFwhm / r.scale).toFixed(1))} px</b>`;
  }

  function renderTiles(p, c) {
    const { st, sen, r } = c;
    const ratio = p.sub / c.tSkyLimited;
    const tiles = [
      st.saturated
        ? ['Stack SNR at target peak', '—', '', 'the target peak saturates in every sub']
        : ['Stack SNR at target peak', st.snr.toFixed(st.snr < 10 ? 2 : 1), '',
          `${st.snrSub.toFixed(2)} per sub · ideal camera ${c.snrIdeal.toFixed(1)}`],
      ['Total integration', fmtDur(c.integration), '', `${p.n} × ${fmtSub(p.sub)}`],
      ['Session time', fmtDur(c.session), '', `${Math.round(c.efficiency * 100)}% of it collecting light`],
      ['Stack dynamic range', st.drStack.toFixed(1), 'stops', `single sub ${st.drSub.toFixed(1)} · sensor ${sen.dr.toFixed(1)}`],
      ['Sky-limited sub length', fmtDur(c.tSkyLimited), '',
        ratio >= 1 ? `your sub is ${ratio.toFixed(1)}× this: sky-limited` : `your sub is ${ratio.toFixed(2)}× this: read noise matters`],
      ['Sky background', fmtE(r.sky), 'e⁻/s', `${fmtE(st.B)} e⁻ per sub · ${(100 * (st.B + st.D) / sen.fullWell).toFixed(1)}% of full well`]
    ];
    $('tiles').innerHTML = tiles.map(t =>
      `<div class="tile"><div class="k">${t[0]}</div><div class="v">${t[1]}${t[2] ? `<small>${t[2]}</small>` : ''}</div><div class="d">${t[3]}</div></div>`).join('');
  }

  function renderAlerts(p, c) {
    const { st, sen } = c, out = [];
    const bgFill = (st.B + st.D) / sen.fullWell;
    if (bgFill >= 1) out.push(['critical', '⛔ Saturated', `Sky and dark current alone fill the well in ${fmtDur(sen.fullWell / (c.r.sky + c.r.dark))}. Shorten the sub or lower the gain.`]);
    else if (st.wellFill >= 1) out.push(['critical', '⛔ Saturated', `The target peak fills the well in ${fmtDur(c.tSaturate)}. Shorten the sub or lower the gain.`]);
    else if (bgFill > 0.25) out.push(['', '⚠ Low headroom', `The background uses ${Math.round(bgFill * 100)}% of the full well, so stars will clip early.`]);
    if (sen.quant > sen.rnAnalog) out.push(['', '⚠ Coarse sampling', `At this gain one ADU is ${fmtE(sen.eAdu)} e⁻, so quantisation noise (${fmtE(sen.quant)} e⁻) exceeds the analogue read noise. Raise the gain.`]);
    $('alerts').innerHTML = out.map(a => `<div class="alert ${a[0]}" role="status"><b>${a[1]}</b><span>${a[2]}</span></div>`).join('');
  }

  const legend = (id, items) => {
    $(id).innerHTML = items.map(i => `<span><i class="sw ${i[2] || ''}" style="background:var(${i[1]})"></i>${i[0]}</span>`).join('');
  };
  // Stacking order, bottom to top (the same as in the simulated pixels plot).
  const SHARE_SERIES = [['dark', 'Dark current', '--c-dark'], ['read', 'Read noise', '--c-read'], ['sky', 'Sky glow', '--c-sky'], ['tgt', 'Target shot noise', '--c-target']];

  function renderTradeoff(p, c) {
    const T = c.session;
    const lo = p.sub < 1 ? 0.1 : 1, hi = 1800, N = 100;
    const snr = [], drStack = [], drSub = [], ideal = [];
    const share = { dark: [], sky: [], tgt: [], read: [] };
    for (let i = 0; i <= N; i++) {
      const t = lo * Math.pow(hi / lo, i / N);
      const n = T / (t + p.ditherTime);                        // continuous, so the curves stay smooth
      const st = Model.stats(c.r, c.sen, t, Math.max(n, 1e-9), c.r.target);
      const ok = n >= 0.999 && !st.saturated;
      snr.push([t, ok ? st.snr : NaN]);
      ideal.push([t, c.snrIdeal]);
      drStack.push([t, n >= 0.999 ? st.drStack : NaN]);
      drSub.push([t, st.drSub]);
      share.dark.push([t, st.D / st.variance]); share.sky.push([t, st.B / st.variance]);
      share.tgt.push([t, st.S / st.variance]); share.read.push([t, st.varRead / st.variance]);
    }
    $('tradeoff-sub').textContent = `Session fixed at ${fmtDur(T)} of wall-clock time: longer subs mean fewer of them, less overhead and less read noise, but less headroom. Click a chart to set the sub length.`;
    const common = {
      xLog: true, xDomain: [lo, hi], xTicks: SUB_TICKS, xFmt: fmtSub, group: 'tradeoff',
      onPick: x => set('sub', x >= 10 ? Math.round(x) : +x.toPrecision(2))
    };
    const markers = labels => [
      { x: p.sub, label: labels ? `Your sub: ${fmtSub(p.sub)}` : '', strong: true },
      { x: c.tSkyLimited, label: labels ? `Sky-limited: ${fmtSub(c.tSkyLimited)}` : '' },
      // Beyond this the target peak fills the well in every sub, so there is no SNR to plot.
      { x: c.tSaturate, label: labels ? `Well full: ${fmtSub(c.tSaturate)}` : '' }
    ];
    Charts.draw($('ch-snr'), Object.assign({}, common, {
      height: 230, markers: markers(true), endLabels: true,
      series: [{ name: 'This setup', color: '--c-metric', pts: snr }, { name: 'Ideal camera', ref: true, pts: ideal }],
      point: { x: p.sub, y: c.st.saturated ? NaN : c.st.snr }, yFmt: v => Charts.fmtNum(v),
      yLabel: 'Stack SNR (ratio)', xLabel: SUB_AXIS,
      aria: 'Stack signal-to-noise ratio against sub-exposure length for a fixed session time'
    }));
    Charts.draw($('ch-dr'), Object.assign({}, common, {
      height: 190, markers: markers(false), endLabels: true, yLabel: 'Dynamic range (stops)', xLabel: SUB_AXIS,
      series: [{ name: 'Stack', color: '--c-metric', pts: drStack }, { name: 'Single sub', ref: true, pts: drSub }],
      point: { x: p.sub, y: c.st.drStack }, tipFmt: v => v.toFixed(1) + ' stops',
      aria: 'Dynamic range in stops against sub-exposure length'
    }));
    legend('lg-share', SHARE_SERIES.slice().reverse().map(s => [s[1], s[2]]));
    Charts.draw($('ch-share'), Object.assign({}, common, {
      height: 200, stacked: true, markers: markers(false), xLabel: SUB_AXIS, yLabel: 'Share of variance (%)', endLabels: true,
      series: SHARE_SERIES.map(s => ({ name: s[1], short: '', color: s[2], pts: share[s[0]] })),
      yFmt: v => Math.round(v * 100) + '%',
      aria: 'Share of per-sub noise variance from each source against sub-exposure length'
    }));
  }

  function renderTime(p, c) {
    const Tmax = Math.max(2 * c.session, 600);
    const unit = Tmax >= 7200 ? 3600 : Tmax >= 120 ? 60 : 1;
    const real = [], ideal = [], N = 80;
    for (let i = 0; i <= N; i++) {
      const T = Tmax * i / N;
      const n = T / (p.sub + p.ditherTime);
      real.push([T / unit, c.st.saturated ? NaN : n >= 0.999 ? Model.stats(c.r, c.sen, p.sub, n, c.r.target).snr : (i === 0 ? 0 : NaN)]);
      ideal.push([T / unit, c.r.target * Math.sqrt(T) / Math.sqrt(c.r.target + c.r.sky)]);
    }
    $('time-sub').textContent = `With ${fmtSub(p.sub)} subs, compared with a camera that has no read noise, dark current or overhead.`;
    legend('lg-time', [['This setup', '--c-metric', 'line'], ['Ideal camera', '--text-muted', 'line']]);
    Charts.draw($('ch-time'), {
      height: 260, yLabel: 'Stack SNR (ratio)', xDomain: [0, Tmax / unit], xLabel: `Session time (${unit === 3600 ? 'hours' : unit === 60 ? 'minutes' : 'seconds'})`,
      series: [{ name: 'This setup', color: '--c-metric', pts: real }, { name: 'Ideal camera', ref: true, pts: ideal }],
      point: { x: c.session / unit, y: c.st.saturated ? NaN : c.st.snr }, endLabels: true,
      tipHead: v => fmtDur(v * unit), tipFmt: v => v.toFixed(1),
      markers: [{ x: c.session / unit, label: `Now: ${fmtDur(c.session)}`, strong: true }],
      aria: 'Stack signal-to-noise ratio against session time'
    });
  }

  function renderBudget(p, c) {
    const { st, sen } = c;
    const parts = { dark: st.D, sky: st.B, tgt: st.S, read: st.varRead };
    $('segbar').innerHTML = SHARE_SERIES.map(s =>
      `<i style="flex:${Math.max(parts[s[0]] / st.variance, 0.0001)};background:var(${s[2]})" title="${s[1]}: ${(100 * parts[s[0]] / st.variance).toFixed(1)}% of variance"></i>`).join('');
    const row = (key, name, mean, noise) => {
      const s = SHARE_SERIES.find(x => x[0] === key);
      return `<tr><td><i class="sw" style="background:var(${s[2]})"></i>${name}</td><td>${mean}</td><td>${fmtE(noise)}</td><td>${(100 * parts[key] / st.variance).toFixed(1)}%</td></tr>`;
    };
    $('budget').innerHTML =
      '<thead><tr><th>Source</th><th>Mean e⁻</th><th>Noise e⁻ RMS</th><th>Share of variance</th></tr></thead><tbody>' +
      row('tgt', 'Target', fmtE(st.S), Math.sqrt(st.S)) +
      row('sky', 'Sky glow', fmtE(st.B), Math.sqrt(st.B)) +
      row('dark', 'Dark current', fmtE(st.D), Math.sqrt(st.D)) +
      row('read', 'Read noise', '—', sen.rn) +
      `<tr class="total"><td>One sub</td><td>${fmtE(st.S + st.B + st.D)}</td><td>${fmtE(Math.sqrt(st.variance))}</td><td>SNR ${st.snrSub.toFixed(2)}</td></tr>` +
      `<tr class="total"><td>Mean of ${p.n} subs</td><td>${fmtE(st.S + st.B + st.D)}</td><td>${fmtE(Math.sqrt(st.variance / p.n))}</td><td>SNR ${st.snr.toFixed(1)}</td></tr>` +
      `<tr class="note"><td colspan="4">Read noise includes ${fmtE(sen.quant)} e⁻ of quantisation noise from the ${p.bits}-bit ADC. One sub fills ${(100 * st.wellFill).toFixed(1)}% of the ${fmtE(sen.fullWell)} e⁻ well.</td></tr>` +
      '</tbody>';
  }

  function renderGain(p, c) {
    const cam = camera();
    const rn = [], fw = [], dr = [], snr = [];
    let gSat = null;                                          // first gain at which the target peak fills the well
    const stepG = cam.gainMax > 400 ? 2 : 1;
    for (let g = 0; g <= cam.gainMax; g += stepG) {
      const sen = Model.sensorAtGain(p, g);
      rn.push([g, sen.rn]); fw.push([g, sen.fullWell]); dr.push([g, sen.dr]);
      const gs = Model.stats(c.r, sen, p.sub, p.n, c.r.target);
      snr.push([g, gs.saturated ? NaN : gs.snr]);
      if (gs.saturated && gSat == null) gSat = g;
    }
    $('gain-sub').textContent = `${cam.name}${cam.hcg != null ? `: high conversion gain switches in at gain ${cam.hcg}` : ''}. Click a chart to set the gain.`;
    const mk = (id, pts, y, tipFmt, aria, yLabel, extra) => Charts.draw($(id), {
      height: 200, xLabel: 'Gain setting (units of 0.1 dB)', yLabel, xDomain: [0, cam.gainMax], series: [{ name: aria, color: '--c-metric', pts }],
      point: { x: p.gain, y }, markers: [{ x: p.gain, label: `Gain ${p.gain}`, strong: true }].concat(extra || []),
      group: 'gain', tipHead: v => 'Gain ' + Math.round(v), tipFmt, aria: aria + ' against gain',
      onPick: x => set('gain', Math.round(x))
    });
    mk('ch-g-rn', rn, c.sen.rn, v => fmtE(v) + ' e⁻', 'Read noise', 'Read noise (e⁻ RMS)');
    mk('ch-g-fw', fw, c.sen.fullWell, v => fmtE(v) + ' e⁻', 'Full well', 'Full well (e⁻)');
    mk('ch-g-dr', dr, c.sen.dr, v => v.toFixed(1) + ' stops', 'Dynamic range', 'Dynamic range (stops)');
    mk('ch-g-snr', snr, c.st.saturated ? NaN : c.st.snr, v => v.toFixed(1), 'Stack SNR', 'Stack SNR (ratio)',
      gSat != null ? [{ x: gSat, label: `Well full from gain ${gSat}` }] : []);
  }

  // ---------- simulation ----------
  let simGeom = null, simData = null;
  const SORT_LABELS = { signal: 'expected signal', star: 'star photons', tgt: 'target photons', sky: 'sky glow', dark: 'dark current', read: 'read noise', total: 'measured value' };

  function renderSim(p, c) {
    simData = Sim.generate(c, p, seed);
    const f = simData[state.simFrame];
    document.querySelectorAll('#sim-frame button').forEach(b => {
      b.setAttribute('aria-pressed', String(b.dataset.v === state.simFrame));
      if (b.dataset.v === 'stack') b.textContent = `Mean of ${p.n} subs`;
    });
    document.querySelectorAll('#sim-view button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === state.simView)));
    $('sim-sort').value = state.simSort;
    $('sim-stars').checked = state.simStars;
    const cal = state.simView === 'cal', str = state.simView === 'str';
    const per = state.simFrame === 'stack' ? ', mean per sub (e⁻)' : ' in one sub (e⁻)';
    simGeom = Sim.drawSection($('sim-canvas'), simData, f, {
      view: state.simView, sort: state.simSort, sortLabel: SORT_LABELS[state.simSort], showFullWell: state.simFrame === 'single',
      yLabel: str ? 'Stretched value (0 = black, 1 = full well)' : (cal ? 'After background subtraction' : 'Electrons per pixel') + per
    });
    const clipped = f.row.anyClip ? [['Clipped: above full well', '--c-clipped']] : [];
    if (str) {
      legend('lg-sim', [['Stretched pixel value', '--c-stretch'], ['Expected value without noise', '--c-expected', 'line']].concat(clipped,
        simGeom.levels > 1 ? [['Faint lines: individual ADC levels', '--grid', 'line']] : []));
    } else {
      legend('lg-sim', (state.simStars ? [[cal ? 'Star shot noise' : 'Stars', '--c-star']] : []).concat([
        [cal ? 'Target shot noise' : 'Target', '--c-target'], ['Sky glow', '--c-sky'], ['Read noise', '--c-read'], ['Dark current', '--c-dark'],
        ['Measured value' + (cal ? ' (sky subtracted)' : ''), '--text-primary', 'line']
      ], cal ? [['Expected signal', '--c-expected', 'line']] : [], clipped));
    }
    Sim.drawPatch($('patch-single'), simData, simData.single, str);
    Sim.drawPatch($('patch-stack'), simData, simData.stack, str);
    $('hist-zoom').checked = state.simHistZoom; $('hist-log').checked = state.simHistLog;
    Sim.drawHist($('hist-canvas'), simData, str, state.simHistZoom, state.simHistLog);
    $('cap-single').textContent = `Single ${fmtSub(p.sub)} sub · peak SNR ${c.st.snrSub.toFixed(2)}`;
    $('cap-stack').textContent = `Mean of ${p.n} subs (${fmtDur(c.integration)}) · peak SNR ${c.st.snr.toFixed(1)}`;
  }

  function simHover(e) {
    const tip = $('sim-tip'), canvas = $('sim-canvas');
    if (!simGeom || !simData) return;
    const box = canvas.getBoundingClientRect();
    const x = e.clientX - box.left, rank = Math.floor((x - simGeom.m.l) / simGeom.bw);
    if (rank < 0 || rank >= Sim.W) { tip.hidden = true; return; }
    const i = simGeom.order[rank], row = simData[state.simFrame].row, cal = state.simView === 'cal';
    const place = (html) => {
      tip.innerHTML = html; tip.hidden = false;
      const tw = tip.offsetWidth;
      tip.style.left = (x + 14 + tw > box.width ? x - 14 - tw : x + 14) + 'px';
      tip.style.top = '12px';
    };
    const head = `Pixel ${i - (Sim.W - 1) / 2 >= 0 ? '+' : '−'}${Math.abs(i - (Sim.W - 1) / 2)} from centre`;
    if (state.simView === 'str') {
      const fr = simData[state.simFrame], st = Sim.stretcher(simData, fr), adu = row.total[i] / (fr.step * fr.n);
      const line = (sw, name, v) => `<div class="row">${sw}<span>${name}</span><b>${v}</b></div>`;
      place(`<div class="head">${head}</div>` +
        line(`<i class="sw" style="background:var(${row.clip[i] ? '--c-clipped' : '--c-stretch'})"></i>`, row.clip[i] ? 'Stretched value (clipped)' : 'Stretched value', st(row.total[i]).toFixed(3)) +
        line('<i class="sw line" style="background:var(--c-expected)"></i>', 'Expected without noise', st(simData.expDark + simData.expSky + row.expSig[i]).toFixed(3)) +
        line('', 'Recorded value', (fr.n === 1 ? Math.round(adu).toLocaleString('en-US') : adu.toFixed(2)) + ' ADU') +
        line('', 'In electrons', fmtE(row.total[i]) + ' e⁻'));
      return;
    }
    const exp = { dark: simData.expDark, sky: simData.expSky, tgt: row.expTgt[i], star: row.expStar[i], read: 0 };
    const rows = (state.simStars ? ['star'] : []).concat(['tgt', 'sky', 'read', 'dark']).map(k => {
      const v = cal ? fmtSigned(row[k][i] - exp[k]) : (k === 'read' ? fmtSigned(row[k][i]) : fmtE(row[k][i]));
      return `<div class="row"><i class="sw" style="background:var(${Sim.COLOR_VARS[k]})"></i><span>${Sim.LABELS[k]}</span><b>${v} e⁻</b></div>`;
    });
    const measured = cal ? row.total[i] - simData.expDark - simData.expSky : row.total[i];
    if (cal) rows.push(`<div class="row"><i class="sw line" style="background:var(--c-expected)"></i><span>Expected signal</span><b>${fmtE(row.expSig[i])} e⁻</b></div>`);
    rows.push(`<div class="row"><i class="sw line" style="background:var(--text-primary)"></i><span>Measured</span><b>${fmtE(measured)} e⁻</b></div>`);
    if (row.clip[i]) rows.push(`<div class="row"><i class="sw" style="background:var(--c-clipped)"></i><span>Clipped at full well: lost</span><b>${fmtE(row.raw[i] - row.total[i])} e⁻</b></div>`);
    place(`<div class="head">${head}${cal ? ' · deviation from expected' : ''}</div>` + rows.join(''));
  }

  // ---------- wiring ----------
  function init() {
    buildControls();
    initInfo();
    reconcile();
    syncControls();

    const seg = (id, key) => $(id).addEventListener('click', e => {
      const b = e.target.closest('button');
      if (b) { state[key] = b.dataset.v; schedule(); }
    });
    seg('sim-frame', 'simFrame');
    seg('sim-view', 'simView');
    $('hist-zoom').addEventListener('change', e => { state.simHistZoom = e.target.checked; schedule(); });
    $('hist-log').addEventListener('change', e => { state.simHistLog = e.target.checked; schedule(); });
    $('sim-stars').addEventListener('change', e => { state.simStars = e.target.checked; schedule(); });
    $('sim-sort').addEventListener('change', e => { state.simSort = e.target.value; schedule(); });
    $('sim-resample').addEventListener('click', () => { seed = (Math.random() * 1e9) | 0; schedule(); });
    $('sim-canvas').addEventListener('pointermove', simHover);
    $('sim-canvas').addEventListener('pointerleave', () => { $('sim-tip').hidden = true; });

    $('theme').addEventListener('click', () => {
      const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = t;
      try { localStorage.setItem('astronoise.theme', t); } catch (e) { /* ignore */ }
      schedule();
    });
    initSettingsFiles();
    $('reset').addEventListener('click', () => {
      state = Object.assign({}, DEFAULTS);
      reconcile(); syncControls(); schedule();
    });

    let lastW = 0;
    new ResizeObserver(() => {
      const w = document.querySelector('main').clientWidth;
      if (w !== lastW) { lastW = w; schedule(); }
    }).observe(document.querySelector('main'));
    render();
  }

  init();
})();
