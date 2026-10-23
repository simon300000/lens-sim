import {traceLens} from './optical-reference.js';

/** Object-side geometry of a prescription and where traced rays actually leave
 * it. Lens space: millimetres, optical axis z, object side towards -z, the
 * sensor at +z (as packLens/optical-core.wgsl). A host that renders the scene
 * from origins on the front element (a ray radiance provider) uses this to
 * place them; tracer world rays start at exactly these exit points. */
export function frontElement(lens){
  const s=lens.surfaces[0];
  const clearRadiusMm=s.apertureRadiusMm??s.drawRadiusMm??null;
  return {surfaceIndex:0,vertexZMm:s.zMm,radiusOfCurvatureMm:s.radiusMm,conic:s.conic,clearRadiusMm,
    clearRadiusKnown:s.apertureRadiusMm!==null&&s.apertureRadiusMm!==undefined};
}

/** CPU reverse trace of a field grid x rear-region disk through the current
 * prescription/stop: exit points (front element) and directions of the rays
 * that pass, per field and overall. Deterministic (stratified, no RNG).
 *   packed: packLens() result (stop radius, sensor position and rear region)
 *   fields: n -> n x n field points over the sensor; samples: rear-disk samples per field */
export function exitFootprint(lens,packed,{fields=5,samples=256,wavelengthNm=587.5618,sensorMm=null}={}){
  const parameters=new Float32Array(packed.parameters.buffer,packed.parameters.byteOffset,16);
  const sensor=sensorMm??[parameters[12],parameters[13]];
  const {region,sensorZMm,stopRadiusMm}=packed,golden=2.399963229728653;
  const perField=[],all={count:0,sum:[0,0],max:0,lo:[Infinity,Infinity],hi:[-Infinity,-Infinity]};
  for(let fy=0;fy<fields;fy++)for(let fx=0;fx<fields;fx++){
    const u=fields===1?.5:fx/(fields-1),v=fields===1?.5:fy/(fields-1);
    const origin=[-(u-.5)*sensor[0],(v-.5)*sensor[1],sensorZMm];
    const field={sensorMm:[origin[0],origin[1]],count:0,centroidMm:[0,0],radiusMm:0,directionMean:[0,0,0]},points=[];
    for(let k=0;k<samples;k++){
      const r=region.radiusMm*Math.sqrt((k+.5)/samples),phi=k*golden;
      const direction=region.directional?[r/region.radiusMm*Math.cos(phi),r/region.radiusMm*Math.sin(phi),-Math.sqrt(Math.max(0,1-(r/region.radiusMm)**2))]
        :[r*Math.cos(phi)-origin[0],r*Math.sin(phi)-origin[1],region.zMm-origin[2]];
      const ray=traceLens(lens,origin,direction,{reverse:true,wavelengthNm,dispersion:false,stopRadiusMm});
      if(ray.status!==0)continue;
      points.push(ray.point);field.count++;
      for(let a=0;a<3;a++)field.directionMean[a]+=ray.direction[a];
      for(let a=0;a<2;a++){all.lo[a]=Math.min(all.lo[a],ray.point[a]);all.hi[a]=Math.max(all.hi[a],ray.point[a]);all.sum[a]+=ray.point[a];}
      all.max=Math.max(all.max,Math.hypot(ray.point[0],ray.point[1]));all.count++;
    }
    if(field.count){
      field.centroidMm=[0,1].map(a=>points.reduce((s,p)=>s+p[a],0)/field.count);
      field.radiusMm=Math.max(...points.map(p=>Math.hypot(p[0]-field.centroidMm[0],p[1]-field.centroidMm[1])));
      const n=Math.hypot(...field.directionMean);field.directionMean=field.directionMean.map(x=>x/n);
    }
    perField.push(field);
  }
  return {front:frontElement(lens),fields:perField,passed:all.count,attempted:fields*fields*samples,
    centroidMm:all.count?all.sum.map(x=>x/all.count):null,maxRadiusMm:all.max,boundsMm:all.count?[...all.lo,...all.hi]:null};
}
