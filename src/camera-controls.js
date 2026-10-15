import { Vector3 } from 'three';

/** Wheel travel moves the camera and orbit centre together. Other OrbitControls
 * inputs, including touch pinch and middle-button dolly, keep their behaviour. */
export function installCameraWheelTravel(controls,element){
  const forward=new Vector3();
  let endTimer=null;
  function finish(){
    if(endTimer===null)return;
    clearTimeout(endTimer);endTimer=null;
    controls.dispatchEvent({type:'end'});
  }
  function wheel(event){
    if(!controls.enabled)return;
    // Trackpad pinch uses ctrl+wheel; retain the existing pinch zoom gesture.
    if(event.ctrlKey)return;
    event.preventDefault();event.stopImmediatePropagation();
    const unit=event.deltaMode===1?16:event.deltaMode===2?element.clientHeight:1;
    const distance=-Math.max(-1000,Math.min(1000,event.deltaY*unit))*.01;
    if(!distance)return;
    if(endTimer===null)controls.dispatchEvent({type:'start'});
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
