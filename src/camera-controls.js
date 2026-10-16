import { Vector3 } from 'three';

/** Wheel travel moves the camera and orbit centre together. Other OrbitControls
 * inputs, including touch pinch and middle-button dolly, keep their behaviour. */
export function installCameraWheelTravel(controls,element){
  const forward=new Vector3();
  let endTimer=null;
  function finish(){
    if(endTimer===null)return;
    clearTimeout(endTimer);endTimer=null;
    controls.dispatchEvent({type:'end',travelSource:'wheel'});
  }
  function wheel(event){
    if(!controls.enabled)return;
    // Trackpad pinch uses ctrl+wheel; retain the existing pinch zoom gesture.
    if(event.ctrlKey)return;
    event.preventDefault();event.stopImmediatePropagation();
    const unit=event.deltaMode===1?16:event.deltaMode===2?element.clientHeight:1;
    const distance=-Math.max(-1000,Math.min(1000,event.deltaY*unit))*.01;
    if(!distance)return;
    if(endTimer===null)controls.dispatchEvent({type:'start',travelSource:'wheel'});
    else clearTimeout(endTimer);
    controls.object.getWorldDirection(forward).multiplyScalar(distance);
    controls.object.position.add(forward);
    controls.target.add(forward);
    controls.update();
    endTimer=setTimeout(finish,160);
  }
  // Run before OrbitControls' bubbling wheel listener, preserving all its
  // pointer and touch listeners while replacing wheel dolly alone.
  element.addEventListener('wheel',wheel,{capture:true,passive:false});
  return ()=>{element.removeEventListener('wheel',wheel,{capture:true});finish();};
}

/** Reuse OrbitControls' pointer/touch gestures and damping, but remove the
 * translation caused by rotation. Pan and dolly still translate the camera. */
export function installCameraLookAround(controls){
  const previousOffset=new Vector3(),rotationTravel=new Vector3();
  const originalUpdate=controls.update;
  let pending=false;
  function correctRotation(){
    if(!pending)return;
    pending=false;
    const radius=previousOffset.length();
    if(radius===0)return;
    rotationTravel.subVectors(controls.object.position,controls.target)
      .setLength(radius).sub(previousOffset);
    controls.object.position.sub(rotationTravel);
    controls.target.sub(rotationTravel);
    controls.object.updateMatrixWorld();
  }
  // Register before application listeners so they observe the final pose.
  controls.addEventListener('change',correctRotation);
  controls.update=function(...args){
    previousOffset.subVectors(this.object.position,this.target);
    pending=true;
    try{return originalUpdate.apply(this,args);}
    finally{correctRotation();}
  };
  return ()=>{controls.update=originalUpdate;controls.removeEventListener('change',correctRotation);};
}

/** Ground-plane WASD travel. Move the orbit centre with the camera so the next
 * pointer rotation stays in place. Advance only from the application's RAF. */
export function installCameraKeyboardTravel(controls,{target=window,document:doc=document,speed=4}={}){
  const keys=new Set(),forward=new Vector3(),right=new Vector3(),travel=new Vector3();
  const codes=new Set(['KeyW','KeyA','KeyS','KeyD']);
  const editing=element=>element?.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(element?.tagName);
  function finish(){if(!keys.size)return;keys.clear();controls.dispatchEvent({type:'end',travelSource:'keyboard'});}
  function down(event){
    if(!codes.has(event.code)||!controls.enabled||event.ctrlKey||event.metaKey||event.altKey||editing(event.target))return;
    event.preventDefault();if(keys.has(event.code))return;
    if(!keys.size)controls.dispatchEvent({type:'start',travelSource:'keyboard'});
    keys.add(event.code);
  }
  function up(event){if(!keys.delete(event.code))return;if(!keys.size)controls.dispatchEvent({type:'end',travelSource:'keyboard'});}
  function visibility(){if(doc.hidden)finish();}
  function focus(event){if(editing(event.target))finish();}
  target.addEventListener('keydown',down);target.addEventListener('keyup',up);target.addEventListener('blur',finish);
  doc.addEventListener('visibilitychange',visibility);doc.addEventListener('focusin',focus);
  return {
    get active(){return keys.size>0;},
    update(seconds){
      if(!keys.size)return;
      if(!controls.enabled||doc.hidden){finish();return;}
      controls.object.getWorldDirection(forward);forward.y=0;
      if(forward.lengthSq()<1e-8){right.set(1,0,0).applyQuaternion(controls.object.quaternion);right.y=0;forward.crossVectors(controls.object.up,right);}
      forward.normalize();right.crossVectors(forward,controls.object.up).normalize();
      travel.copy(forward).multiplyScalar(Number(keys.has('KeyW'))-Number(keys.has('KeyS')))
        .addScaledVector(right,Number(keys.has('KeyD'))-Number(keys.has('KeyA')));
      if(!travel.lengthSq())return;
      travel.normalize().multiplyScalar(speed*Math.max(0,Math.min(.05,seconds)));
      controls.object.position.add(travel);controls.target.add(travel);
    },
    dispose(){finish();target.removeEventListener('keydown',down);target.removeEventListener('keyup',up);target.removeEventListener('blur',finish);doc.removeEventListener('visibilitychange',visibility);doc.removeEventListener('focusin',focus);},
  };
}
