const { spawn } = require('child_process'); const fs=require('fs'),os=require('os'),path=require('path');
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'; const PORT=9493;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  require("./pagewatch.js").claimPort(PORT);   // never attach to a browser this check did not start
  const prof=fs.mkdtempSync(path.join(os.tmpdir(),'cb-'));
  require("./pagewatch.js").guard(prof);            // close it even if this check throws, or is killed
  const ch=spawn(CHROME,['--headless=new','--enable-unsafe-swiftshader','--hide-scrollbars','--remote-debugging-port='+PORT,
    '--user-data-dir='+prof,'--window-size=1100,800','http://localhost:8765/base.html'],{stdio:'ignore'});
  let send, sock;
  for(let i=0;i<160&&!send;i++){await sleep(250);try{
    const t=(await(await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find(x=>x.type==='page');
    const ws=new WebSocket(t.webSocketDebuggerUrl);await new Promise((ok,no)=>{ws.onopen=ok;ws.onerror=no;});
    let id=0;const m=new Map();ws.onmessage=e=>{const o=JSON.parse(e.data);if(o.id&&m.has(o.id)){m.get(o.id)(o);m.delete(o.id);}};
    send=(me,pa={})=>new Promise((ok,no)=>{const n=++id;m.set(n,o=>o.error?no(new Error(o.error.message)):ok(o.result));ws.send(JSON.stringify({id:n,method:me,params:pa}));});
    sock=ws;
  }catch(_){send=null;}}
  const ev=async e=>{const r=await send('Runtime.evaluate',{expression:e,returnByValue:true});
    return r.exceptionDetails?'THREW: '+r.exceptionDetails.exception.description.split('\n')[0]:r.result.value;};
  const tapWorld=async(x,y,lift=0)=>{
    const pt=await ev(`(()=>{const p=base.project(${x},${y}); const k=base.fit;
      const cv=document.getElementById('c'), r=cv.getBoundingClientRect();
      return [(p[0]*k+base.CAM.x*(1-k)+base.viewX)/cv.width*r.width+r.left, ((p[1]-${lift})*k+base.CAM.y*(1-k))/cv.height*r.height+r.top];})()`);
    for(const type of ['mousePressed','mouseReleased']) await send('Input.dispatchMouseEvent',{type,x:pt[0],y:pt[1],button:'left',clickCount:1});
    await sleep(250);
  };
  const shot = async (f) => { const s = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(process.env.SHOTS || os.tmpdir(), f), Buffer.from(s.data, 'base64')); };
  const watch = await require('./pagewatch.js').attach(sock, send);
  let bad=0; const ok=(n,c,v)=>{console.log((c?'  ok  ':'FAIL  ')+n+(c?'':'   -> '+v)); if(!c) bad++;};
  await sleep(2000);
  const inner = (js) => ev(`(()=>{const w=document.querySelector('#challenge iframe'); return w && w.contentWindow ? (function(){ return eval(${JSON.stringify(js)}); }).call(w.contentWindow) : 'no frame';})()`);
  const fr = (js) => ev(`(()=>{const w=document.querySelector('#challenge iframe'); if(!w||!w.contentWindow) return 'no frame'; return w.contentWindow.eval(${JSON.stringify(js)});})()`);
  ok('a CHALLENGE button is on the estate', await ev('!!document.getElementById("challengeBtn") && getComputedStyle(document.getElementById("challengeBtn")).display !== "none"'), 'missing');
  await ev('document.getElementById("challengeBtn").click()'); await sleep(2000);
  ok('it opens the challenge screen over the estate', await ev('!document.getElementById("challenge").hidden') && /SET THE TERMS/.test(await fr('document.getElementById("phase").textContent')), await fr('document.getElementById("phase").textContent'));
  ok('the estate is the live one behind it, not a second copy', await fr('document.querySelectorAll("#scrim iframe").length') === 0, 'nested estate');
  await shot('cb-open.png');
  await fr('document.getElementById("send").click()'); await sleep(2700);
  await fr('document.querySelector("[data-pick=paper]").click()'); await sleep(6500);
  ok('a round plays inside the popup', /RESULT/.test(await fr('document.getElementById("phase").textContent')), await fr('document.getElementById("phase").textContent'));
  await shot('cb-result.png');
  await fr('document.getElementById("close").click()'); await sleep(400);
  ok('BACK TO THE BASE closes it', await ev('document.getElementById("challenge").hidden'), 'still open');
  await ev('document.getElementById("challengeBtn").click()'); await sleep(1500);
  await fr('document.getElementById("xclose").click()'); await sleep(400);
  ok('CLOSE closes it too', await ev('document.getElementById("challenge").hidden'), 'still open');
  ok('the estate carries on underneath', await ev('base.buildings.length') >= 10 && !(await ev('base.armouryOn')), 'broken');
  ok('nothing 404d and nothing was logged as an error, opening and closing the popup', watch.clean(), watch.why());
  console.log(bad?`\n${bad} step(s) failed`:'\nthe challenge button works');
  await require('./pagewatch.js').shutdown(ch, prof); process.exit(bad?1:0);
})();
