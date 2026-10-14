/** Small UI boundary: immutable snapshots, explicit asynchronous commands. */
export function createControlStore(initial = {}) {
  let state = {
    status: 'loading', error: null, mode: 'raster', lenses: [], lensId: '', configurationIndex: 0,
    configurations: [], warnings: [], limits: { fNumber: [1.8, 22], imageDistanceMm: [.1, 200] },
    optics: { fNumber: 2.8, focusDistanceM: 20, imageDistanceMm: 1, focalLengthMm: 55,
      sensorMm: [36, 24], dispersion: true, focusModel: '固定镜组 · 传感器轴向调焦', distanceReference: '物方第一面顶点' },
    sampling: { targetSpp: 64, spp: 0, batchSpp: 4, resolution: 480, paused: false, seed: 1 },
    display: { exposureEV: 0, bloom: true, diagnostic: 'beauty', output: 'auto', actualOutput: 'pending' },
    af: { status: 'idle', message: '', autoOnRelease: false },
    diagnostics: { captures: 0, pipelineCompilations: 0, cacheMissRate: 0, numericalErrorRate: 0,
      opticalBlockedRate: 0, tirRate: 0, attemptedSamples: 0, captureMs: null, computeMs: null,
      timingSource: '尚未测量', width: 0, height: 0, memoryBytes: 0 },
    revisions: { scene: 0, optics: 0, display: 0, accumulation: 0 }, ...initial,
  };
  let handler = null;
  const listeners = new Set();
  const snapshot = () => structuredClone(state);
  return {
    getState: snapshot,
    subscribe(listener) { listeners.add(listener); listener(snapshot()); return () => listeners.delete(listener); },
    update(patch) { state = { ...state, ...patch }; for (const listener of listeners) listener(snapshot()); },
    setHandler(next) { handler = next; },
    async dispatch(action, value) {
      if (!handler) throw new Error('镜头后端尚未就绪');
      return handler(typeof action === 'string' ? { type: action, value } : action);
    },
    dispose() { listeners.clear(); handler = null; },
  };
}
