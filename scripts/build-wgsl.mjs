#!/usr/bin/env node
/** WGSL as plain JS string modules: every src/**\/X.wgsl gets a sibling
 * X.wgsl.js (`export default "..."`, LF line endings) that Vite, webpack/Next,
 * Node and workers all import without a raw-text loader. The .wgsl files stay
 * the source of truth; the generated modules are git-ignored and rebuilt by
 * `prepare`, `predev`, `prebuild` and `pretest`. The Vite dev server serves the
 * modules straight from the .wgsl sources (vite.config.js), so editing a shader
 * needs no rebuild there.
 *   node scripts/build-wgsl.mjs [root=src]
 */
import {readdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const wgslModule=text=>`// Generated from the sibling .wgsl by scripts/build-wgsl.mjs. Do not edit.\nexport default ${JSON.stringify(text.replace(/\r\n/g,'\n'))};\n`;

export function buildWGSLModules(root){
  const written=[];
  const walk=dir=>{for(const entry of readdirSync(dir,{withFileTypes:true})){
    const path=join(dir,entry.name);
    if(entry.isDirectory())walk(path);
    else if(entry.name.endsWith('.wgsl')){
      const module=wgslModule(readFileSync(path,'utf8')),target=path+'.js';
      if(!existsSync(target)||readFileSync(target,'utf8')!==module){writeFileSync(target,module);written.push(target);}
    }
  }};
  walk(root);return written;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const root=resolve(fileURLToPath(new URL('..',import.meta.url)),process.argv[2]??'src');
  const written=buildWGSLModules(root);
  console.log(`WGSL modules: ${written.length} updated`);
}
