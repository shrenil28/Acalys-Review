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
await send("Page.navigate",{url:"http://localhost:5173/analytics/pr-reviews/knowledge-base"});
await sleep(2500);
// open the time range popover, then the From calendar
await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Last 30 days'))?.click()`);
await sleep(400);
await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.match(/^\\d{4}-\\d{2}-\\d{2}/))?.click()`);
await sleep(500);
console.log("errors:", errs.length? errs.slice(0,2):"none");
console.log("calendar:", await ev(`(()=>{const h=[...document.querySelectorAll('p')].find(p=>p.textContent==='Select a time range');if(!h)return 'MISSING';const root=h.closest('div');const band=root.querySelectorAll('.bg-\\\\[var\\\\(--cr-hover\\\\)\\\\],.bg-\\\\[var\\\\(--cr-active\\\\)\\\\]').length;return 'open, highlighted cells='+band;})()`));
const s=await send("Page.captureScreenshot",{format:"png"});
fs.writeFileSync("cal_proof.png",Buffer.from(s.result.data,"base64"));
ws.close();
