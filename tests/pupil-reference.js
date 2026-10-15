// Independent f64 reference: scan the ORIGINAL full disc on a Cartesian grid,
// then refine the discovered support. No stop aiming or production pupil table.
import {traceLens} from '../src/optics/optical-reference.js';
export function pupilReference(lens,packed,height,nm,{coarse=512,fine=256,box=null}={}){
  const R=packed.region.radiusMm,z=packed.sensorZMm,d=z-packed.region.zMm;
  const rayAt=(x,y)=>traceLens(lens,[height,0,z],[x-height,y,-d],{wavelengthNm:nm,stopRadiusMm:packed.stopRadiusMm});
  let support=box;
  if(!support){
    let lo=Infinity,hi=-Infinity,Y=0;const step=2*R/coarse;
    for(let j=0;j<coarse;j++)for(let i=0;i<coarse;i++){
      const x=-R+(i+.5)*step,y=-R+(j+.5)*step;if(x*x+y*y>R*R)continue;
      if(rayAt(x,y).status!==0)continue;lo=Math.min(lo,x);hi=Math.max(hi,x);Y=Math.max(Y,Math.abs(y));
    }
    if(!Number.isFinite(lo))return {energy:0,box:null,missed:0,centroid:[0,0],moments:[0,0],histogram:Array(16).fill(0)};
    support=[lo-3*step,hi+3*step,-Y-3*step,Y+3*step];
  }
  const dx=(support[1]-support[0])/fine,dy=(support[3]-support[2])/fine;
  let energy=0;const centroid=[0,0],moments=[0,0],histogram=Array(16).fill(0);let passed=0;const spots=[];
  for(let j=0;j<fine;j++)for(let i=0;i<fine;i++){
    const x=support[0]+(i+.5)*dx,y=support[2]+(j+.5)*dy;if(x*x+y*y>R*R)continue;
    const ray=rayAt(x,y);if(ray.status!==0)continue;passed++;
    const w=4/Math.PI*d*d/(d*d+(x-height)**2+y*y)**2*dx*dy;energy+=w;
    // Distribution at an out-of-focus object plane, reciprocal to an image of
    // a point emitter. Preserves clipping/cat-eye shape rather than just flux.
    const t=(-1000-ray.point[2])/ray.direction[2],X=ray.point[0]+t*ray.direction[0],Y=ray.point[1]+t*ray.direction[1];
    spots.push([X,Y,w]);
    centroid[0]+=w*X;centroid[1]+=w*Y;moments[0]+=w*X*X;moments[1]+=w*Y*Y;
    const angle=(Math.atan2(y,x-height)+Math.PI)/(2*Math.PI);histogram[Math.min(15,Math.floor(angle*16))]+=w;
  }
  const xs=spots.map(s=>s[0]),ys=spots.map(s=>s[1]);
  let x0=Infinity,x1=-Infinity,y0=Infinity,y1=-Infinity;
  for(let i=0;i<xs.length;i++){x0=Math.min(x0,xs[i]);x1=Math.max(x1,xs[i]);y0=Math.min(y0,ys[i]);y1=Math.max(y1,ys[i]);}
  const px=(x1-x0)*.05,py=(y1-y0)*.05,spotBox=[x0-px,x1+px,y0-py,y1+py],spotHistogram=Array(64).fill(0);
  for(const [X,Y,w]of spots){const i=Math.max(0,Math.min(7,Math.floor((X-spotBox[0])/(spotBox[1]-spotBox[0])*8))),j=Math.max(0,Math.min(7,Math.floor((Y-spotBox[2])/(spotBox[3]-spotBox[2])*8)));spotHistogram[j*8+i]+=w;}
  return {spotBox,spotHistogram,energy,box:support,passed,centroid:centroid.map(x=>x/energy),moments:moments.map(x=>x/energy),histogram};
}
