import {buildPupilTable} from './pupil-sampling.js';
self.onmessage=({data:{id,lens,packed,options}})=>{
  try{
    const table=buildPupilTable(lens,packed,options);
    self.postMessage({id,ok:true,table},[table.data.buffer]);
  }catch(error){self.postMessage({id,ok:false,error:error.message});}
};
