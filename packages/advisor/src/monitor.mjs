import {assertObservation,iso} from './core.mjs';
// Call from the HOST's existing scheduler. No timer or external request is installed here.
export async function collectSignals({collectors=[],previous={},now=new Date().toISOString()}={}){
 if(!iso(now))throw new Error('Valid collection timestamp required');
 const sources={...previous};
 for(const collector of collectors){
  const prior=previous[collector.id]||{};
  if(collector.authorized!==true){sources[collector.id]={...prior,lastAttemptedAt:now,status:'unconnected',error:'Host has not authorized this source'};continue;}
  try {const result=await collector.collect();if(!Array.isArray(result.observations))throw new Error('Missing observations');
   const all=[...(prior.observations||[])];for(const o of result.observations){assertObservation(o);if(Date.parse(o.observedAt)>Date.parse(now))throw new Error('Future observation');if(!all.some(x=>x.id===o.id))all.push(o);}
   sources[collector.id]={...prior,lastAttemptedAt:now,lastSuccessfulAt:now,status:'ok',observations:all,coverage:result.coverage||'Bounded sample',error:null};
  }catch(e){sources[collector.id]={...prior,lastAttemptedAt:now,status:'stale',error:String(e.message)};}
 }
 return sources;
}
