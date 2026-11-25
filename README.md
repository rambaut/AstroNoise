# AstroNoise

An interactive dashboard for exploring signal, noise and dynamic range in long-exposure deep-sky astrophotography with CMOS cameras.

You choose a target, an exposure plan, a sky, a camera and a telescope. The page then shows:

- a Monte-Carlo simulation of the pixels in a single sub-exposure and in the stack, split by where each electron came from;
- how the stack signal-to-noise ratio (SNR) and dynamic range change with sub-exposure length, for a fixed session length;
- how SNR builds up over the session;
- the noise budget of one sub;
- how gain changes read noise, full well, dynamic range and SNR.

## Running it

Open `index.html` in a browser. There is no build step, no server and no dependency: the site is plain HTML, CSS and JavaScript.

Settings are saved in the browser's local storage. The **Save settings** and **Load settings** buttons at the top of the page write the current setup to a JSON file and read one back. They can also be passed in the URL, for example `index.html#camId=asi533mc&sub=300&n=24`.

| File | Contents |
|---|---|
| `js/model.js` | The signal and noise equations described below |
| `js/sim.js` | The stochastic pixel simulation |
| `js/cameras.js` | Camera presets |
| `js/charts.js` | SVG charts |
| `js/app.js` | Controls, target presets and rendering |

## How far to trust the numbers

The model is meant for comparing choices, such as short subs against long subs or one gain against another. Absolute values are less reliable than the comparisons, for these reasons:

