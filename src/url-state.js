// Share the physical view, not the raster/lens display mode. Keep unrelated
// query parameters (including diagnostics) and the fragment intact.
const VIEW_KEYS=['lens','config','pos','target','focus','focusKnown','imageDistance','fNumber'];
const vector=value=>{
  if(!value)return null;
  const parts=value.split(',');
  if(parts.length!==3||parts.some(v=>v.trim()===''))return null;
  const result=parts.map(Number);
  return result.every(v=>Number.isFinite(v)&&Math.abs(v)<=1e6)?result:null;
};
const number=(value,min,max)=>{
  if(value===null||value.trim()==='')return undefined;
  const result=Number(value);
  return Number.isFinite(result)&&result>=min&&result<=max?result:undefined;
};
const coordinate=value=>String(Number(value.toFixed(6)));

export async function installURLState({camera,controls,store,requestFrame,window:win=window}){
  const params=new URL(win.location.href).searchParams;
  const position=vector(params.get('pos')),target=vector(params.get('target'));
  if(position&&target&&position.some((v,i)=>Math.abs(v-target[i])>1e-6)){
    // Clear any residual orbit damping before installing a complete pose.
    const damping=controls.enableDamping;controls.enableDamping=false;controls.update();
    camera.position.fromArray(position);controls.target.fromArray(target);controls.update();
    controls.enableDamping=damping;
  }
  const lens=params.get('lens');
  const config=number(params.get('config'),0,10000);
  const focus=params.get('focus')==='inf'?null:number(params.get('focus'),.1,10000);
  const gap=number(params.get('imageDistance'),0,1e5);
  const aperture=number(params.get('fNumber'),.01,10000);
  // Restore through the existing validated commands, in physical dependency
  // order: prescription, moving focus group, aperture, final sensor position.
  try{
    if(lens&&lens!==store.getState().lensId)await store.dispatch('selectLens',lens);
    if(Number.isInteger(config)&&config!==store.getState().configurationIndex)await store.dispatch('selectConfiguration',config);
    if(focus!==undefined&&focus!==store.getState().optics.focusDistanceM)await store.dispatch('setFocusDistance',focus);
    if(aperture!==undefined&&aperture!==store.getState().optics.fNumber)await store.dispatch('setFNumber',aperture);
    if(gap!==undefined){
      const optics=store.getState().optics;
      if(gap!==optics.imageDistanceMm)await store.dispatch('setImageDistance',gap);
      // setImageDistance marks manual changes unknown. The saved flag describes
      // whether this exact sensor position came from a successful focus solve.
      if(params.has('focusKnown'))store.update({optics:{...store.getState().optics,focusDistanceKnown:params.get('focusKnown')!=='0'}});
    }
  }catch(error){console.warn('无法完全恢复 URL 中的镜头状态：',error);}

  let timer=null,disposed=false,lastOptics='';
  function write(){
    timer=null;if(disposed)return;
    const state=store.getState();
    if(state.status!=='ready'||state.af.status==='busy')return;
    const url=new URL(win.location.href);
    for(const key of VIEW_KEYS)url.searchParams.delete(key);
    url.searchParams.set('lens',state.lensId);
    url.searchParams.set('config',String(state.configurationIndex));
    url.searchParams.set('pos',camera.position.toArray().map(coordinate).join(','));
    url.searchParams.set('target',controls.target.toArray().map(coordinate).join(','));
    url.searchParams.set('focus',state.optics.focusDistanceM===null?'inf':String(state.optics.focusDistanceM));
    url.searchParams.set('focusKnown',state.optics.focusDistanceKnown===false?'0':'1');
    url.searchParams.set('imageDistance',String(state.optics.imageDistanceMm));
    url.searchParams.set('fNumber',String(state.optics.fNumber));
    if(url.href!==win.location.href)win.history.replaceState(win.history.state,'',url.href);
  }
  function schedule(){win.clearTimeout(timer);timer=win.setTimeout(write,200);}
  const unsubscribe=store.subscribe(state=>{
    const key=JSON.stringify([state.status,state.af.status,state.lensId,state.configurationIndex,
      state.optics.focusDistanceM,state.optics.focusDistanceKnown,state.optics.imageDistanceMm,state.optics.fNumber]);
    if(key!==lastOptics){lastOptics=key;schedule();}
  });
  controls.addEventListener('change',schedule);
  const flush=()=>{win.clearTimeout(timer);write();};
  win.addEventListener('pagehide',flush);
  // The restored view is displayed by the normal render scheduler.
  requestFrame();
  return {dispose(){flush();disposed=true;win.clearTimeout(timer);unsubscribe();controls.removeEventListener('change',schedule);win.removeEventListener('pagehide',flush);}};
}
