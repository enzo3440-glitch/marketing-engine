import {createAdvisor} from '../src/advisor.mjs';
const advisor=createAdvisor();console.log(advisor.status());
console.log(await advisor.propose({task:'recommend',context:{objective:'app activations'}}));
console.log(advisor.readiness({stage:'video',inspection:{depth:'thumbnail',completed:false}}));
