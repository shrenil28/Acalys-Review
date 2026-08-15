const t=(await(await fetch("http://127.0.0.1:9222/json/list")).json()).find(x=>x.type==="page");
const ws=new WebSocket(t.webSocketDebuggerUrl);let id=0;const pend=new Map();
const send=(m,p={})=>new Promise(r=>{const i=++id;pend.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:p}))});
ws.addEventListener("message",e=>{const m=JSON.parse(e.data);if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id)}});
await new Promise(r=>ws.addEventListener("open",r));
await send("Runtime.enable");await send("Page.enable");
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const ev=async x=>(await send("Runtime.evaluate",{expression:x,returnByValue:true})).result.result.value;
for (const [url,sel,name] of [
 ["http://localhost:5173/organization/settings/general",'aside nav[aria-label="Settings sections"]',"Settings nav"],
 ["http://localhost:5173/analytics/pr-reviews",'aside nav[aria-label="Dashboard views"]',"Dashboard rail"],
]) {
  await send("Page.navigate",{url});await sleep(2600);
  const before = await ev(`document.querySelector('${sel}').getBoundingClientRect().top`);
  await ev(`document.querySelector('main').scrollTo(0,600)`);await sleep(400);
  const after = await ev(`document.querySelector('${sel}').getBoundingClientRect().top`);
  console.log(name, "| top before:", Math.round(before), "after scroll 600:", Math.round(after), "| stuck:", Math.abs(after-before)<4);
}
console.log("brand text:", await ev(`document.body.innerText.includes('CodeRabbit') ? 'CodeRabbit still present' : 'Acalys only'`));
ws.close();
