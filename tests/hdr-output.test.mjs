import test from 'node:test';
import assert from 'node:assert/strict';
import { isHDRConfiguration, probeHDRCanvas } from '../src/hdr-output.js';

// Browser capability checks are exercised without requesting a real GPU or
// making the test result depend on the display attached to the test machine.
function fakeBrowser(overrides = {}) {
  const calls = { requestDevice: 0, configure: [], scopes: [], pop: 0, unconfigure: 0, destroy: 0 };
  const device = {
    pushErrorScope(type) { calls.scopes.push(type); },
    async popErrorScope() { calls.pop++; return overrides.validationError ?? null; },
    destroy() { calls.destroy++; },
  };
  const context = {
    configure(descriptor) {
      calls.configure.push(descriptor);
      if (overrides.configureError) throw overrides.configureError;
    },
    getConfiguration() {
      if (overrides.configurationError) throw overrides.configurationError;
      return overrides.configuration ?? { format: 'rgba16float', colorSpace: 'srgb', toneMapping: { mode: 'extended' } };
    },
    getCurrentTexture() {
      if (overrides.textureError) throw overrides.textureError;
      return { format: overrides.textureFormat ?? 'rgba16float' };
    },
    unconfigure() { calls.unconfigure++; },
  };
  if (overrides.noConfigurationAPI) delete context.getConfiguration;
  const canvas = {
    width: 0,
    height: 0,
    getContext(type) { assert.equal(type, 'webgpu'); return overrides.noContext ? null : context; },
  };
  const adapter = {
    async requestDevice() {
      calls.requestDevice++;
      if (overrides.deviceError) throw overrides.deviceError;
      return device;
    },
  };
  return { adapter, canvas, context, device, calls, createCanvas: () => canvas };
}

async function probeFake(overrides) {
  const fixture = fakeBrowser(overrides);
  const result = await probeHDRCanvas(fixture.adapter, { createCanvas: fixture.createCanvas });
  assert.equal(typeof result.supported, 'boolean');
  assert.equal(typeof result.reason, 'string');
  return { ...fixture, result };
}

function assertReleased(fixture) {
  assert.equal(fixture.calls.unconfigure, 1, 'temporary canvas is unconfigured');
  assert.equal(fixture.calls.destroy, 1, 'temporary GPU device is destroyed');
}

test('HDR configuration requires both a floating point canvas and extended tone mapping', () => {
  assert.equal(isHDRConfiguration({ format: 'rgba16float', toneMapping: { mode: 'extended' } }), true);
  for (const configuration of [
    undefined, null, {},
    { format: 'rgba16float' },
    { format: 'rgba16float', toneMapping: { mode: 'standard' } },
    { format: 'rgba8unorm', toneMapping: { mode: 'extended' } },
    { format: 'bgra8unorm', toneMapping: { mode: 'extended' } },
  ]) assert.equal(isHDRConfiguration(configuration), false);
});

test('an accepted extended float canvas with an actual float texture supports HDR', async () => {
  const fixture = await probeFake();
  assert.equal(fixture.result.supported, true);
  assert.equal(fixture.canvas.width, 1);
  assert.equal(fixture.canvas.height, 1);
  assert.equal(fixture.calls.requestDevice, 1);
  assert.equal(fixture.calls.configure.length, 1);
  const descriptor = fixture.calls.configure[0];
  assert.equal(descriptor.device, fixture.device);
  assert.equal(descriptor.format, 'rgba16float');
  assert.equal(descriptor.toneMapping.mode, 'extended');
  assert.equal(descriptor.colorSpace, 'srgb');
  assert.equal(descriptor.alphaMode, 'opaque');
  assert.ok(descriptor.usage & 16, 'canvas can be rendered into');
  assert.ok(descriptor.usage & 1, 'canvas can be read back');
  assert.deepEqual(fixture.calls.scopes, ['validation']);
  assert.equal(fixture.calls.pop, 1);
  assertReleased(fixture);
});

test('a browser that silently ignores extended tone mapping falls back to SDR', async () => {
  const fixture = await probeFake({ configuration: { format: 'rgba16float', toneMapping: { mode: 'standard' } } });
  assert.equal(fixture.result.supported, false);
  assertReleased(fixture);
});

test('a browser that omits the returned tone mapping mode falls back to SDR', async () => {
  const fixture = await probeFake({ configuration: { format: 'rgba16float' } });
  assert.equal(fixture.result.supported, false);
  assertReleased(fixture);
});

test('extended mode on an 8-bit canvas does not qualify as HDR', async () => {
  const fixture = await probeFake({ configuration: { format: 'bgra8unorm', toneMapping: { mode: 'extended' } }, textureFormat: 'bgra8unorm' });
  assert.equal(fixture.result.supported, false);
  assertReleased(fixture);
});

test('the actual canvas texture must match the advertised float configuration', async () => {
  const fixture = await probeFake({ textureFormat: 'rgba8unorm' });
  assert.equal(fixture.result.supported, false);
  assertReleased(fixture);
});

test('a browser without configuration introspection cannot prove HDR support', async () => {
  const fixture = await probeFake({ noConfigurationAPI: true });
  assert.equal(fixture.result.supported, false);
  assertReleased(fixture);
});

test('asynchronous GPU validation failure rejects an apparently valid configuration', async () => {
  const fixture = await probeFake({ validationError: { message: 'Unsupported HDR surface' } });
  assert.equal(fixture.result.supported, false);
  assert.equal(fixture.calls.pop, 1);
  assertReleased(fixture);
});

test('a synchronous configure failure returns a fallback result and releases resources', async () => {
  const fixture = await probeFake({ configureError: new TypeError('Unsupported toneMapping option') });
  assert.equal(fixture.result.supported, false);
  assert.equal(fixture.calls.pop, 1, 'the validation scope is balanced even when configure throws');
  assertReleased(fixture);
});

test('configuration and texture acquisition failures release temporary resources', async (t) => {
  for (const failure of ['configurationError', 'textureError']) {
    await t.test(failure, async () => {
      const fixture = await probeFake({ [failure]: new Error('Canvas capability query failed') });
      assert.equal(fixture.result.supported, false);
      assert.equal(fixture.calls.pop, 1);
      assertReleased(fixture);
    });
  }
});

test('a missing WebGPU canvas context still releases the temporary device', async () => {
  const fixture = await probeFake({ noContext: true });
  assert.equal(fixture.result.supported, false);
  assert.equal(fixture.calls.destroy, 1);
  assert.equal(fixture.calls.unconfigure, 0);
});

test('device acquisition failure produces SDR fallback without claiming any canvas was configured', async () => {
  const fixture = await probeFake({ deviceError: new Error('Device unavailable') });
  assert.equal(fixture.result.supported, false);
  assert.equal(fixture.calls.configure.length, 0);
  assert.equal(fixture.calls.destroy, 0);
});
