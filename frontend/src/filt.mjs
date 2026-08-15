import fs from "node:fs";
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
await send("Page.navigate",{url:"http://localhost:5173/analytics/pr-reviews"});
await sleep(2500);
await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim().startsWith('Repository Name'))?.click()`);
await sleep(400);
console.log("panel:", await ev(`(()=>{const inp=document.querySelector('input[placeholder="Repository Name"]');if(!inp)return 'NO SEARCH INPUT';const rows=[...document.querySelectorAll('button')].map(b=>b.textContent.trim());return {search:true, selected:rows.some(r=>r.startsWith('Selected (')), all:rows.includes('All'), options:rows.filter(r=>r.includes('acalys')).length};})()`));
// type into the search to confirm it filters
await ev(`(()=>{const i=document.querySelector('input[placeholder="Repository Name"]');const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(i,'n8n');i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
await sleep(400);
console.log("after search 'n8n':", await ev(`[...document.querySelectorAll('button')].map(b=>b.textContent.trim()).filter(r=>r&&!['All','Display','Filter'].includes(r)&&!r.startsWith('Selected (')).slice(-4)`));
console.log("errors:", errs.length?errs.slice(0,2):"none");
const s=await send("Page.captureScreenshot",{format:"png"});
fs.writeFileSync("filter_proof.png",Buffer.from(s.result.data,"base64"));
ws.close();
