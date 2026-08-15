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
await send("Page.navigate",{url:"http://localhost:5173/analytics/pr-reviews"});await sleep(2800);
// open range popover
await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Last 30 days'))?.click()`);
await sleep(400);
// mangle the From field the way a human would while editing
const setVal=(v)=>`(()=>{const i=[...document.querySelectorAll('input')].find(x=>/^\\d{4}-/.test(x.value));if(!i)return 'no input';const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(i,${JSON.stringify(v)});i.dispatchEvent(new Event('input',{bubbles:true}));return 'set';})()`;
for (const bad of ["2026-08-1", "", "not a date", "2026-13-99 99:99:99"]) {
  await ev(setVal(bad)); await sleep(250);
  // also open the calendar against the bad value
  await ev(`[...document.querySelectorAll('button[aria-label^="Pick"]')][0]?.click()`); await sleep(300);
  const alive = await ev(`!!document.querySelector('input') && !document.body.innerText.includes('This page hit an error')`);
  console.log(JSON.stringify(bad), "-> page alive:", alive, "| errors:", errs.length);
}
console.log("uncaught:", errs.length? errs.slice(0,2) : "none");
ws.close();
