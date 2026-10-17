#!/usr/bin/env node
/**
 * Repeated BVH benchmark. Hardware by default; --software explicitly opts in.
 * Install Playwright locally or set PLAYWRIGHT_MODULE.
 * Browser-only: npm run dev, then /tests/bvh-benchmark.html?hardware=1.
 * SwiftShader.ini is read from the launch working directory, when present.
 */
import { createServer } from 'vite';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { availableParallelism } from 'node:os';

const root = fileURLToPath(new URL('..', import.meta.url));
const launchCwd = process.cwd();
const args = process.argv.slice(2), originalArgs = [...args];
const option = (name, fallback) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Missing value: ' + name);
  return args.splice(i, 2)[1];
};
const flag = name => {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
};
const software = flag('--software'), headed = flag('--headed');
const requestedExecutablePath = option('--chromium', process.env.CHROMIUM_PATH);
const output = resolve(option('--out', resolve(root, 'artifacts/bvh-benchmark.json')));
const partialOutput = output.replace(/\.json$/, '') + '.partial.json';
const logOutput = output.replace(/\.json$/, '') + '.log';
const q = new URLSearchParams({
  rays: option('--rays', '8192'),
  rounds: option('--rounds', '9'),
  warmups: option('--warmups', '2'),
});
for (const key of ['workloads', 'variants', 'label']) {
  const value = option('--' + key);
  if (value) q.set(key, value);
}
if (!software) q.set('hardware', '1');
if (args.length) throw new Error('Unknown options: ' + args.join(' '));

const readText = path => {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
};
const procStatus = readText('/proc/self/status');
const host = {
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  availableParallelism: availableParallelism(),
  cpuAffinity: procStatus ? /^Cpus_allowed_list:\s*(.*)$/m.exec(procStatus)?.[1] ?? null : null,
  cpuQuota: readText('/sys/fs/cgroup/cpu.max')?.trim() ?? null,
  cpuSet: readText('/sys/fs/cgroup/cpuset.cpus.effective')?.trim() ?? null,
};
const softwareConfigPath = resolve(launchCwd, 'SwiftShader.ini');
const softwareConfiguration = software ? readText(softwareConfigPath) : null;
const playwrightSpecifier = process.env.PLAYWRIGHT_MODULE || 'playwright';
let playwrightModule = playwrightSpecifier;
try { playwrightModule = import.meta.resolve(playwrightSpecifier); } catch {}
const browserArgs = software
  ? ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPUService', '--use-vulkan=swiftshader',
    '--use-webgpu-adapter=swiftshader', '--disable-vulkan-surface', '--use-angle=swiftshader',
    '--ignore-gpu-blocklist', '--disable-gpu-watchdog']
  : ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--disable-gpu-watchdog'];
const started = Date.now();
const logs = [];
let server, browser, page, result, exitCode = 1;
let browserVersion = null, executablePath = requestedExecutablePath ?? null;
let checkpointQueue = Promise.resolve(), preparingCount = 0;
const driver = () => ({
  args: originalArgs,
  query: Object.fromEntries(q),
  host,
  softwareRequested: software,
  softwareConfiguration,
  softwareConfigPath: software && softwareConfiguration !== null ? softwareConfigPath : null,
  launchCwd,
  executablePath,
  PLAYWRIGHT_MODULE: process.env.PLAYWRIGHT_MODULE ?? null,
  playwrightModule,
  browserVersion,
  browserArgs,
  headed,
  wallSeconds: (Date.now() - started) / 1000,
  checkpointPolicy: 'One snapshot at each transition to the next workload and after Completed; no snapshot per dispatch or measured round.',
});
const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
};

/**
 * Console transition messages occur outside the measured dispatch loop.
 * Serialize checkpoint requests and await the queue before final cleanup.
 * The partial file is a recovery snapshot; only the final file is the result.
 */
function checkpoint(reason) {
  checkpointQueue = checkpointQueue.then(async () => {
    if (!page || page.isClosed()) return;
    const snapshot = await page.evaluate(() => window.__bvhBenchmark ?? null);
    if (!snapshot) return;
    const completeWorkloads = (snapshot.workloads ?? [])
      .filter(w => w.variants?.length && w.variants.every(v => typeof v.passed === 'boolean'))
      .map(w => w.name);
    writeJson(partialOutput, {
      ...snapshot,
      driver: driver(),
      checkpoint: { reason, createdAt: new Date().toISOString(), completeWorkloads, partial: true },
    });
    logs.push('checkpoint: ' + reason + ' -> ' + partialOutput);
  }).catch(error => {
    logs.push('checkpoint error: ' + (error.stack || String(error)));
  });
}

try {
  let playwright;
  try { playwright = await import(playwrightSpecifier); }
  catch (error) {
    throw new Error('Install Playwright with npm i --no-save playwright, or set PLAYWRIGHT_MODULE.', { cause: error });
  }
  // Explicitly pass this path so the recorded executable matches the one run,
  // including when Playwright would otherwise choose a separate headless shell.
  executablePath = requestedExecutablePath
    ? resolve(launchCwd, requestedExecutablePath)
    : playwright.chromium.executablePath();
  server = await createServer({
    root,
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
  });
  await server.listen();
  const port = server.httpServer.address().port;
  browser = await playwright.chromium.launch({ headless: !headed, executablePath, args: browserArgs });
  browserVersion = browser.version();
  page = await browser.newPage();
  page.on('console', message => {
    const text = message.text();
    logs.push(message.type() + ': ' + text);
    if (!text.startsWith('[step]')) return;
    console.log(text);
    if (text.startsWith('[step] Preparing ')) {
      preparingCount++;
      if (preparingCount > 1) checkpoint(text);
    } else if (text.startsWith('[step] Completed')) {
      checkpoint(text);
    }
  });
  page.on('pageerror', error => logs.push('pageerror: ' + error.message));
  await page.addInitScript(() => {
    window.addEventListener('error', event => { window.__pageError = event.message || String(event.error); });
    window.addEventListener('unhandledrejection', event => { window.__pageError = String(event.reason); });
  });
  await page.goto('http://127.0.0.1:' + port + '/tests/bvh-benchmark.html?' + q);
  await page.waitForFunction(() => document.body.dataset.passed || window.__pageError, null, { timeout: 1800000, polling: 1000 });
  result = await page.evaluate(() => window.__bvhBenchmark || { passed: false, errors: [window.__pageError || 'No benchmark report'] });
  const pageError = await page.evaluate(() => window.__pageError);
  if (pageError) { result.passed = false; (result.errors ||= []).push(pageError); }
  exitCode = result.passed ? 0 : 1;
} catch (error) {
  if (page && !page.isClosed()) {
    try { result = await page.evaluate(() => window.__bvhBenchmark ?? null); } catch {}
  }
  result ||= { passed: false, errors: [] };
  result.passed = false;
  (result.errors ||= []).push(error.stack || String(error));
} finally {
  await checkpointQueue;
  result ||= { passed: false, errors: ['Benchmark ended without a report'] };
  // Always save environment and launch parameters, including failure paths.
  result.driver = driver();
  try {
    writeJson(output, result);
    writeFileSync(logOutput, logs.join('\n') + '\n');
  } finally {
    try { await browser?.close(); } finally { await server?.close(); }
  }
}
console.log((exitCode ? 'FAIL ' : 'PASS ') + output);
process.exitCode = exitCode;

