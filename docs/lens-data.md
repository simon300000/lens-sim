# Lens data and dispersion adapter

The upstream is [anvcor/lens-bench](https://github.com/anvcor/lens-bench), branch `main`, pinned by the submodule gitlink to **`8274ca9d34bf75611f5a3c00af54a6a8498f076b`**. The upstream `LICENSE` is GNU GPL version 3. The source and generated derivatives retain that licensing; this project does not relabel the upstream data or the adapted dispersion conventions under another license. The complete license is also copied to `public/lenses/LICENSE.lens-bench.txt`.

Initialize a clone before installing/building:

```sh
git submodule update --init --recursive
npm ci
node scripts/build-lens-data.mjs
npm test
npm run build
```

`public/lenses/` is disposable generated output, ignored by Git. Original lens JSON and glass catalogs live only in the pinned submodule. npm `predev`, `pretest`, and `prebuild` regenerate runtime assets before their respective commands; the explicit generator command above is optional. The generated license copy is included in built distributions while its canonical source remains the submodule's `LICENSE`. The runtime consumes these normalized assets because upstream prescriptions are not the application's runtime schema.

The generator reads `data/lenses/*.json`, metadata from `data/index.js`, and the static catalog table in `js/glassdb.js`. It extracts only declared static fallback tables from `js/optics.js`, through a restricted data parser. It does not execute upstream JavaScript, launch its application, import its UI or shaders, fetch new revisions, or modify the submodule. Runtime assets contain project-owned normalized schemas and only the glasses used by each loaded lens. Runtime never evaluates upstream code. The upstream CPU optical program is executed only in a test sandbox to compare numerical reference dispersion values.

To update deliberately, first review upstream data and license changes:

```sh
git -C vendor/lens-bench fetch origin main
git -C vendor/lens-bench checkout <reviewed-full-commit-SHA>
node scripts/build-lens-data.mjs
npm test
```

Review the gitlink, adapter, generated results and license, update the fixed SHA in this document, and commit the gitlink/adapter/documentation changes together when authorized. Do not commit generated `public/lenses/` assets. Ordinary builds never advance the submodule. Missing data produces an error naming `git submodule update --init --recursive`.

## Prescription schema

`adaptLensRecord(record, catalog, {configurationIndex})` returns a `LensPrescription`. `inspectLensRecord` reports each discrete configuration's availability and error. Build assets `/lenses/<id>.json` contain `configurations[index]` (a complete prescription or `null`) and `configurationStatus`; `/lenses/manifest.json` contains list metadata and the exact source SHA. Loading one lens does not download the full glass database.

All lens distances are **mm**. First vertex is `zMm = 0`, positive z runs from object towards sensor. A tx row's material is the medium **after** its interface. Each surface explicitly records `mediumBefore` and `mediumAfter`, referring to the prescription's `glasses` dictionary. Reversing a ray therefore swaps these media rather than assuming every boundary is air to glass. The front of the lens is object space at negative z. Image plane is `sensorZMm`; `imageDistanceMm` is the final row's T, measured from `lastVertexZMm`. There is no fabricated interface at that final thickness.

The tx grammar is `R T material [sd [k [A4 A6 A8 ...]]]`; absent material leaves a numeric aperture in column 3, matching upstream grammar. R sign is retained and R=0/inf denotes a plane. Conic sag is `c*r²/(1+sqrt(1-(1+k)*c²*r²))`. Coefficients are raw even powers of radial distance in mm, starting at r⁴, through A26. Configurations overlay `thi` and `rdy` with **zero-based** interface indices, then axial positions are calculated. The record's `stop` is **one-based**, converted exactly once to `stopIndex`. Config f-number and object distance override the base record; JSON `null` object distance denotes infinity.

`apertureRadiusMm` uses explicit tx sd first, then explicit `sdAp`. If neither is available, a positive `sdDraw` is used as an approximate clipping radius, labeled `apertureSource: "sdDraw-approximation"`. Explicit apertures always take precedence. These fallback surfaces are listed in `approximatedApertureSurfaces` and show a visible warning; `apertureDataComplete` remains false and `missingApertureSurfaces` continues to identify surfaces without documented physical apertures. If the drawing radius is also missing or invalid, the aperture remains `null` and tracing retains the explicit numerical domain. Empirical `vig`, `vigH`, `vigCoord` remain metadata with `empiricalVignettingApplied: false`; geometric clipping does not multiply them a second time.

`apertureMode` retains `fno`, `fnoinf`, `epd`, or `stop`. `apertureValue` is the native parameter, not always an f-number: `epd` is entrance-pupil diameter in mm, `stop` uses physical stop sd. `fno` at finite upstream conjugates is the working image-space f-number; `fnoinf` is EFL/EPD. The optical state must calculate entrance pupil magnification to convert between entrance pupil and physical stop, and only change the actual stop's radius. The adapter never shrinks all surface apertures.

At the pinned revision, **457 / 458 records** have at least one structurally supported configuration; **1975 configurations** parse and **4** explicitly reject negative axial thickness. Native static preflight accepts **455 records / 1967 configurations**; eight configurations additionally fail the conservative rear-envelope check. Supported types are axial planes, spheres, conics, even polynomial aspheres through A26, source-normalized XODD A1–A28 and prescribed-order DOE phase surfaces. Legacy ODD, unknown glasses, invalid configurations and negative-thickness/folded layouts remain explicitly unavailable. No unsupported type silently becomes a sphere or thin lens. Counts describe static coverage; see [integrated browser validation](validation-special-surfaces.md) for measured GPU coverage.

The runtime default is **`canon-fl-50mm-f1-8`**, configuration 0, initially f/2.8. Its 11 interfaces are planes/spheres; all glass interfaces have explicit physical clear radii. Only stop surface 6 lacks an independent physical semidiameter: its operational radius is derived from the upstream declared native aperture mode `fno=1.86` and the first-order entrance-pupil scaling. It retains the “clear aperture data incomplete” warning; no drawing radius is promoted to a physical stop. The source declares image height **21.63 mm** (the rounded full-frame diagonal half-height), EFL is **49.0615946134 mm**, and the 20 m paraxial setting has a **33.9641086097 mm** rear gap. This is a numerically reviewed default, not a claim of measured commercial-lens calibration or complete-library GPU validation. See [default comparison](default-lens-recommendation.md).

**`zemax-55`**, upstream “Zemax 对照”, remains the 23-interface numerical reference and is selectable. All 23 surfaces have explicit physical semidiameters, stop is surface 10, nominal sensor coordinate is 69 mm, and final air gap is 1 mm. Upstream paraxial reference at 587.5618 nm gives EFL **55.0117516567 mm**, pupil magnification **0.60537168688**, stop radius **9.3137 mm**, corresponding to approximately f/1.79 at infinity. Its declared image height is only **14.2 mm**, so it is unsuitable as the default 36×24 mm image. The very short rear gap also makes conservative rear-cap sampling exceptionally inefficient. Its f/1.8 record label is not used to fabricate missing surface data.

## Glass schema and wavelengths

`refractiveIndex(glass, wavelengthNm)` is the single **nm → µm** boundary. It throws on unknown formula, nonphysical output, or an out-of-working-range input. Explicit `_CATALOG` suffixes cannot fall back to another maker. Declared aliases are supported; unrecognized variant letters are not guessed away. Names containing genuine underscores such as `ZEONEX_E48R_2017` retain their exact table identity.

The normalized `GlassCatalog` supports upstream:

- L: square root of Laurent n², exponents `[0,2,-2,-4,-6,-8,4,-10,-12]`, with upstream's final -14 convention for extra terms.
- M: manufacturer Sellmeier `n²=1+ΣBλ²/(λ²-C)`, where C already is squared resonance wavelength.
- S: standard Sellmeier with `λ²-C²` denominator; it must not use the M convention.
- H: Herzberger `n=A+B*L+C*L²+Dλ²+Eλ⁴+Fλ⁶`, `L=1/(λ²-.028)`.
- Explicit model/MIL glasses: upstream Conrady normal-line approximation `n=n0+A/λ+B/λ^3.5`, constrained by nd, vd, and optional ΔPg,F.
- Offset solve: preserves the base dispersion shape while exactly applying Δnd and Δvd.

These formula and model conventions are adapted from lens-bench `js/optics.js`; their attribution and GPL origin are retained in `src/optics/glass.js`. Static manufacturer coefficients come from upstream `js/glassdb.js`, not a second handwritten database. Upstream expressly supplied fallback nd/vd entries remain labeled model approximations; unknown glasses fail.

The working interval is **380–780 nm**. The upstream packed table does not include manufacturer validity limits, so assets explicitly warn that this interval is not manufacturer-certified for every named material. No claims of measured out-of-visible validity are made. Visible formula outputs are checked for finite, physical values before enabling a lens. The spectral sampler and reconstruction must use the same stated interval.

`createGlassLUT` uploads only current-prescription media, default spacing **0.25 nm**, including air. The test evaluates interpolation at half-step samples throughout the interval. For the default lens the measured maximum absolute index error against its f64 reference is **2.828801602e-7** (f32 storage included), bounded by **3e-7**. Separate ray tests must bound how this affects the actual path; small index error alone does not prove optical path accuracy.

Unit tests independently exercise the four formula conventions, compare current formulas with the pinned upstream program to `2e-13` absolute index error, and verify models' nd/vd/partial dispersion, aliases, strict catalog identity, stop/config indexing, physical/drawing aperture separation, final image gap, media ownership, and every library configuration's explicit support status.

## Focus motion

Normalized prescriptions retain `focusMotion`. The adapter prefers the supplied
`zoomcam.focus` table, using natural cubic splines on the infinity zoom nodes,
linear interpolation in inverse object-to-sensor distance, and linear interpolation
between log-focal-length rows, matching the upstream conventions. Zoom position is
estimated from the selected configuration's non-focus gaps. Table MFD limits are
applied and reported; extrapolation beyond tabulated nodes is visible in AF status.

Without an explicit table, the adapter identifies a same-zoom focus family from
`cfgs.thi` and `cfgs.obj` using the upstream focusCam rules. It interpolates the
varying gaps in inverse first-vertex object distance. Curvature changes and
ambiguous duplicate-distance configurations do not define a usable motion cam.
Configurations that vary only the final image gap use the original image-distance
solver, as do lenses with no focus-motion data.

Manual distance commands and centre AF-S both use the motion data when available.
AF-S obtains the scene target through the existing reference ray, then applies its
axial object distance to the cam; it does not replace the table calibration with an
RMS sensor search. The prescribed sensor coordinate stays fixed while surface
positions, focal length, pupil calibration and GPU surface buffers update. The
physical stop opening is retained across focus changes. The UI distance remains
measured from the first vertex; explicit table distances are converted to the
object-to-sensor convention internally. Manual image-distance micro-adjustment
remains available; the next cam focus command restores the prescribed sensor.

Invalid or overlapping cam positions fail visibly and retain the previous optical
state. They never silently switch to sensor translation. Data interpolation can
reproduce the supplied motion, but does not establish commercial-lens calibration
between its source nodes. Unit tests compare all 23 supplied explicit tables to
the pinned upstream interpolation functions; GPU runtime acceptance covers both
cam paths and the existing sensor fallback.
