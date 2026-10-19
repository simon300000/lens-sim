import { RASTER_QUALITY_DEFAULTS } from './raster-quality.js';

/** Small UI boundary: immutable snapshots, explicit asynchronous commands. */
export function createControlStore(initial = {}) {
  let state = {
    // Raster preview quality (mode A only); persisted by the application.
    raster: { ...RASTER_QUALITY_DEFAULTS },
    status: 'loading', error: null, mode: 'raster', lenses: [], lensId: '', configurationIndex: 0,
    configurations: [], warnings: [], limits: { fNumber: [1.8, 22], imageDistanceMm: [.1, 200] },
    optics: { fNumber: 2.8, focusDistanceM: 20, imageDistanceMm: 1, focalLengthMm: 55,
      sensorMm: [36, 24], dispersion: true, focusModel: '固定镜组 · 传感器轴向调焦', distanceReference: '物方第一面顶点' },
    sampling: { targetSpp: 64, spp: 0, batchSpp: 4, resolution: 480, paused: false, seed: 1 },
    display: { exposureEV: 0, bloom: true, diagnostic: 'beauty', output: 'auto', actualOutput: 'pending' },
    af: { status: 'idle', message: '', autoOnRelease: false },
    // Rates are over all attempts; *OfPassed and scene-side error rates use
    // optical paths that reached the scene as denominator.
    diagnostics: { pipelineCompilations: 0, numericalErrorRate: 0, opticalBlockedRate: 0, tirRate: 0,
      bvhErrorRate: 0, unsupportedRate: 0, transparencyLimitRate: 0, radianceInvalidRate: 0, reflectionOutsideRate: 0,
      attemptedSamples: 0, lightingRefreshMs: null, lightingRefreshes: 0, computeMs: null,
      timingSource: '尚未测量', width: 0, height: 0, memoryBytes: 0 },
    // Lens image = nearest real BVH surface + real-time lighting from raster resources.
    renderModel: { id: 'geometry-first-hit-realtime-lighting', label: '几何首交点 + 实时光照',
      approximations: ['直接光与环境光为实时近似，不做场景多次反弹', '阴影来自光栅阴影贴图', '水面反射为参考视点平面反射',
        '透明层沿同一射线有界合成，未模拟折射', '无屏幕空间 AO（GTAO 仅用于光栅导航）', '雾按实际路径长度计算'] },
    scene: { status: 'pending', message: '', summary: null, lighting: null },
    revisions: { geometry: 0, material: 0, lighting: 0, camera: 0, optics: 0, display: 0, accumulation: 0 }, ...initial,
  };
  let handler = null;
  const listeners = new Set();
  const snapshot = () => structuredClone(state);
  return {
    getState: snapshot,
    // Runtime-only read view: never mutate it. Public snapshots remain isolated.
    peekState: () => state,
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
