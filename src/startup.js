import { startup } from './startup-progress.js';

// Keep the loading curtain independent of the large Three.js module graph.
await startup.stage(0,'正在载入渲染程序');
try{
  await import('./main.js');
}catch(error){
  console.error(error);
  startup.fail(error);
}
