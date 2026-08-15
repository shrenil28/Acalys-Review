const t=(await(await fetch("http://127.0.0.1:9222/json/list")).json()).find(x=>x.type==="page");
const ws=new WebSocket(t.webSocketDebuggerUrl);let id=0;const pend=new Map();const errs=[];
const send=(m,p={})=>new Promise(r=>{const i=++id;pend.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:p}))});
ws.addEventListener("message",e=>{const m=JSON.parse(e.data);
 if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id)}
 if(m.method==="Runtime.exceptionThrown")errs.push(m.params.exceptionDetails.exception?.description?.split("\n")[0]);});
await new Promise(r=>ws.addEventListener("open",r));
await send("Runtime.enable");await send("Page.enable");
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const ev=async x=>(await send("Runtime.evaluate",{expression:x,returnByValue:true})).result.result.value;
await send("Page.navigate",{url:"http://localhost:5173/organization/settings/general"});await sleep(2600);
console.log("bar before edit:", await ev(`document.body.innerText.includes('You have unsaved changes')`));
await ev(`[...document.querySelectorAll('[role=switch]')][0]?.click()`);await sleep(400);
console.log("bar after edit:", await ev(`(()=>{const has=document.body.innerText.includes('You have unsaved changes');
 const btns=[...document.querySelectorAll('button')].map(b=>b.textContent.trim());
 return {has, reset:btns.includes('Reset')};})()`));
// switch to YAML Editor
await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Concise')?.click()`);await sleep(300);
await ev(`[...document.querySelectorAll('[role=menuitem],button')].find(b=>b.textContent.trim()==='YAML Editor')?.click()`);await sleep(500);
console.log("yaml mode:", await ev(`(()=>({navHidden:!document.querySelector('nav[aria-label="Settings sections"]'),
 hasCard:document.body.innerText.includes('Configuration YAML'), schema:document.body.innerText.includes('yaml-language-server')}))()`));
await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='YAML Editor')?.click()`);await sleep(300);
await ev(`[...document.querySelectorAll('[role=menuitem],button')].find(b=>b.textContent.trim()==='Global Overrides')?.click()`);await sleep(500);
console.log("overrides:", await ev(`(()=>({warn:document.body.innerText.includes('Global Override Settings'),copy:[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Copy YAML'))}))()`));
console.log("errors:", errs.length?errs.slice(0,2):"none");
ws.close();
