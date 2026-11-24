export const RUBRIC_VERSION='editorial-1';
export const CRITERIA=['hook','clarity','discoveryPayoff','brandFit','actionBridge'];
const finite=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
export function requireObject(x,label='value'){if(!x||typeof x!=='object'||Array.isArray(x))throw new Error(`${label} must be an object`);return x;}
export function iso(x){return typeof x==='string'&&/Z$|[+-]\d\d:\d\d$/.test(x)&&Number.isFinite(Date.parse(x));}
export function assertObservation(o){
 requireObject(o);for(const k of ['id','creativeId','sourceUrl','metric','scope','paidStatus'])if(typeof o[k]!=='string'||!o[k])throw new Error(`Missing ${k}`);
 if(!iso(o.observedAt)||!iso(o.publishedAt))throw new Error('Timezone-aware observation/publication times required');
 if(Date.parse(o.observedAt)<Date.parse(o.publishedAt))throw new Error('Observation precedes publication');
 if(o.value!==null&&!finite(o.value))throw new Error('Metric value must be nonnegative or null');
 if(!['organic','paid','mixed','unknown'].includes(o.paidStatus))throw new Error('Invalid paid status');
 if(!['post_lifetime','post_interval','campaign_interval','account_interval'].includes(o.scope))throw new Error('Invalid scope');
 if(typeof o.display!=='string'&&o.display!==null)throw new Error('Raw display required');
 if(typeof o.approximate!=='boolean')throw new Error('Approximation flag required');
 if(o.approximate&&(!finite(o.precision)||o.precision===0))throw new Error('Rounded values need precision');
 if(o.approximate&&o.value===null)throw new Error('Unavailable is not rounded');
 return o;
}
export function momentum(observations,{now=new Date().toISOString(),maxAgeHours=48,minIntervalHours=1}={}){
 if(!iso(now)||!finite(maxAgeHours)||maxAgeHours===0||!finite(minIntervalHours)||minIntervalHours===0)throw new Error('Invalid momentum time options');
 const unscored=reason=>({score:null,rate:null,label:'Insufficient comparable evidence',reason,kind:'observed_momentum',probability:null});
 const obs=observations.map(assertObservation).filter(o=>o.metric==='views'&&o.scope==='post_lifetime'&&o.value!==null).sort((a,b)=>Date.parse(a.observedAt)-Date.parse(b.observedAt));
 if(obs.length<2)return unscored('Need two view measurements');
 const b=obs.at(-1),a=[...obs.slice(0,-1)].reverse().find(o=>(Date.parse(b.observedAt)-Date.parse(o.observedAt))/36e5>=minIntervalHours);
 if(!a)return unscored('Measurement interval too short');
 if(a.creativeId!==b.creativeId||a.sourceUrl!==b.sourceUrl||a.paidStatus!==b.paidStatus||a.publishedAt!==b.publishedAt)return unscored('Incompatible source, creative, publication or paid status');
 const age=(Date.parse(now)-Date.parse(b.observedAt))/36e5;
 if(age<0||age>maxAgeHours)return unscored('Observation stale or future-dated');
 const delta=b.value-a.value,hours=(Date.parse(b.observedAt)-Date.parse(a.observedAt))/36e5;
 if(delta<0)return unscored('Count correction, not negative performance');
 if((a.approximate||b.approximate)&&delta<=Math.max(a.precision||1,b.precision||1))return unscored('Rounded change too small to establish growth');
 if(delta===0)return {...unscored('Flat exact view count'),label:'Flat view count'};
 return {kind:'observed_momentum',score:null,probability:null,label:'Observed view growth',delta,hours,rate:delta/hours,approximate:a.approximate||b.approximate,from:a.observedAt,to:b.observedAt,paidStatus:b.paidStatus,reason:'Views/hour is descriptive, not viral probability or attributed acquisition'};
}
export function readiness(review){
 requireObject(review);const out={kind:review.stage==='idea'?'idea_priority':'creative_readiness',rubricVersion:RUBRIC_VERSION,score:null,confidence:'unscored',probability:null,reasons:[]};
 if(!['idea','video'].includes(review.stage))throw new Error('Stage must be idea or video');
 if(review.stage==='video'&&(review.inspection?.depth!=='full_audiovisual'||review.inspection?.completed!==true)){out.reasons.push('Full audiovisual review required; descriptions and thumbnails are insufficient');return out;}
 for(const k of CRITERIA){const c=review.criteria?.[k];if(!c||!Number.isInteger(c.value)||c.value<0||c.value>4||typeof c.rationale!=='string'||c.rationale.trim().length<8){out.reasons.push(`Missing supported rating: ${k}`);}}
 if(out.reasons.length)return out;
 out.score=Math.round(CRITERIA.reduce((n,k)=>n+review.criteria[k].value,0)/20*100);
 out.confidence='editorial';out.reasons=['Equal-weight editorial checklist, not empirically calibrated performance prediction'];
 if(review.stage==='idea')out.reasons.push('Idea priority can rank concepts before footage exists; it does not assess unseen execution');
 return out;
}
export function rankIdeas(reviews){return reviews.map(r=>({id:r.id,...readiness(r)})).sort((a,b)=>(b.score??-1)-(a.score??-1));}
export function businessResults(row){
 requireObject(row);const out={kind:'attributed_business_results',costPerFollow:null,costPerInstall:null,costPerActivation:null,reason:null};
 if(['exactCreativeId','windowStart','windowEnd','attributionWindow','currency','sourceId'].some(k=>typeof row[k]!=='string'||!row[k].trim())||row.attributionVerified!==true){out.reason='Exact creative join, reporting window, attribution and currency required';return out;}
 if(!iso(row.windowStart)||!iso(row.windowEnd)||Date.parse(row.windowEnd)<=Date.parse(row.windowStart))throw new Error('Invalid reporting window');
 if(!finite(row.spend)){out.reason='Direct spend missing; no reconstructed costs used';return out;}
 for(const [metric,key] of [['follows','costPerFollow'],['installs','costPerInstall'],['activations','costPerActivation']])if(finite(row[metric])&&row[metric]>0)out[key]=row.spend/row[metric];
 out.currency=row.currency;out.reason='Observed attributed efficiency; no causal or future-performance guarantee';return out;
}
export function calibrate(pairs,{minimum=30}={}){
 // Prospectively frozen scores only; no automatic model/rubric updates.
 if(!Number.isInteger(minimum)||minimum<30)throw new Error('At least30 holdout creatives required');
 const valid=pairs.filter(x=>Number.isFinite(x.score)&&x.score>=0&&x.score<=100&&finite(x.outcome)&&iso(x.scoredAt)&&iso(x.outcomeAt)&&Date.parse(x.scoredAt)<Date.parse(x.outcomeAt)&&x.holdout===true&&['metric','cohort','rubricVersion','creativeId'].every(k=>typeof x[k]==='string'&&x[k].trim())&&finite(x.outcomeHorizonHours)&&x.outcomeHorizonHours>0);
 const groups=new Map();for(const x of valid){const key=JSON.stringify([x.metric,x.cohort,x.rubricVersion,x.outcomeHorizonHours]);if(!groups.has(key))groups.set(key,new Map());const existing=groups.get(key).get(x.creativeId);if(existing&&JSON.stringify(existing)!==JSON.stringify(x))throw new Error('Conflicting duplicate creative in holdout');groups.get(key).set(x.creativeId,x);}
 return [...groups].map(([key,byId])=>{const rows=[...byId.values()];if(rows.length<minimum)return {group:JSON.parse(key),n:rows.length,status:'insufficient_holdout',bins:[]};
 return {group:JSON.parse(key),n:rows.length,status:'descriptive_holdout_check',bins:[0,25,50,75].map(lo=>{const a=rows.filter(x=>x.score>=lo&&(lo===75?x.score<=100:x.score<lo+25));return {scoreMin:lo,scoreMax:lo+25,n:a.length,meanOutcome:a.length?a.reduce((n,x)=>n+x.outcome,0)/a.length:null};}),warning:'Association only. Review sample selection, paid exposure, uncertainty and out-of-time validation before revising rubric. Not a probability calibration.'};});
}