- Sky and target rates assume a flat spectrum and the camera's peak quantum efficiency across the whole filter passband, so they run somewhat high.
- Camera presets and target surface brightnesses are approximate and were not checked against data sheets or catalogues (see [Data](#data)).
- Calibration frames are assumed to be noiseless, and effects such as amplifier glow, fixed-pattern noise, light-pollution gradients and atmospheric extinction are left out.

## The model

All quantities are electrons per pixel unless stated otherwise. Numbers in square brackets refer to the [references](#references).

### Optics

- Aperture: `D = focal length / focal ratio`.
- Collecting area: `A = (π/4) D² (1 − o²)`, where `o` is the central obstruction as a fraction of the aperture diameter.
- Pixel scale: `206.265 × pixel size (µm) / focal length (mm)` arcseconds per pixel. This is the small-angle approximation, 206,265 being the number of arcseconds in a radian.

### Photon rates

A surface brightness `μ` (magnitudes per square arcsecond) is converted to a rate in electrons per second per pixel with

```
rate = F0 × A × (pixel scale)² × QE × throughput × 10^(−0.4 μ) × bandwidth
```

- **Zero point.** `F0 = 10⁸ photons s⁻¹ m⁻² nm⁻¹` for a magnitude-0 source in the V band. This is the rounded form of the widely used figure of about 1,000 photons s⁻¹ cm⁻² Å⁻¹, which follows from the V-band flux density of a magnitude-0 star, about 3.6 × 10⁻⁹ erg s⁻¹ cm⁻² Å⁻¹ [1, 2].
- **Bandwidth.** The filter width in nanometres. A colour camera is limited to 100 nm, because its Bayer matrix restricts each pixel to roughly one colour band.
- **Emission-line targets.** Their brightness is given as a V-band equivalent, so the rate uses a fixed 88 nm, the approximate width of the V band [3], whatever filter is fitted. This is a simplification: it assumes the filter contains the line and passes it in full.
- **Stars.** A star of magnitude `m` gives `F0 × A × QE × throughput × bandwidth × 10^(−0.4 m)` electrons per second in total, spread over a Gaussian seeing disc. A Gaussian is a convenient approximation; real stellar profiles have broader wings and are better described by a Moffat function [4].

### Sky brightness

The sky can be entered as a measured value in magnitudes per square arcsecond, such as a Sky Quality Meter reading, or as a Bortle class [5]. The Bortle scale is defined by visual criteria, not by a measured brightness, so the conversion used here is only a typical one:

| Bortle class | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |
|---|---|---|---|---|---|---|---|---|---|
| mag/arcsec² | 22.0 | 21.9 | 21.6 | 21.1 | 20.3 | 19.3 | 18.7 | 18.2 | 17.5 |

Similar tables circulate widely in the amateur literature and differ from one another by a few tenths of a magnitude. This one has no single authoritative source.

### Sensor

- **Dark current.** `dark = dark₀ × 2^(T / T_double)`, where `dark₀` is the rate at 0 °C. Dark current in silicon roughly doubles for every 5 to 7 °C rise in temperature, which is a standard rule of thumb derived from its exponential temperature dependence [6].
- **Gain.** ZWO gain settings are in units of 0.1 dB, so the conversion factor is `e⁻/ADU = (full well / 2^bits) × 10^(−gain / 200)`. This follows ZWO's own description of the gain setting in its camera documentation.
- **Full well.** The usable full well at a given gain is the smaller of the pixel's full well and the charge that fills the analogue-to-digital converter (ADC), `e⁻/ADU × (2^bits − 1)`.
- **Read noise.** Interpolated linearly from a per-camera table of read noise against gain.
- **Quantisation noise.** Rounding to whole ADU adds noise with a standard deviation of `e⁻/ADU ÷ √12`, the standard result for a uniform quantiser [7, 8]. It is added in quadrature to the read noise.

The definitions of conversion gain, full well, read noise and sensor dynamic range (`log₂(full well / read noise)`) follow Janesick [8].

### Noise and SNR in one sub

For a sub-exposure of `t` seconds, with target signal `S`, sky `B` and dark charge `D` (each a rate multiplied by `t`) and read noise `R`:

```
noise = √(S + B + D + R²)
SNR   = S / noise
```

This is the standard "CCD equation" [9, 10, 11], for one pixel. The first three terms are Poisson (shot) noise, whose variance equals the mean. The extra terms in the full equation for the uncertainty of the background estimate are dropped, which is the assumption of noiseless calibration frames.

### Stacking

Averaging `N` independent subs improves SNR by `√N`, so `stack SNR = sub SNR × √N`. The same holds for a sum, which differs from the average only by a factor of `N`.

Wall-clock time is `N × (t + overhead)`, where the overhead is the average dither and settle time per sub. The "ideal camera" line on the charts is the SNR of a camera with no read noise, no dark current and no overhead over the same wall-clock time: `S_rate × √T / √(S_rate + B_rate)`.

### Sky-limited sub length

Read noise is paid once per sub, so many short subs are noisier than a few long ones of the same total length. The sub length at which read noise raises the background noise by a chosen fraction `p` is

```
t = R² / ( ((1 + p)² − 1) × (sky rate + dark rate) )
```

This follows directly from requiring `√(B + D + R²) = (1 + p) √(B + D)`. The idea of choosing a sub length by an accepted percentage increase in noise was popularised for CMOS cameras by Robin Glover [12]. With `p` = 5% the expression gives about `10 R² / sky rate`.

### Dynamic range

The dynamic range shown is the number of stops between the background noise and saturation:

```
sub   DR = log₂( (full well − B − D) / √(B + D + R²) )
stack DR = sub DR + ½ log₂ N
```

This definition is specific to this tool. It differs from the sensor dynamic range `log₂(full well / R)` because the sky uses up part of the well and adds noise of its own. The stack term reflects the `√N` fall in background noise when averaging.

### Saturation

A pixel is treated as saturated when `S + B + D` reaches the full well in a single sub. SNR is not reported beyond that point, which is why some curves stop at a "Well full" marker.

## The pixel simulation

The simulation draws a 161 × 81 pixel patch containing a Gaussian target and, optionally, six stars of magnitude 8 to 18.

- **Photons and dark current** are Poisson draws. Means below 40 use Knuth's multiplication method [13]; larger means use the normal approximation.
- **Read noise** is a normal draw made with the Box–Muller transform [14].
- **Random numbers** come from the small public-domain `mulberry32` generator, reseeded for each pixel and each noise source so that a pixel's random draw stays the same while a slider is moved.
- **Digitisation.** Each sub is rounded to whole ADU and clipped at the full well. The stack is the mean of the subs, so it takes values in steps of `e⁻/ADU ÷ N`. The stack is drawn in one step from the summed distributions, not sub by sub, which makes its rounding approximate.
- **Stars** are integrated over each pixel using the error function, computed with the rational approximation 7.1.26 of Abramowitz and Stegun [15].
- **Background subtraction** removes the model means of sky and dark current, not an estimate from the data.
- **The histogram** counts every pixel of each patch in equal-width bins of brightness from 0 to 1, with the count on a log scale. Brightness is the pixel value divided by the full well, clamped to 0 and 1, or the stretched value in the stretched view. The axis can be zoomed to the range of values present, or made logarithmic, in which case pixels at zero are omitted.
- **The stretched view** rescales so that the full well is 1, sets a black point 2.8 standard deviations below the median background, and applies a midtones transfer function `MTF(m, x) = (m − 1)x / ((2m − 1)x − m)` chosen to lift the background to 0.25. This is the form of automatic stretch used by PixInsight's ScreenTransferFunction [16].

## Data

- **Cameras** (`js/cameras.js`). Pixel size, quantum efficiency, ADC bit depth, full well, read-noise curves and dark current for 20 ZWO cameras. The values are approximate transcriptions of the specifications and gain charts that ZWO publishes for each camera. They were entered from memory and have not been verified against the current data sheets. Every value can be overridden in the Camera panel.
- **Targets** (`TARGETS` in `js/app.js`). Representative peak surface brightnesses for common objects. These are rough figures for the named part of each object, not catalogue values, and real objects vary greatly across their extent.

Corrections to either list are welcome.

## References

1. Bessell, M. S. (1979). UBVRI photometry II: the Cousins VRI system, its temperature and absolute flux calibration, and relevance for two-dimensional photometry. *Publications of the Astronomical Society of the Pacific*, 91, 589–607.
2. Bessell, M. S., Castelli, F. & Plez, B. (1998). Model atmospheres broad-band colors, bolometric corrections and temperature calibrations for O–M stars. *Astronomy & Astrophysics*, 333, 231–250.
3. Bessell, M. S. (2005). Standard photometric systems. *Annual Review of Astronomy and Astrophysics*, 43, 293–336.
4. Moffat, A. F. J. (1969). A theoretical investigation of focal stellar images in the photographic emulsion and application to photographic photometry. *Astronomy & Astrophysics*, 3, 455–461.
5. Bortle, J. E. (2001). Introducing the Bortle Dark-Sky Scale. *Sky & Telescope*, 101(2), 126–129.
6. Janesick, J. R. (2001). *Scientific Charge-Coupled Devices*. SPIE Press.
7. Bennett, W. R. (1948). Spectra of quantized signals. *Bell System Technical Journal*, 27, 446–472.
8. Janesick, J. R. (2007). *Photon Transfer: DN → λ*. SPIE Press.
9. Mortara, L. & Fowler, A. (1981). Evaluations of charge-coupled device (CCD) performance for astronomical use. *Proceedings of SPIE*, 290, 28–33.
10. Merline, W. J. & Howell, S. B. (1995). A realistic model for point-sources imaged on array detectors: the model and initial results. *Experimental Astronomy*, 6, 163–210.
11. Howell, S. B. (2006). *Handbook of CCD Astronomy* (2nd ed.). Cambridge University Press.
12. Glover, R. (2019). *Deep Sky CMOS Imaging*. Talk given at the Practical Astronomy Show, UK.
13. Knuth, D. E. (1997). *The Art of Computer Programming, Volume 2: Seminumerical Algorithms* (3rd ed.). Addison-Wesley.
14. Box, G. E. P. & Muller, M. E. (1958). A note on the generation of random normal deviates. *Annals of Mathematical Statistics*, 29, 610–611.
15. Abramowitz, M. & Stegun, I. A. (eds.) (1964). *Handbook of Mathematical Functions*. National Bureau of Standards.
16. Pleiades Astrophoto. *PixInsight Reference Documentation: HistogramTransformation and ScreenTransferFunction*.

The references were compiled from memory of the literature. Check page numbers and details before citing them elsewhere.

## Licence

MIT. See [LICENSE](LICENSE).
