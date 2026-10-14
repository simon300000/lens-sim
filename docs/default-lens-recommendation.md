# Reviewed default lens selection

Use `canon-fl-50mm-f1-8`, configuration 0, f/2.8 for the initial view. This is an
existing normalized upstream prescription, not an invented thin lens. It uses
11 spherical/plane interfaces, a full-frame declared image half-height of
21.63 mm and actual EFL 49.0615946134 mm. Runtime initialization preserves the
native INF image plane: rear vertex-to-sensor gap 33.8252 mm. The 20 m paraxial
comparison fixture below uses a 33.9641086097 mm gap; it is not the runtime
initialization. The sensor remains 36×24 mm.

All of its glass boundaries have explicit physical clear radii. Surface 6 is
the aperture stop; it lacks an independent physical semidiameter, so its radius
is derived from the upstream native working f-number and computed pupil scale.
At f/2.8 it is 6.1331037943 mm. The data warning remains visible. This is a
stated aperture-model approximation, not a newly measured physical stop or an
assumption that drawing radius equals clear radius. Empirical vignetting is
not multiplied into the geometric ray result.

The original numerical reference `zemax-55` was a poor default: its declared
image height is 14.2 mm, its rear gap is only 1.1776864714 mm at 20 m, and its
15 mm rear cap requires a very conservative, inefficient sampling disk. It
remains a valuable complete-aperture reference for unit tests and selection.

## Executed comparison

CPU f64 propagation used the actual current-lens analytic glass formulas,
4096 fixed Sobol attempts per pixel, digital-shift seed 1234, pupil dimensions
2/3, continuous wavelength dimension 4 over 380–780 nm, area-uniform concentric
disk, and the proven rear-cap sampling bounds. Positions are sensor mm, using
the actual paraxial sensor location for 20 m. No failed sample is replaced.
These are optical numerical measurements, not browser/GPU performance results.

At f/4:

| Lens / configuration 0 | Interfaces | Rear gap mm | Centre pass | (12,0) pass | (17.9,11.9) pass | Numerical failures |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Zemax 55 reference | 23 | 1.178 | 0.0244% | 0% | 0% | 0 |
| Nikon AI-S 45/2.8P | 8 | 38.029 | 32.495% | 32.324% | 25.854% | 0 |
| Pentax-M 40/2.8 | 10 | 36.837 | 28.809% | 29.639% | 21.606% | 0 |
| Canon EF 40/2.8 STM | 11 (one asphere) | 39.060 | 29.492% | 27.905% | 18.091% | 0 |
| Canon FL 50/1.8 | 11 | 33.964 | 13.428% | 13.501% | 11.963% | 0 |

The Nikon/Pentax source image heights are 21.15/21.268 mm, slightly below the
36×24 mm sensor diagonal half-height. Canon EF 40/2.8 STM declares 21.64 mm and
is another good candidate after its asphere is independently GPU-validated.
Canon FL 50 was chosen to keep the first default entirely spherical while
covering full frame and retaining meaningful pass rates.

At the selected **f/2.8**, Canon FL 50 passes 1145/4096 central attempts,
1143/4096 at (12,0), and 832/4096 near the corner: **27.954%, 27.905%, 20.313%**.
There are zero numerical failures in these 12,288 attempts. The near-corner
set includes 82 TIR attempts; these remain physical zero contributions, distinct
from solver errors and cache misses. Mean ideal geometric weights over **all**
attempts are 0.1006352, 0.0914865, and 0.0541346 respectively. This variation is
not normalized away. A lower f-number increases the stop radius only; it does
not scale every glass aperture.

The raw f/4 comparison is saved locally at
`artifacts/default-lens-comparison.json` (a generated verification artifact,
excluded from source control by the existing project policy). Re-run optical
comparisons when changing the pinned data, glass formula, sensor or bound.

Structural parser support for other library records is not proof of full GPU
image validation. Report actual device/image tests separately; these limited
ray samples alone do not certify every field, wavelength, focus or configuration.
