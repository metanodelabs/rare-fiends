// a real phone-width screenshot: headless floors the window at 500px, so emulate instead
const { spawn } = require('child_process'); const fs=require('fs'),os=require('os'),path=require('path');
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'; const PORT=9366;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const [url,out,w,h]=[process.argv[2],process.argv[3],+(process.argv[4]||390),+(process.argv[5]||844)];
  const prof=fs.mkdtempSync(path.join(os.tmpdir(),'mo-'));
  const ch=spawn(CHROME,['--headless=new','--disable-gpu','--hide-scrollbars','--remote-debugging-port='+PORT,
    '--user-data-dir='+prof,'--window-size=900,900',url],{stdio:'ignore'});
  let send;
  for(let i=0;i<40&&!send;i++){await sleep(250);try{
    const t=(await(await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find(x=>x.type==='page');
    const ws=new WebSocket(t.webSocketDebuggerUrl);await new Promise((ok,no)=>{ws.onopen=ok;ws.onerror=no;});
    let id=0;const m2=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&m2.has(m.id)){m2.get(m.id)(m);m2.delete(m.id);}};
    send=(me,pa={})=>new Promise((ok,no)=>{const n=++id;m2.set(n,m=>m.error?no(new Error(m.error.message)):ok(m.result));ws.send(JSON.stringify({id:n,method:me,params:pa}));});
  }catch(_){send=null;}}
  await send('Emulation.setDeviceMetricsOverride',{width:w,height:h,deviceScaleFactor:2,mobile:true});
  await sleep(1800);
  const r=await send('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(out,Buffer.from(r.data,'base64'));
  const m=await send('Runtime.evaluate',{expression:'JSON.stringify({vw:innerWidth,sw:document.documentElement.scrollWidth})',returnByValue:true});
  console.log(out,m.result.value); ch.kill(); process.exit(0);
})();
