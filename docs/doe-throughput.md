# Nikon Z600 DOE uniform-disk diagnostic

The prescribed 1 mm sensor gap and conservative 22.0000122 mm rear sampling disk make uniform sampling inefficient. A zero-signal 32 spp smoke test does not establish failed DOE tracing.

`tests/doe-throughput-gpu.html` uses the real production optical engine with pupil importance sampling disabled, the native sensor position, the minimum supported f-number, a 48×32 full-frame image, seed 185, and constant environment [1,1,1]. It preserves the fixed sample prefix while increasing 32 to 1024 spp. Independent f64 calculations use the same five sample dimensions and count every attempted path.

Safari Technology Preview on 2026-10-15 reproduced the result for all four configurations:

| Budget | Attempts per configuration | CPU / GPU transmitted | GPU mean Y | Numerical / GPU errors |
| --- | ---: | ---: | ---: | ---: |
| 32 spp | 49,152 | 0 / 0 | 0 | 0 |
| 1024 spp | 1,572,864 | 17 / 17 | 0.036669582649939074 | 0 |

The f64 diagnostic at 32 spp classifies 40,787 paths as blocked at S39 and 8,360 at S40; the other five block at S32/S34/S36/S38. These interfaces are reached before the DOE during reverse traversal. At 1024 spp, 1,572,658 attempts still block at S39/S40. This is sampling inefficiency, not a phase-gradient failure. For the central sensor point at 550 nm, rear offsets through 0.07 mm transmit while 0.08 mm is blocked. Directed forward control rays at entrance heights 0, 1, 5, 20 and 50 mm and wavelengths 390, 550 and 770 nm transmit and retrace from their native sensor intersections in all four configurations.

Raw reports are saved in `artifacts/doe-throughput-safari-technology-preview.json` and `artifacts/doe-throughput-cpu-investigation.json`. The CPU surface histogram and control rays can be reproduced with `node scripts/diagnose-doe-throughput.mjs 32` or `1024` after building lens data. The browser report records visibility/focus honestly: visible at start and finish, initially unfocused and focused by completion. No performance claim is made.

No optical coefficients, apertures, source configuration or sampling weights were changed for this diagnostic. It does not claim that 1024 spp provides a converged image; only 17 paths carry signal. The separate pupil-importance work is outside this DOE change.
