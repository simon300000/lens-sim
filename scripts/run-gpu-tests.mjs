#!/usr/bin/env node
/** Runs the real-WebGPU acceptance pages in Chromium via Playwright and saves
 * results under artifacts/ (git-ignored). Not part of `npm test`: it needs a
 * browser with WebGPU. On machines without a GPU, Chromium's SwiftShader
 * adapter is used; its timings describe SwiftShader, not hardware.
 *   node scripts/run-gpu-tests.mjs [page ...] [--port 5179] [--chromium /path/to/chrome] [--headed]
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : fallback; };
const port = Number(option('--port', 5179)), executablePath = option('--chromium', process.env.CHROMIUM_PATH), headed = args.includes('--headed');
const pages = args.filter(a => !a.startsWith('--'));
const all = ['scene-bvh-gpu', 'hybrid-chain', 'hybrid-optics', 'runtime-gpu', 'imaging-gpu', 'hidden-surface-gpu', 'shading-gpu', 'sampling-gpu', 'hdr-gpu', 'time-pipelines-gpu', 'pupil-engine', 'pupil-gpu?autorun=1', 'doe-gpu', 'catalog-new-forms-gpu', 'native-gap-gpu'];
let playwright;
try { playwright = await import('playwright'); }
catch { try { playwright = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs'); } catch { console.error('Playwright is required: npm i -D playwright (or set PLAYWRIGHT_MODULE).'); process.exit(2); } }
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((resolve, reject) => { server.stdout.on('data', d => { if (String(d).includes('Local')) resolve(); }); server.on('exit', code => reject(new Error('vite exited ' + code))); });
const browser = await playwright.chromium.launch({ headless: !headed, executablePath,
  args: process.env.GPU_ARGS ? process.env.GPU_ARGS.split(' ') : ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPUService', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--disable-vulkan-surface', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--disable-gpu-watchdog'] });
mkdirSync('artifacts/dev', { recursive: true });
let failed = 0;
const cleanup = () => { try { server.kill(); } catch {} };
process.on('exit', cleanup); process.on('SIGINT', () => { cleanup(); process.exit(130); }); process.on('SIGTERM', () => { cleanup(); process.exit(143); });
for (const name of pages.length ? pages : all) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const logs = []; page.on('console', m => { logs.push(`${m.type()}: ${m.text()}`); if (m.text().startsWith('[step]')) console.log(`  ${name} ${m.text()}`); }); page.on('pageerror', e => logs.push('pageerror: ' + e.message));
  const started = Date.now();
  // Module load/syntax errors never reach the page's own try/catch: fail fast.
  await page.addInitScript(() => { window.addEventListener('error', e => { window.__pageError = String(e.message || e.error); }); window.addEventListener('unhandledrejection', e => { window.__pageError = String(e.reason); }); });
  const [file, query] = name.split('?');
  await page.goto(`http://127.0.0.1:${port}/tests/${file}.html${query ? '?' + query : file === 'hybrid-optics' ? '?lens=canon-fl-50mm-f1-8' : ''}`);
  try { await page.waitForFunction(() => document.body.dataset.passed || window.__pageError, null, { timeout: Number(process.env.GPU_TEST_TIMEOUT_MS || 1800000), polling: 1000 }); }
  catch (error) { logs.push('timeout: ' + error.message); }
  const passed = await page.evaluate(() => document.body.dataset.passed || (window.__pageError ? 'false' : undefined));
  const pageError = await page.evaluate(() => window.__pageError);
  if (pageError) logs.push('page error: ' + pageError);
  const text = await page.evaluate(() => document.querySelector('#result')?.textContent ?? '');
  const artifact = name.replace(/[?=&]/g, '_');
  writeFileSync(`artifacts/${artifact}.json`, text);
  writeFileSync(`artifacts/${artifact}.log`, logs.join('\n'));
  console.log(`${passed === 'true' ? 'PASS' : 'FAIL'} ${name} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  if (passed !== 'true') { failed++; console.log(text.slice(0, 3000)); console.log(logs.slice(-20).join('\n')); }
  await page.close();
}
await browser.close(); server.kill();
process.exit(failed ? 1 : 0);
