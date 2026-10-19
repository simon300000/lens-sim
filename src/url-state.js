// Share the physical view, not the raster/lens display mode. Keep unrelated
// query parameters (including diagnostics) and the fragment intact.
const VIEW_KEYS=['lens','config','pos','target','focus','focusKnown','focusSolver','imageDistance','fNumber'];
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
    if(aperture!==undefined){const s=store.getState(),f=Math.max(s.limits.fNumber[0],Math.min(s.limits.fNumber[1],aperture));if(f!==s.optics.fNumber)await store.dispatch('setFNumber',f);}
    // Old links contain sensor gaps from the retired fixed-sensor focus path.
    // Recompute known focus instead of applying that stale result over the solve.
    if(gap!==undefined&&(params.get('focusKnown')==='0'||params.get('focusSolver')==='bench-v1')){
      const optics=store.getState().optics;
      if(gap!==optics.imageDistanceMm)await store.dispatch('setImageDistance',gap);
      // setImageDistance marks manual changes unknown. The saved flag describes
      // whether this exact sensor position came from a successful focus solve.
      if(params.has('focusKnown'))store.update({optics:{...store.getState().optics,focusDistanceKnown:params.get('focusKnown')!=='0'}});
    }
  }catch(error){console.warn('无法完全恢复 URL 中的镜头状态：',error);}

  const IDLE_WRITE_DELAY_MS=1000;
  let timer=null,disposed=false,lastOptics='',interacting=Boolean(controls.active);
  const active=()=>interacting||Boolean(controls.active);
  function cancel(){win.clearTimeout(timer);timer=null;}
  function write(){
    timer=null;if(disposed||active())return;
    const state=store.getState();
    if(state.status!=='ready'||state.af.status==='busy')return;
    const url=new URL(win.location.href);
    for(const key of VIEW_KEYS)url.searchParams.delete(key);
    url.searchParams.set('pos',camera.position.toArray().map(coordinate).join(','));
    url.searchParams.set('target',controls.target.toArray().map(coordinate).join(','));
    // Imported/edited prescriptions exist only in this page: share the pose, never a dangling lens.
    if(!state.lensId.startsWith('custom:')){
      url.searchParams.set('lens',state.lensId);
      url.searchParams.set('config',String(state.configurationIndex));
      url.searchParams.set('focus',state.optics.focusDistanceM===null?'inf':String(state.optics.focusDistanceM));
      url.searchParams.set('focusKnown',state.optics.focusDistanceKnown===false?'0':'1');
      url.searchParams.set('focusSolver','bench-v1');
      url.searchParams.set('imageDistance',String(state.optics.imageDistanceMm));
      url.searchParams.set('fNumber',String(state.optics.fNumber));
    }
    if(url.href!==win.location.href)win.history.replaceState(win.history.state,'',url.href);
  }
  // A pause between pointer events is not the end of a drag. Avoid history
  // writes (and timer churn) until the rig has released input AND settled.
  function schedule(){cancel();if(!disposed&&!active())timer=win.setTimeout(write,IDLE_WRITE_DELAY_MS);}
  function start(){interacting=true;cancel();}
  function end(){interacting=false;schedule();}
  const unsubscribe=store.subscribe(state=>{
    const key=JSON.stringify([state.status,state.af.status,state.lensId,state.configurationIndex,
      state.optics.focusDistanceM,state.optics.focusDistanceKnown,state.optics.imageDistanceMm,state.optics.fNumber]);
    if(key!==lastOptics){lastOptics=key;schedule();}
  });
  controls.addEventListener('change',schedule);
  controls.addEventListener('start',start);
  controls.addEventListener('end',end);
  win.addEventListener('pagehide',cancel);
  // The restored view is displayed by the normal render scheduler.
  requestFrame();
  return {dispose(){disposed=true;cancel();unsubscribe();controls.removeEventListener('change',schedule);controls.removeEventListener('start',start);controls.removeEventListener('end',end);win.removeEventListener('pagehide',cancel);}};
}
