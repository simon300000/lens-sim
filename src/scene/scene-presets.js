// Composed views that show a lens's character without hunting for it: a place,
// a camera pose, a time of day and a focus distance. The lens is opened to its
// widest aperture, so defocused point sources become large bokeh discs.
// focusM is the object distance along the view axis (as AF reports it), null
// for infinity; exposureEV is the display compensation for the shot. Dates
// choose the Moon: 2026-09-26 is full, 2026-10-10 is new.
export const SCENE_PRESETS = Object.freeze({
  fireflies: { position: [9.6, .4, 6.3], target: [-6, .9, 4.4], hour: 20.5, date: '2026-09-26', focusM: 1.59, exposureEV: 1 },
  eave: { position: [4.6, 1.9, 1.9], target: [-6, 3.3, -.5], hour: 18.17, date: '2026-09-26', focusM: 3.5, exposureEV: 0 },
  path: { position: [-4.6, .42, 16.2], target: [-2.6, .42, 11.2], hour: 22, date: '2026-09-26', focusM: 1.35, exposureEV: 0 },
  vista: { position: [-1, 2.6, 24], target: [-1, 3.2, -40], hour: 21.5, date: '2026-09-26', focusM: null, exposureEV: 1 },
});

// The shots of the introduction video, each with its own lens. These also set
// the lens and, when fNumber is given, the aperture (otherwise wide open).
// Without focusM they run AF-S at the frame centre, as when they were shot:
// the look-at point is only a direction and need not lie on the subject.
export const VIDEO_PRESETS = Object.freeze({
  karesansui: { lens: 'zeiss-otus-55mm-f1-4', fNumber: 8, position: [-8.6, 2.15, 15.2], target: [-4.9, .1, 11.3], hour: 12, date: '2026-09-26', exposureEV: 5.03 },
  lanternNoct: { lens: 'nikon-z-58mm-f0-95-noct-s', position: [-2.95, .33, 14.6], target: [-3.17, .52, 11.8], hour: 18 + 20 / 60, date: '2026-09-26', exposureEV: -.3 },
  bridgePlena: { lens: 'nikon-z-135mm-f1-8-plena', position: [14.2, 1.5, 12.6], target: [5.81, 1.82, 5.53], hour: 6 + 36 / 60, date: '2026-09-26', exposureEV: 0 },
  fisheyeEave: { lens: 'nikon-fisheye-nikkor-6mm-f5-6', fNumber: 5.6, focusM: 3, position: [-3, 1.55, -.9], target: [-3, 1.75, 8], hour: 10, date: '2026-09-26', exposureEV: 3.3 },
  villaSummilux: { lens: 'leica-summilux-m-35mm-f1-4', focusM: 9, position: [.8, 1.3, 7.8], target: [-3, 2.4, -.3], hour: 18 + 27 / 60, date: '2026-09-26', exposureEV: -.5 },
  chochinCanon: { lens: 'canon-50mm-f0-95', position: [-6, 2.3, 8.2], target: [-8.01, 2.64, 5.74], hour: 18 + 24 / 60, date: '2026-09-26', exposureEV: -2.5 },
});

export const PRESETS = Object.freeze({ ...SCENE_PRESETS, ...VIDEO_PRESETS });

