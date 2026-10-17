# Spectral reconstruction and sampling

`src/spectral/reconstruction.js` accepts **unexposed, unencoded, nonnegative scene-linear sRGB radiance**, including values larger than one. It never consumes the Bloom/ACES/sRGB canvas. One attempted camera path samples one continuous wavelength; every glass on that path must use that same wavelength. Dispersion is a geometry calculation in the optical tracer, not an RGB image offset.

## Sources and provenance

The color-matching approximation is independently implemented from the numerical formulas in Wyman, Sloan and Shirley, [*Simple Analytic Approximations to the CIE XYZ Color Matching Functions*, JCGT 2(2), 2013, equation 4](https://jcgt.org/published/0002/02/01/paper.pdf). These are analytic approximations to the CIE 1931 2° XYZ observer, **not the exact tabulated standard**. The authors' paper is CC BY-ND 3.0; this project does not redistribute or modify the paper, copy its supplemental C++ code, or copy a CIE data table. Numerical formula coefficients are implemented independently and attributed here and in source.

[PBRT 4e, Color](https://pbr-book.org/4ed/Radiometry,_Spectra,_and_Color/Color) supplies the colorimetric basis: spectral distributions integrate against observer matching functions, and many spectra have the same RGB/XYZ. The actual reconstruction here is an **authored nonnegative additive-primary metamer model**, described completely below. It is not a port of PBRT's RGB sigmoid polynomial fitting, Smits' tables, or an assertion that RGB determines a unique spectrum. No third-party spectrum LUT is redistributed.

[PBRT 4e, Sobol' Samplers](https://pbr-book.org/4ed/Sampling_and_Reconstruction/Sobol_Samplers) describes generator matrices, XOR digital shifts and dyadic stratification. The short generator implementation and five-dimensional table generation in `sampler.js` are independently written from that mathematical construction; no PBRT table/code was copied. The concentric disc map uses the geometric square-to-disc construction of Shirley and Chiu, *A Low Distortion Map Between Disk and Square*, Journal of Graphics Tools 2(3), 1997. No source code was copied.

## Explicit reconstruction model

We construct a finite bank of positive Gaussian lobes: centers 400, 420, …, 720 nm, and standard deviations 12, 20 and 28 nm. Each lobe is integrated against the analytic XYZ observer over the requested wavelength interval with 0.5 nm midpoint quadrature. For each of the three standard linear-sRGB primary XYZ columns, all triples of bank lobes are tested. The 3×3 system is solved, negative-coefficient solutions are rejected, and the feasible solution with least integrated squared spectral energy is selected. Positive coefficients and positive Gaussians guarantee a nonnegative reconstructed spectrum for every nonnegative RGB input. Selection is deterministic. Three lobes per primary keep runtime evaluation small; this is a metamer choice with a deliberately limited basis, not measured lamp/paint spectra.

The RGB matrix is the usual D65 linear-sRGB → XYZ matrix. White RGB (1,1,1) has XYZ approximately (0.95047, 1, 1.08883), D65 chromaticity. **The chosen white spectrum is a D65-chromaticity metamer, not the actual daylight D65 spectral distribution.** There is no additional illuminant multiplication, chromatic adaptation, or white-balance transform: the input is already emitted RGB radiance in the scene's linear-sRGB working space. Different metamer choices can produce different chromatic-aberration appearances, an unavoidable limitation of RGB input.

Let `A=max(R,G,B)` and `shape=RGB/A` (zero input returns zero). The output is `A × dot(shape, positivePrimarySpectra(lambda))`. No channel is clipped to one. Negative/nonfinite RGB is rejected by the CPU reference; the GPU math defensively floors negative input to zero because negative spectral radiance cannot be represented. This is not a gamut transform. The capture/provider must keep its RGB finite and nonnegative and diagnose invalid input separately.

No fitted parameters depend on pixel, lens, frame brightness, aperture throughput or successful path count. HDR amplitude is linear. Ideal camera transmission and geometric camera weight are applied outside the spectrum reconstruction.

## Units, integration and display

All spectral interfaces use **nm**. Glass formulas that require μm must convert at their own explicit boundary. Default support is 380–780 nm, uniformly sampled with PDF `1/400 nm⁻¹`. The fixed XYZ normalization is:

```
K = 1 / integral_380^780 yBar(lambda) dLambda
  = 1 / 106.94378939400583 nm

pathXYZ = K * spectralRadiance(RGB, lambda)
              * XYZBar(lambda) * cameraWeight / pdfLambda
```

This Y normalization is fixed globally, not a throughput/exposure normalization. The attempted path's XYZ contribution is accumulated in f32, then divided by **all attempted samples**, including zero contributions from blocked/TIR paths. The XYZ→linear-sRGB matrix is the inverse of the RGB matrix. Negative RGB caused by finite-sample color noise can occur after this final matrix; it is not negative spectral radiance. Display conversion/gamut handling is a separate stage. Exposure, Bloom, HDR/SDR tone mapping and sRGB encoding are applied only after accumulation.

The approximation has no spectral material BRDFs, measured light spectra, fluorescence, wave-optical diffraction imaging, coherent interference, absorption or wavelength-dependent sensor response beyond XYZ matching. It cannot reconstruct the true spectrum of the existing scene.

## Glass wavelength support

A lens requiring a smaller supported visible band must visibly report it. Sampling PDF, CMF integration and RGB reconstruction must all use the same interval. `createSpectralReconstruction({minNm,maxNm})` refits the positive primary spectra on that band; unsupported bands fail explicitly. `sampleWavelength(u,minNm,maxNm)` supplies its PDF. The fixed global K remains unchanged.

`SPECTRAL_WGSL` embeds the fixed 380–780 nm emission basis shared by the renderer. Lens/glass wavelength bounds and sampling PDFs are runtime optics parameters; changing them does not rebuild this basis or compile a new shader. Restricted-band CPU reconstructions remain available through `createSpectralReconstruction()` for numerical reference tests.

## Reproducible sequence

The five dimensions are permanently assigned: 0/1 pixel xy, 2/3 pupil xy, 4 wavelength. `sampleDimension(pixelId,sampleIndex,dimension,seed)` evaluates a Sobol sequence with a pixel/dimension hash **digital XOR shift**, not full Owen scrambling. Its first power-of-two prefixes retain one-dimensional dyadic stratification; the first two dimensions also retain elementary-rectangle stratification. Directions are generated from the first five conventional primitive-polynomial parameters, not a large copied table.

The result is a 23-bit midpoint exactly representable in f32, strictly inside (0,1), with identical integer arithmetic in JS and WGSL. Reproducibility does not depend on dispatch batch size, target spp, which paths pass the lens, UI timing, or mutable RNG state. The sequence is indexed by **attempt**, including blocked, TIR and numerical-error attempts. A concentric disc transform has no rejection loop; pupil area PDF belongs to the actual geometric sampling region, not to this unit-disc transform.

## Executed numerical checks

Run `node --test tests/spectral.test.mjs` (10 tests). This verifies primary/mixed/white/HDR roundtrip, positive spectra, fixed amplitude scaling, wavelength PDF/XYZ integration, shorter-band fitting, Sobol stratification, f32-representable output, reproducible attempt prefixes under changed batching, and disc area moments. At 0.1 nm integration, examples:

| Input linear RGB | Recovered linear RGB |
| --- | --- |
| (1,1,1) | (1.000000018, 0.999999985, 1.000000001) |
| (1,0,0) | (1.000000006, -0.000000002, -0.00000000007) |
| (0,1,0) | (0.000000011, 0.999999987, 0.0000000014) |
| (0,0,1) | (0.00000000085, -0.00000000086, 0.9999999992) |
| (10,2,0.5) | (10.000000079, 1.999999957, 0.500000002) |

The small negative residuals are numerical matrix/quadrature roundtrip error; the spectra themselves remain nonnegative. These checks validate the chosen analytic-observer model, not equality to measured spectra or exact CIE-tabulated observer data. GPU shader compilation, CPU/GPU parity and optical end-to-end rendering belong to the renderer's separate browser integration tests; these Node checks alone do not claim those have passed.

The native browser probe is available as `runSpectralProbe(interop)` from `tests/spectral-optical-probe.js`. Pass the already initialized renderer's interop; it never creates another device or renderer. It dispatches the production Sobol/spectral WGSL and checks exact f32 bit parity for 120 sampler fixtures (5 dimensions, 3 pixels, 8 indices), plus GPU f32 spectral integration of 11 neutral/saturated/HDR colors using 16,384 continuous wavelength strata. XYZ and recovered linear RGB must meet `abs(error) <= 1e-4 × max(1,abs(expected channel))`. Its timing is labeled CPU wall time including compilation and diagnostic readback, **not GPU timing**. The probe releases its temporary storage buffers and throws on shader/validation/numerical/parity failure. A browser execution result is required before claiming this probe has passed.
