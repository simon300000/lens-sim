import {searchFocus} from './focus-search.js';
self.onmessage=({data})=>{
  try{self.postMessage({id:data.id,ok:true,result:searchFocus(data.lens,data.distanceM,data.options)});}
  catch(error){self.postMessage({id:data.id,ok:false,error:error.message});}
};
