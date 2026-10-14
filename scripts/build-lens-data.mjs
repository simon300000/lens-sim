/** Reproducible build-only adapter. Never fetches or executes upstream code. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseGlassCatalog } from '../src/optics/glass.js';
import { adaptLensRecord, inspectLensRecord } from '../src/optics/prescription.js';
import { preflightLens } from '../src/optics/capabilities.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendor = path.join(root, 'vendor/lens-bench');
const output = path.join(root, 'public/lenses');
const upstream = 'https://github.com/anvcor/lens-bench';

/** Limited extraction of known static data literals; rejects executable syntax. */
export function extractStaticObject(source, name) {
  const prefix = new RegExp(`\\bvar\\s+${name}\\s*=\\s*\\{`).exec(source);
  if (!prefix) throw new Error(`Upstream data declaration ${name} changed; review adapter`);
  const start = prefix.index + prefix[0].length - 1;
  let depth = 0, quote = '', comment = '', end = -1;
  for (let i = start; i < source.length; i++) {
    const ch = source[i], next = source[i + 1];
    if (comment === '//') { if (ch === '\n') comment = ''; continue; }
    if (comment === '/*') { if (ch === '*' && next === '/') { comment = ''; i++; } continue; }
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue; }
    if (ch === '/' && (next === '/' || next === '*')) { comment = ch + next; i++; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '{') depth++;
    if (ch === '}' && --depth === 0) { end = i + 1; break; }
  }
  if (end < 0) throw new Error(`Unterminated static ${name}`);
  const literal = source.slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\r\n]*/g, '')
    .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_, s) => JSON.stringify(s.replace(/\\'/g, "'")))
    .replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)(\s*:)/g, '$1"$2"$3')
    .replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(literal);
}

