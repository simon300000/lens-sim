#!/usr/bin/env node
/** Full application in a real WebGPU browser: loads the villa scene, waits for
 * the BVH and raster resources, switches to the lens mode, samples to a target
 * and saves screenshots + backend diagnostics to artifacts/app-*.
 *   node scripts/app-smoke.mjs [--port 5182] [--spp 16] [--width 480] [--headed]
 * Uses the same Chromium/WebGPU flags as run-gpu-tests.mjs. Timings on a
 * SwiftShader (software) adapter describe that adapter only.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : fallback; };
const port = Number(option('--port', 5182)), spp = Number(option('--spp', 16)), width = Number(option('--width', 480)), ev = Number(option('--ev', 0)), fNumber = Number(option('--fnumber', 0));
const executablePath = option('--chromium', process.env.CHROMIUM_PATH), headed = args.includes('--headed');
const viewport = (option('--viewport', '1280x800')).split('x').map(Number);
let playwright;
try { playwright = await import(process.env.PLAYWRIGHT_MODULE || 'playwright'); }
catch { console.error('Playwright is required: npm install --no-save playwright && npx playwright install chromium (or set PLAYWRIGHT_MODULE).'); process.exit(2); }
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: ['ignore', 'pipe', 'inherit'] });
const cleanup = () => { try { server.kill(); } catch {} };
process.on('exit', cleanup);
await new Promise((resolve, reject) => { server.stdout.on('data', d => { if (String(d).includes('Local')) resolve(); }); server.on('exit', code => reject(new Error('vite exited ' + code))); });
const browser = await playwright.chromium.launch({ headless: !headed, executablePath, args: (process.env.GPU_ARGS || '--enable-unsafe-webgpu --enable-features=Vulkan,WebGPUService --use-vulkan=swiftshader --use-webgpu-adapter=swiftshader --disable-vulkan-surface --use-angle=swiftshader --ignore-gpu-blocklist --disable-gpu-watchdog').split(' ') });
const page = await browser.newPage({ viewport: { width: viewport[0], height: viewport[1] } });
const logs = []; page.on('console', m => logs.push(`${m.type()}: ${m.text()}`)); page.on('pageerror', e => logs.push('pageerror: ' + e.message));
mkdirSync('artifacts', { recursive: true });
const t0 = Date.now(), stamp = label => logs.push(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${label}`);
const result = { viewport, spp, width, ev, fNumber };
try {
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => document.querySelector('#scene')?.dataset.ready === 'true' || document.querySelector('#loading')?.classList.contains('error'), null, { timeout: 3600000, polling: 2000 });
  stamp('page ready');
  result.startup = await page.evaluate(() => ({ dataset: { ...document.querySelector('#scene').dataset }, diagnostics: { initializationWallMs: window.__SANTEI__.diagnostics.initializationWallMs, meshes: window.__SANTEI__.diagnostics.meshes, instances: window.__SANTEI__.diagnostics.instances, triangles: window.__SANTEI__.diagnostics.triangles }, scene: window.__SANTEI__.hybrid.store.getState().scene }));
  await page.screenshot({ path: 'artifacts/app-raster.png', timeout: 900000 });
  const store = 'window.__SANTEI__.hybrid.store';
  await page.evaluate(async ({ spp, width, ev, fNumber }) => { const s = window.__SANTEI__.hybrid.store; await s.dispatch('setResolution', width); await s.dispatch('setTargetSpp', spp); if (ev) await s.dispatch('setExposureEV', ev); if (fNumber) await s.dispatch('setFNumber', fNumber); await s.dispatch('setMode', 'lens'); }, { spp, width, ev, fNumber });
  stamp('lens mode');
  await page.waitForFunction(target => { const s = window.__SANTEI__.hybrid.store.getState(); return s.sampling.spp >= target || s.status === 'error'; }, spp, { timeout: 3600000, polling: 2000 });
  stamp('target spp reached');
  await page.waitForTimeout(3000);
  result.lens = await page.evaluate(() => { const s = window.__SANTEI__.hybrid.store.getState(); return { status: s.status, error: s.error, sampling: s.sampling, diagnostics: s.diagnostics, scene: s.scene, revisions: s.revisions, af: s.af }; });
  await page.screenshot({ path: 'artifacts/app-lens.png', timeout: 900000 });
  // AF-S on the real BVH target, then a few frames.
  await page.evaluate(async () => { await window.__SANTEI__.hybrid.store.dispatch('autofocus').catch(e => e); });
  await page.waitForFunction(target => { const s = window.__SANTEI__.hybrid.store.getState(); return s.af.status !== 'busy' && (s.sampling.spp >= target || s.status === 'error'); }, spp, { timeout: 3600000, polling: 2000 });
  result.af = await page.evaluate(() => window.__SANTEI__.hybrid.store.getState().af);
  await page.screenshot({ path: 'artifacts/app-lens-af.png', timeout: 900000 });
  for (const diagnostic of ['geometry-normal', 'scene-error']) {
    await page.evaluate(d => window.__SANTEI__.hybrid.store.dispatch('setDiagnostic', d), diagnostic);
    await page.waitForFunction(target => { const s = window.__SANTEI__.hybrid.store.getState(); return s.sampling.spp >= Math.min(target, 4) || s.status === 'error'; }, spp, { timeout: 3600000, polling: 2000 });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `artifacts/app-lens-${diagnostic}.png`, timeout: 900000 });
  }
  await page.evaluate(() => window.__SANTEI__.hybrid.store.dispatch('setDiagnostic', 'beauty'));
  // Time changes in lens mode via the real slider (lighting revision path).
  result.timeChanges = [];
  for (const hour of (option('--hours', '0,12')).split(',').map(Number)) {
    const before = await page.evaluate(() => window.__SANTEI__.hybrid.store.getState().revisions.lighting);
    await page.evaluate(h => { const s = document.querySelector('#time-controls input[type=range]'); s.value = String(h); s.dispatchEvent(new Event('input', { bubbles: true })); }, hour);
    await page.waitForFunction(({ before, target }) => { const s = window.__SANTEI__.hybrid.store.getState(); return (s.revisions.lighting > before && s.sampling.spp >= Math.min(target, 16)) || s.status === 'error'; }, { before, target: spp }, { timeout: 3600000, polling: 2000 });
    await page.waitForTimeout(2000);
    const snap = await page.evaluate(() => { const s = window.__SANTEI__.hybrid.store.getState(); return { status: s.status, error: s.error, spp: s.sampling.spp, lighting: s.scene.lighting, rates: { bvh: s.diagnostics.bvhErrorRate, unsupported: s.diagnostics.unsupportedRate, transparency: s.diagnostics.transparencyLimitRate }, gpuErrors: document.querySelector('#scene').dataset.gpuErrors, faults: window.__SANTEI__.diagnostics.errors.slice(-3) }; });
    result.timeChanges.push({ hour, ...snap });
    await page.screenshot({ path: `artifacts/app-lens-hour-${hour}.png`, timeout: 900000 });
  }
  // Narrow layout screenshot for the UI review.
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(3000);
  await page.screenshot({ path: 'artifacts/app-mobile.png', fullPage: false, timeout: 900000 });
  result.gpuErrors = await page.evaluate(() => document.querySelector('#scene').dataset.gpuErrors);
  result.passed = result.lens.status === 'ready' && result.gpuErrors === '0';
} catch (error) { result.error = String(error.stack || error); result.passed = false; await page.screenshot({ path: 'artifacts/app-failure.png' }).catch(() => {}); }
result.wallSeconds = (Date.now() - t0) / 1000;
writeFileSync('artifacts/app-smoke.json', JSON.stringify(result, null, 2)); writeFileSync('artifacts/app-smoke.log', logs.join('\n'));
console.log(JSON.stringify({ passed: result.passed, error: result.error?.slice(0, 500), wallSeconds: result.wallSeconds }));
await browser.close(); cleanup(); process.exit(result.passed ? 0 : 1);
