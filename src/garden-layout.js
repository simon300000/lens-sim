// Footprints of the composed garden features, shared by the planting passes so
// that grass, shrubs and pond stones keep clear of gravel, bridge and fence.
export const GRAVEL_BED = Object.freeze({ centre: [-3.2, 11.0], radius: [5.1, 3.05], y: .052 });
export const BRIDGE = Object.freeze({ from: [2.85, 8.62], to: [10.85, 7.78], width: 1.3, rise: .92, deck: .14 });
export const FENCE = Object.freeze({ x: -15.2, z0: -2.6, z1: 9.6, height: 1.82 });
export const PINE = Object.freeze({ base: [4.35, 3.55] });

export function inGravelBed(x, z, pad = 0) {
  const [cx, cz] = GRAVEL_BED.centre, [rx, rz] = GRAVEL_BED.radius;
  return ((x - cx) / (rx + pad)) ** 2 + ((z - cz) / (rz + pad)) ** 2 < 1;
}

/** Distance in plan from (x, z) to the bridge centre line. */
export function bridgeDistance(x, z) {
  const [ax, az] = BRIDGE.from, [bx, bz] = BRIDGE.to;
  const dx = bx - ax, dz = bz - az, t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(x - ax - dx * t, z - az - dz * t);
}
export const nearBridge = (x, z, pad = 0) => bridgeDistance(x, z) < BRIDGE.width / 2 + pad;
export const nearFence = (x, z, pad = 0) => Math.abs(x - FENCE.x) < .1 + pad && z > FENCE.z0 - pad && z < FENCE.z1 + pad;
export const nearPine = (x, z, pad = 0) => Math.hypot(x - PINE.base[0], z - PINE.base[1]) < .35 + pad;

/** True where low planting (grass, flowers, shrubs) may grow. */
export const clearOfFeatures = (x, z, pad = 0) => !inGravelBed(x, z, pad) && !nearBridge(x, z, pad) && !nearFence(x, z, pad) && !nearPine(x, z, pad);
