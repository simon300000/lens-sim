/** Lens data produced by scripts/build-lens-data.mjs [--out <dir>]: a manifest
 * plus one JSON asset per lens. Assets are resolved relative to the manifest
 * URL, so a host can serve the directory from any base URL, or hand over the
 * already parsed manifest/assets (preloaded) and never fetch at all.
 *   baseUrl: directory URL of manifest.json (default '/lenses/')
 *   manifest: preloaded manifest object; assets: { [id]: asset } preloaded assets */
export function createLensLibrary({baseUrl='/lenses/',manifest=null,assets={},fetch:fetchImpl=globalThis.fetch?.bind(globalThis)}={}){
  const base=new URL(baseUrl,globalThis.location?.href??'file:///');
  const loaded=new Map(Object.entries(assets));
  let manifestPromise=manifest?Promise.resolve(manifest):null;
  async function json(url,what){
    if(!fetchImpl)throw new Error(`${what}: no fetch available; pass preloaded data`);
    const response=await fetchImpl(url);
    if(!response.ok)throw new Error(`${what} missing (${response.status}): run git submodule update --init --recursive and npm run build:lenses`);
    return response.json();
  }
  const library={
    get baseUrl(){return base.href;},
    manifest(){
      manifestPromise??=json(new URL('manifest.json',base),'Lens manifest').catch(error=>{manifestPromise=null;throw error;});
      return manifestPromise;
    },
    /** URL of a manifest entry's asset (absolute paths of older manifests still resolve). */
    assetUrl(entry){return new URL(entry.asset,base);},
    async asset(id){
      if(loaded.has(id))return loaded.get(id);
      const entry=(await library.manifest()).lenses.find(item=>item.id===id);
      if(!entry)throw new Error(`Unknown lens ${id}`);
      if(!entry.supported)throw new Error(entry.reason||`Lens ${id} is not supported`);
      const asset=await json(library.assetUrl(entry),`Lens ${id}`);loaded.set(id,asset);return asset;
    },
    /** The prescription of one configuration, ready for tracer.setLens(). */
    async prescription(id,configurationIndex=0){
      const asset=await library.asset(id),lens=asset.configurations[configurationIndex];
      if(!lens)throw new Error(asset.configurationStatus[configurationIndex]?.reason||'Configuration unavailable');
      return lens;
    },
    glassCatalogUrl(){return new URL('glass-catalog.json',base).href;},
  };
  return library;
}
