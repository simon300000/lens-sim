import { createSceneBuilder, buildTransfers } from './scene-builder.js';

/** Off-main-thread BVH construction (scene-builder.js). Keeps BLAS builds and
 * their sources by key so instance-only changes rebuild just the TLAS. Inputs
 * arrive as structured clones (or transfers); outputs are transferred back. */
const builder = createSceneBuilder();
self.onmessage = ({ data }) => {
  const { id, type } = data;
  try {
    if (type === 'dispose') { builder.dispose(); self.postMessage({ id, ok: true }); return; }
    if (type !== 'build') throw new Error('Unknown BVH worker request: ' + type);
    const result = builder.build(data);
    self.postMessage({ id, ok: true, ...result }, buildTransfers(result));
  } catch (error) {
    self.postMessage({ id, ok: false, error: String(error?.stack || error) });
  }
};
