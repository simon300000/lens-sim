/** One-sided feedback: transient slow measurements never shrink a chunk.
 * Work is workgroups × samples per pixel (64 attempted paths per unit).
 * Chunk times come from GPU timestamps (benchmarks) or queue-completion intervals (app).
 */
export function createChunkBudget(){
  const modes={interactive:{work:32,targetMs:3,costs:[]},idle:{work:1024,targetMs:30,costs:[]}};
  return {
    plan(interactive,budget,remaining){
      const mode=modes[interactive?'interactive':'idle'];
      const desired=Math.max(1,Math.floor(mode.work/budget));
      const groups=Math.min(remaining,desired);
      return {groups,work:groups*budget,targetMs:mode.targetMs,tail:groups<desired};
    },
    observe(submission,ms){
      if(!submission?.chunked||submission.tail||!(ms>0&&Number.isFinite(ms)))return;
      const mode=modes[submission.interactive?'interactive':'idle'];
      mode.costs.push(ms/submission.work);if(mode.costs.length>5)mode.costs.shift();
      if(ms>=mode.targetMs)return;
      const ordered=mode.costs.toSorted((a,b)=>a-b),cost=ordered[Math.floor(ordered.length/2)];
      const next=Math.min(mode.work*2,mode.targetMs/cost);
      // Only the image/tile capacity bounds growth, not a fixed ray budget.
      mode.work=Math.max(mode.work,Math.min(submission.capacity,Math.ceil(next)));
    },
  };
}

/** Chunk execution time from queue completions alone. Completions arrive in submission order,
 * so a chunk queued behind another starts roughly when that one finishes; an idle queue starts
 * it at submission. Includes other work on the same queue, which is fine for a readout. */
export function createCompletionClock(){
  let lastDoneAt=-Infinity;
  return {complete(submittedAt,doneAt){const ms=doneAt-Math.max(submittedAt,lastDoneAt);lastDoneAt=Math.max(lastDoneAt,doneAt);return ms;}};
}

/** Linear workgroups laid out across two dispatch dimensions. The shader
 * masks the padded final row, so no pixel is revisited or skipped. */
export function chunkDispatch(groups,maxDimension){
  const x=Math.min(groups,maxDimension),y=Math.ceil(groups/x);
  if(!(groups>0)||y>maxDimension)throw new RangeError('Chunk exceeds GPU dispatch limits');
  return {x,y};
}
