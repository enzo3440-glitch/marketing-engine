export class AdvisorPanel extends HTMLElement {
 constructor(){super();this.attachShadow({mode:'open'});this.adapter=null;this.context={};}
 connectedCallback(){this.render();}
 render(){const d=this.shadowRoot;d.innerHTML=`<style>:host{display:block;font:14px system-ui;color:#172528}section{background:#f4f5ec;border:1px solid #ccd6c8;border-radius:18px;padding:20px;max-width:420px}h3{margin:0 0 8px}button{padding:10px;border-radius:9px;border:1px solid #30594b;cursor:pointer}textarea{width:100%;box-sizing:border-box;min-height:80px;margin:12px 0}p{line-height:1.5}small{color:#53625b}</style><section><h3>Marketing advisor</h3><small id="state"></small><textarea aria-label="Ask the marketing advisor" placeholder="What should we test next?"></textarea><button>Ask / brainstorm</button><div id="output" role="status"></div></section>`;d.querySelector('#state').textContent=this.adapter?'Host adapter configured':'Not connected · manual prompt mode';d.querySelector('button').onclick=()=>this.ask();}
 async ask(){const d=this.shadowRoot,b=d.querySelector('button'),out=d.querySelector('#output');if(b.disabled)return;b.disabled=true;
 try {const prompt=d.querySelector('textarea').value;
  if(!this.adapter){out.textContent='Copy this prompt into your chosen assistant with the included skill: '+prompt;return;}
  out.textContent='Reviewing evidence…';const r=await this.adapter({task:'recommend',context:{...this.context,prompt}});out.textContent='';
  for(const rec of r.recommendations||[]){const p=document.createElement('p');p.textContent=`${rec.title}: ${rec.action} (${rec.signal})`;out.append(p);}
  const note=document.createElement('small');note.textContent='Recommendations only. Review before applying. No spend or publishing.';out.append(note);
 }catch(e){out.textContent='Unable to load recommendations: '+e.message;}finally{b.disabled=false;}}
}
if(!customElements.get('marketing-advisor'))customElements.define('marketing-advisor',AdvisorPanel);
