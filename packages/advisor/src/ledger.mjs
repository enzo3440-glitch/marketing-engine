import {mkdir,readFile,writeFile,rename,open,unlink} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
export class FileLedger {
 constructor(path){this.path=path;}
 async read(){try{return JSON.parse(await readFile(this.path,'utf8'));}catch(e){if(e.code==='ENOENT')return {revision:0,events:[]};throw e;}}
 async append(event,expectedRevision){
  await mkdir(dirname(this.path),{recursive:true});let lock;const lockPath=this.path+'.lock';
  try {lock=await open(lockPath,'wx');}catch(e){if(e.code==='EEXIST')throw new Error('Ledger busy; re-read and retry after active writer finishes');throw e;}
  let temp;
  try {const current=await this.read();if(current.revision!==expectedRevision)throw new Error('Revision conflict');
   if(!event.id||!event.type)throw new Error('Event ID and type required');
   if(current.events.some(x=>x.id===event.id))return current;
   const next={revision:current.revision+1,events:[...current.events,{...event,recordedAt:new Date().toISOString()}]};
   temp=this.path+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(next,null,2),{mode:0o600});await rename(temp,this.path);return next;
  }finally {if(temp)await unlink(temp).catch(()=>{});await lock.close();await unlink(lockPath);}
 }
}