export async function loadUpstreamCatalog(base = vendor) {
  let rawSource, optics;
  try { [rawSource, optics] = await Promise.all([fs.readFile(path.join(base, 'js/glassdb.js'), 'utf8'), fs.readFile(path.join(base, 'js/optics.js'), 'utf8')]); }
  catch { throw new Error('lens-bench submodule is missing or incomplete. Run: git submodule update --init --recursive, then npm run build:lenses'); }
  const match = /\bvar\s+GLASSDB_RAW\s*=\s*`([^`]*)`\s*;/.exec(rawSource);
  if (!match) throw new Error('Upstream glass table format changed; review adapter');
  const models = { ...extractStaticObject(optics, 'CATALOG'), ...extractStaticObject(optics, 'GNEW') };
  const formulas = {};
  for (const [name, [type, coefficients, label]] of Object.entries(extractStaticObject(optics, 'FORMULA'))) {
    if (!['sellmeier1', 'schott'].includes(type)) throw new Error(`Unsupported upstream fallback formula ${type}`);
    formulas[name] = { name: label, formula: type === 'sellmeier1' ? 'M' : 'L', coefficients, source: 'lens-bench explicitly declared formula' };
  }
  return parseGlassCatalog(match[1], { aliases: extractStaticObject(optics, 'GALIAS'), models, formulas });
}

export async function buildLensData() {
  const catalog = await loadUpstreamCatalog();
  const license = (await fs.readFile(path.join(vendor, 'LICENSE'), 'utf8')).replace(/\r\n/g, '\n');
  if (!license.includes('GNU GENERAL PUBLIC LICENSE') || !license.includes('Version 3')) throw new Error('Upstream license changed; review licensing before conversion');
  let sha;
  try { sha = execFileSync('git', ['-C', vendor, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch { throw new Error('Cannot read lens-bench pinned Git SHA. Initialize the submodule and run this script from a checkout with readable Git metadata.'); }
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid upstream commit SHA');
  const indexSource = await fs.readFile(path.join(vendor, 'data/index.js'), 'utf8');
  const indexMatch = /^\s*window\.LENSDB=\{index:(\[[\s\S]*\]),inline:\{\},base:"data\/lenses\/"\};?\s*$/.exec(indexSource);
  if (!indexMatch) throw new Error('Upstream index format changed; review adapter');
  const metadata = new Map(JSON.parse(indexMatch[1]).map(item => [item.id, item]));
  const files = (await fs.readdir(path.join(vendor, 'data/lenses'))).filter(file => file.endsWith('.json')).sort();
  await fs.mkdir(output, { recursive: true });
  const entries = [];
  for (const file of files) {
    const record = JSON.parse(await fs.readFile(path.join(vendor, 'data/lenses', file), 'utf8'));
    if (!/^[a-z0-9-]+$/.test(record.id) || file !== `${record.id}.json`) throw new Error(`Invalid lens asset id: ${record.id}`);
    const inspected = inspectLensRecord(record, catalog);
    const configurations = [], configurationStatus = [];
    for (const status of inspected.configurations) {
      if (!status.supported) {
        configurations.push(null);
        configurationStatus.push({ ...status, parserSupported: false, gpuValidated: false, validation: 'parser-rejected', warnings: [...(record.warn ?? [])] });
        continue;
      }
      const lens = adaptLensRecord(record, catalog, { configurationIndex: status.index });
      const capability = preflightLens(lens);
      lens.capabilityWarnings = capability.warnings;
      lens.capability = capability;
      configurations.push(capability.supported ? lens : null);
      configurationStatus.push({ ...status, ...capability, warnings: [...status.warnings, ...capability.warnings] });
    }
    const supported = configurationStatus.some(cfg => cfg.supported);
    const asset = { schemaVersion: 1, id: record.id, source: { repository: upstream, commit: sha, path: `data/lenses/${file}`, license: 'GPL-3.0', modified: 'lens-sim normalized data adapter' }, upstreamWarnings: [...(record.warn ?? [])], configurations, configurationStatus };
    await fs.writeFile(path.join(output, file), JSON.stringify(asset) + '\n');
    const meta = metadata.get(record.id) ?? {};
    entries.push({ ...inspected, parserSupported: inspected.supported, supported, gpuValidated: false, validation: 'static-preflight-only',
      configurations: configurationStatus.map(({warnings, ...status}) => status),
      reason: supported ? null : configurationStatus.find(cfg => cfg.parserSupported)?.reason ?? configurationStatus[0].reason,
      asset: `/lenses/${file}`, brand: meta.brand ?? null, origin: meta.origin ?? null, originNote: meta.originNote ?? null, spec: meta.spec ?? null, surfaceCount: configurations.find(Boolean)?.surfaces.length ?? null });
  }
  const defaultId = 'canon-fl-50mm-f1-8';
  if (!entries.find(entry => entry.id === defaultId)?.supported) throw new Error('Reviewed default canon-fl-50mm-f1-8 is unavailable; select a reviewed replacement explicitly');
  const manifest = { schemaVersion: 1, source: { repository: upstream, branch: 'main', commit: sha, license: 'GPL-3.0' }, defaultId, lenses: entries };
  await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest) + '\n');
  await fs.writeFile(path.join(output, 'LICENSE.lens-bench.txt'), license);
  const summary = { commit: sha, total: entries.length, parserSupported: entries.filter(entry => entry.parserSupported).length,
    supported: entries.filter(entry => entry.supported).length, unsupported: entries.filter(entry => !entry.supported).length,
    parserSupportedConfigurations: entries.flatMap(e => e.configurations).filter(c => c.parserSupported).length,
    preflightSupportedConfigurations: entries.flatMap(e => e.configurations).filter(c => c.supported).length, gpuValidatedConfigurations: 0, defaultId };
  console.log(JSON.stringify(summary));
  return { manifest, summary };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildLensData().catch(error => { console.error(`Lens data build failed: ${error.message}`); process.exitCode = 1; });
}
