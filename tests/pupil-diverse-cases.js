// Test domains chosen to fit the supplied prescription field heights. These
// rectangles are experiment domains, not a claim about missing vendor apertures.
const ff=[36,24],aps=[23.6,15.6],mft=[17.28,12.96],mf=[44,33];
export const diversePupilCases=[
 ['smc-pentax-m-40mm-f2-8',0,ff,'Pentax','simple spherical',true],
 ['voigtlander-portrait-heliar-75mm-f1-8',0,ff,'Voigtlander','simple spherical portrait',false],
 ['leica-summilux-m-35mm-f1-4-asph',0,ff,'Leica','compact aspherical',true],
 ['nikon-ai-s-nikkor-50mm-f1-2',0,ff,'Nikon','fast spherical',false],
 ['nikon-z-58mm-f0-95-noct-s',0,ff,'Nikon','very fast multi-asphere',true],
 ['nikon-z-14-24mm-f2-8-s',0,ff,'Nikon','ultrawide zoom wide end',true],
 ['nikon-z-14-24mm-f2-8-s',4,ff,'Nikon','ultrawide zoom long end',false],
 ['sigma-16mm-f1-4-dc-dn-contemporary',0,aps,'Sigma','complex fast APS-C asphere',true],
 ['olympus-m-zuiko-digital-ed-17mm-f1-2-pro',0,mft,'Olympus','six aspherical surfaces',false],
 ['olympus-m-zuiko-digital-ed-8mm-f1-8-fisheye-pro',0,mft,'Olympus','fisheye',false],
 ['sony-fe-600mm-f4-gm-oss',0,ff,'Sony','41-surface supertelephoto',true],
 ['canon-ef-400mm-f4-do-is-ii-usm',0,ff,'Canon','diffractive DOE telephoto',true],
 ['canon-rf-28mm-f2-8-stm',0,ff,'Canon','compact six-XODD surfaces',false],
 ['fujifilm-xf-16mm-f1-4-r-wr',0,aps,'Fujifilm','four-XODD fast wide',false],
 ['fujifilm-gf-80mm-f1-7-r-wr',0,mf,'Fujifilm','XODD medium-format fast',false],
 ['fujifilm-gf-110mm-f2-r-lm-wr',0,mf,'Fujifilm','medium-format portrait',false],
 ['fujifilm-xf-14mm-f2-8-r',0,aps,'Fujifilm','native angular XODD control',false],
 ['hasselblad-xcd-65mm-f2-8',0,mf,'Hasselblad','native angular control',false],
].map(([id,config,sensorMm,brand,structure,stress1024])=>({id,config,sensorMm,brand,structure,stress1024,key:`${id}@${config}`}));
export function experimentCases(options,defaultIds){
 if(options.get('suite')==='diverse'){
  const selected=options.get('cases')?.split(',');return diversePupilCases.filter(x=>!selected||selected.includes(x.key)||selected.includes(x.id));
 }
 return (options.has('lens')?[options.get('lens')]:defaultIds).map(id=>({id,config:Number(options.get('config')??0),sensorMm:[36,24],key:`${id}@${Number(options.get('config')??0)}`}));
}
export function experimentVariants(spec,diverse=false){
 const choices=diverse?[[128,false],[128,true],...(spec.stress1024?[[1024,false]]:[])]:[128,256,512,1024].flatMap(n=>[[n,false],[n,true]]);
 return choices.map(([bins,movingCenter])=>({name:(movingCenter?'moving':'fixed')+bins,bins,movingCenter}));
}
export function prescriptionSummary(lens){return {surfaces:lens.surfaces.length,aspheres:lens.surfaces.filter(s=>s.aspheric?.some(x=>x!==0)).length,xodd:lens.surfaces.filter(s=>s.xodd).length,doe:lens.surfaces.filter(s=>s.doe).length,knownApertures:lens.surfaces.filter(s=>s.apertureRadiusMm!=null).length,fieldExtent:lens.metadata?.fieldExtent,warnings:lens.warnings,capabilityWarnings:lens.capabilityWarnings};}
