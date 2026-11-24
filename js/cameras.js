/*
 * Camera presets.
 *
 * Values are approximate, transcribed from manufacturer-published specifications and
 * gain charts. They are good enough for exploring trade-offs, but check them against
 * the current ZWO data sheet for your camera before relying on absolute numbers.
 * Every headline value can be overridden in the UI.
 *
 * Fields
 *   pix     pixel size (µm)
 *   res     [width, height] in pixels
 *   qe      peak quantum efficiency (0-1)
 *   bits    ADC bit depth
 *   fw      full well at gain 0 (e-)
 *   gainMax maximum gain setting (ZWO units of 0.1 dB)
 *   hcg     gain at which high conversion gain mode switches in (null if none)
 *   defGain a sensible default gain for deep-sky work
 *   rn      read-noise curve as [gain, e- RMS] points, linearly interpolated
 *   dark0   dark current at 0 °C (e-/s/pixel)
 *   cooled  has a regulated TEC cooler
 */
window.CAMERAS = [
  { id: 'asi2600mm', name: 'ASI2600MM Pro', sensor: 'IMX571', mono: true, pix: 3.76, res: [6248, 4176],
    qe: 0.91, bits: 16, fw: 50000, gainMax: 700, hcg: 100, defGain: 100, dark0: 0.003, cooled: true,
    rn: [[0, 3.4], [99, 3.3], [100, 1.5], [200, 1.3], [300, 1.15], [450, 1.0], [700, 1.0]] },
  { id: 'asi2600mc', name: 'ASI2600MC Pro', sensor: 'IMX571', mono: false, pix: 3.76, res: [6248, 4176],
    qe: 0.80, bits: 16, fw: 50000, gainMax: 700, hcg: 100, defGain: 100, dark0: 0.003, cooled: true,
    rn: [[0, 3.4], [99, 3.3], [100, 1.5], [200, 1.3], [300, 1.15], [450, 1.0], [700, 1.0]] },
  { id: 'asi6200mm', name: 'ASI6200MM Pro', sensor: 'IMX455', mono: true, pix: 3.76, res: [9576, 6388],
    qe: 0.91, bits: 16, fw: 51400, gainMax: 700, hcg: 100, defGain: 100, dark0: 0.003, cooled: true,
    rn: [[0, 3.5], [99, 3.4], [100, 1.5], [200, 1.3], [300, 1.2], [700, 1.1]] },
  { id: 'asi6200mc', name: 'ASI6200MC Pro', sensor: 'IMX455', mono: false, pix: 3.76, res: [9576, 6388],
    qe: 0.80, bits: 16, fw: 51400, gainMax: 700, hcg: 100, defGain: 100, dark0: 0.003, cooled: true,
    rn: [[0, 3.5], [99, 3.4], [100, 1.5], [200, 1.3], [300, 1.2], [700, 1.1]] },
  { id: 'asi533mm', name: 'ASI533MM Pro', sensor: 'IMX533', mono: true, pix: 3.76, res: [3008, 3008],
    qe: 0.91, bits: 14, fw: 50000, gainMax: 600, hcg: 100, defGain: 100, dark0: 0.003, cooled: true,
    rn: [[0, 3.8], [99, 3.6], [100, 1.5], [200, 1.3], [300, 1.1], [600, 1.0]] },
  { id: 'asi533mc', name: 'ASI533MC Pro', sensor: 'IMX533', mono: false, pix: 3.76, res: [3008, 3008],
    qe: 0.80, bits: 14, fw: 50000, gainMax: 600, hcg: 100, defGain: 100, dark0: 0.003, cooled: true,
    rn: [[0, 3.8], [99, 3.6], [100, 1.5], [200, 1.3], [300, 1.1], [600, 1.0]] },
  { id: 'asi294mm', name: 'ASI294MM Pro (bin 2)', sensor: 'IMX492', mono: true, pix: 4.63, res: [4144, 2822],
    qe: 0.90, bits: 14, fw: 66000, gainMax: 570, hcg: 120, defGain: 120, dark0: 0.02, cooled: true,
    rn: [[0, 7.4], [119, 6.5], [120, 1.9], [200, 1.6], [300, 1.4], [450, 1.25], [570, 1.2]] },
  { id: 'asi294mc', name: 'ASI294MC Pro', sensor: 'IMX294', mono: false, pix: 4.63, res: [4144, 2822],
    qe: 0.75, bits: 14, fw: 63700, gainMax: 570, hcg: 120, defGain: 120, dark0: 0.02, cooled: true,
    rn: [[0, 7.3], [119, 6.3], [120, 1.9], [200, 1.6], [300, 1.4], [450, 1.25], [570, 1.2]] },
  { id: 'asi1600mm', name: 'ASI1600MM Pro', sensor: 'MN34230', mono: true, pix: 3.8, res: [4656, 3520],
    qe: 0.60, bits: 12, fw: 20000, gainMax: 600, hcg: null, defGain: 139, dark0: 0.05, cooled: true,
    rn: [[0, 3.6], [50, 2.9], [100, 2.1], [139, 1.7], [200, 1.4], [300, 1.2], [600, 1.1]] },
  { id: 'asi183mm', name: 'ASI183MM Pro', sensor: 'IMX183', mono: true, pix: 2.4, res: [5496, 3672],
    qe: 0.84, bits: 12, fw: 15000, gainMax: 450, hcg: null, defGain: 111, dark0: 0.02, cooled: true,
    rn: [[0, 3.0], [50, 2.6], [100, 2.2], [150, 1.9], [200, 1.75], [270, 1.6], [450, 1.55]] },
  { id: 'asi183mc', name: 'ASI183MC Pro', sensor: 'IMX183', mono: false, pix: 2.4, res: [5496, 3672],
    qe: 0.84, bits: 12, fw: 15000, gainMax: 450, hcg: null, defGain: 111, dark0: 0.02, cooled: true,
    rn: [[0, 3.0], [50, 2.6], [100, 2.2], [150, 1.9], [200, 1.75], [270, 1.6], [450, 1.55]] },
  { id: 'asi071mc', name: 'ASI071MC Pro', sensor: 'IMX071', mono: false, pix: 4.78, res: [4944, 3284],
    qe: 0.50, bits: 14, fw: 46000, gainMax: 240, hcg: null, defGain: 90, dark0: 0.03, cooled: true,
    rn: [[0, 3.3], [90, 2.7], [150, 2.4], [240, 2.3]] },
  { id: 'asi2400mc', name: 'ASI2400MC Pro', sensor: 'IMX410', mono: false, pix: 5.94, res: [6072, 4042],
    qe: 0.80, bits: 14, fw: 100000, gainMax: 550, hcg: 140, defGain: 140, dark0: 0.01, cooled: true,
    rn: [[0, 6.4], [139, 5.5], [140, 1.9], [250, 1.4], [400, 1.15], [550, 1.1]] },
  { id: 'asi585mc', name: 'ASI585MC Pro', sensor: 'IMX585', mono: false, pix: 2.9, res: [3840, 2160],
    qe: 0.91, bits: 12, fw: 40000, gainMax: 600, hcg: 252, defGain: 252, dark0: 0.01, cooled: true,
    rn: [[0, 11], [100, 6.5], [200, 4.4], [251, 4.0], [252, 1.5], [350, 1.0], [450, 0.8], [600, 0.75]] },
  { id: 'asi678mc', name: 'ASI678MC', sensor: 'IMX678', mono: false, pix: 2.0, res: [3840, 2160],
    qe: 0.83, bits: 12, fw: 11270, gainMax: 600, hcg: 180, defGain: 180, dark0: 0.02, cooled: false,
    rn: [[0, 2.7], [100, 2.2], [179, 1.9], [180, 1.0], [300, 0.75], [600, 0.6]] },
  { id: 'asi462mc', name: 'ASI462MC', sensor: 'IMX462', mono: false, pix: 2.9, res: [1936, 1096],
    qe: 0.89, bits: 12, fw: 12000, gainMax: 600, hcg: 80, defGain: 80, dark0: 0.02, cooled: false,
    rn: [[0, 2.5], [79, 2.3], [80, 0.9], [200, 0.7], [600, 0.5]] },
  { id: 'asi224mc', name: 'ASI224MC', sensor: 'IMX224', mono: false, pix: 3.75, res: [1304, 976],
    qe: 0.80, bits: 12, fw: 19200, gainMax: 600, hcg: 60, defGain: 135, dark0: 0.02, cooled: false,
    rn: [[0, 3.0], [59, 2.9], [60, 1.5], [135, 1.2], [300, 0.8], [600, 0.75]] },
  { id: 'asi290mm', name: 'ASI290MM', sensor: 'IMX290', mono: true, pix: 2.9, res: [1936, 1096],
    qe: 0.80, bits: 12, fw: 14600, gainMax: 600, hcg: 60, defGain: 110, dark0: 0.02, cooled: false,
    rn: [[0, 3.2], [59, 3.1], [60, 1.6], [110, 1.4], [300, 1.0], [600, 1.0]] },
  { id: 'asi178mm', name: 'ASI178MM', sensor: 'IMX178', mono: true, pix: 2.4, res: [3096, 2080],
    qe: 0.81, bits: 14, fw: 15000, gainMax: 510, hcg: null, defGain: 100, dark0: 0.03, cooled: false,
    rn: [[0, 2.2], [100, 1.8], [200, 1.5], [270, 1.4], [510, 1.35]] },
  { id: 'asi174mm', name: 'ASI174MM', sensor: 'IMX174', mono: true, pix: 5.86, res: [1936, 1216],
    qe: 0.78, bits: 12, fw: 32000, gainMax: 400, hcg: null, defGain: 190, dark0: 0.1, cooled: false,
    rn: [[0, 6.0], [100, 4.7], [200, 3.8], [300, 3.5], [400, 3.5]] }
];
