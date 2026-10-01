// every challenge screen at common screen sizes, opened from the estate the way a player opens it:
// on laptops nothing may need scrolling; on phones the amount and ACCEPT / DECLINE must be in view
const { spawn } = require('child_process'); const fs=require('fs'),os=require('os'),path=require('path');
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'; const PORT=9499;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const SIZES = [[1128, 920], [1280, 720], [1366, 768], [1440, 900], [1024, 640], [390, 844], [375, 667]];
(async()=>{
  require("./pagewatch.js").claimPort(PORT);   // never attach to a browser this check did not start
  const prof=fs.mkdtempSync(path.join(os.tmpdir(),'fit-'));
  require("./pagewatch.js").guard(prof);            // close it even if this check throws, or is killed
  const ch=spawn(CHROME,['--headless=new','--hide-scrollbars','--remote-debugging-port='+PORT,'--user-data-dir='+prof,'--window-size=1440,1000','about:blank'],{stdio:'ignore'});
  let send, sock; for(let i=0;i<160&&!send;i++){await sleep(250);try{const t=(await(await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find(x=>x.type==='page');
    const ws=new WebSocket(t.webSocketDebuggerUrl);await new Promise((ok,no)=>{ws.onopen=ok;ws.onerror=no;});let id=0;const m=new Map();ws.onmessage=e=>{const o=JSON.parse(e.data);if(o.id&&m.has(o.id)){m.get(o.id)(o);m.delete(o.id);}};
    send=(me,pa={})=>new Promise((ok,no)=>{const n=++id;m.set(n,o=>o.error?no(new Error(o.error.message)):ok(o.result));ws.send(JSON.stringify({id:n,method:me,params:pa}));});sock=ws;}catch(_){send=null;}}
  const ev=async e=>{const r=await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true}); return r.exceptionDetails?'THREW: '+r.exceptionDetails.text:r.result.value;};
  // run inside the popup's frame
  const fr = (js) => ev(`(()=>{const w=document.querySelector('#challenge iframe'); if(!w||!w.contentWindow) return 'no frame'; return w.contentWindow.eval(${JSON.stringify(js)});})()`);
  // IN VIEW MEANS VISIBLE, NOT MERELY INSIDE THE VIEWPORT.
  //
  // This used to be `r.top >= 0 && r.bottom <= vh + 1` and nothing else. A rectangle inside the
  // viewport is all that can see, and a rectangle inside the viewport can be completely covered: a
  // pinned row sat over a duel's verdict line, "YOU WIN" was not on the screen at all, and this check
  // went green. So the rectangle test stays - it is what catches a thing scrolled off the bottom - and
  // `document.elementFromPoint` at the element's own centre is asked who is actually painted there. The
  // answer has to be the element or something inside it; anything else is on top of it.
  //
  // Two shapes that are NOT a failure, and are allowed on purpose rather than by accident:
  //   - the point lands on a child, which is the normal case for a button with a label - `contains`;
  //   - the element does not take pointer events, so the hit test looks straight through it to
  //     whatever is behind. That is a styling choice, not a covered element, so such an element is
  //     measured with its own `pointer-events` forced back on for the length of the read.
  const measure = (keys) => fr(`(()=>{ const vh = innerHeight, d = document.documentElement;
    const painted = (e, r) => {
      const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
      const st = e.style.pointerEvents, forced = getComputedStyle(e).pointerEvents === 'none';
      if (forced) e.style.pointerEvents = 'auto';
      const hit = document.elementFromPoint(x, y);
      if (forced) e.style.pointerEvents = st;
      return !!hit && (hit === e || e.contains(hit));
    };
    const inView = (sel) => { const e = document.querySelector(sel); if (!e || !e.offsetParent && getComputedStyle(e).position !== 'fixed') return 'missing'; const r = e.getBoundingClientRect();
      if (!(r.top >= 0 && r.bottom <= vh + 1 && r.height > 0)) return 'off screen';
      if (!painted(e, r)) { const h = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)); return 'covered by ' + (h ? h.tagName.toLowerCase() + (h.id ? '#' + h.id : '') + (h.className && typeof h.className === 'string' ? '.' + h.className.trim().split(/\\s+/).join('.') : '') : 'nothing'); }
      return true; };
    return JSON.stringify({ scroll: d.scrollHeight - vh, keys: ${JSON.stringify(keys)}.map(k => [k, inView(k)]) }); })()`)
    // no popup frame is a screen that does not fit, not a crash: it used to throw here on JSON.parse('no
    // frame') and take every size after it - and the bridge's steps below - down with it.
    .then(r => { try { return JSON.parse(r); } catch (_) { return { scroll: 0, keys: keys.map(k => [k, String(r).slice(0, 60)]) }; } });
  const watch = await require('./pagewatch.js').attach(sock, send);
  let bad = 0; const out = [];
  for (const [W, H] of SIZES) {
    const phone = W < 600;
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: phone });
    await send('Page.navigate', { url: 'http://localhost:8765/base.html' }); await sleep(2200);
    await ev('document.getElementById("challengeBtn").click()'); await sleep(1500);
    const shot = async (name) => { const s = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(process.env.SHOTS || os.tmpdir(), `fit-${W}x${H}-${name}.png`), Buffer.from(s.data, 'base64')); };
    const screens = [
      ['prompt', async () => { await fr('document.querySelector("[data-view=defender]").click()'); await sleep(400); }, ['#bign', '#paccept', '#pdecline', '#prompt .nft']],
      ['declined', async () => { await fr('document.getElementById("pdecline").click()'); await sleep(300); }, ['#nope .big', '#nagain', '#nback']],
      ['terms', async () => { await fr('document.querySelector("[data-view=challenger]").click()'); await sleep(300); }, ['#potn', '#send']],
      ['play', async () => { await fr('document.getElementById("send").click()'); await sleep(2800); }, ['#potn', '.pick[data-pick=scissors]', '#hm', '#ht']],
      ['result', async () => { await fr('document.querySelector("[data-pick=paper]").click()'); await sleep(6500); }, ['.result', '#again', '#close']],
    ];
    for (const [name, go, keys] of screens) {
      await go();
      const m = await measure(keys);
      const hidden = m.keys.filter(k => k[1] !== true).map(k => k[0] + ' (' + k[1] + ')');
      const pass = phone ? hidden.length === 0 : (m.scroll <= 1 && hidden.length === 0);
      if (!pass) bad++;
      out.push(`${pass ? '  ok  ' : 'FAIL  '}${String(W + 'x' + H).padEnd(9)} ${name.padEnd(9)} ${phone ? '(phone) ' : ''}scroll ${m.scroll > 1 ? m.scroll + 'px' : 'none'}${hidden.length ? ' · not visible: ' + hidden.join(', ') : ''}`);
      if (!pass || name === 'prompt') await shot(name);
    }
  }
  const whyBeforeBridge = watch.why();   // so a page error is attributed: base screens, or the bridge steps
  // THE BRIDGE, at step 3 and step 6, at every size above. State is set the way bridgecheck sets it (a
  // Doopie of our own making, so no network is asked for it), then the page is measured, not the popup.
  //   step 3 (go(2)): the page must not scroll either way; where the step is taller than its slide, the
  //   SLIDE is what scrolls (overflow auto/scroll and a scrollTop that moves) - content past the bottom
  //   of an overflow:hidden slide is unreachable and fails. Whether the step overflows on its own varies
  //   run to run (84px and 284px at two laptop sizes in one run, 0 everywhere in the next), so a 600px
  //   block is then put INTO the slide at every size: the page must still not scroll, and the slide must
  //   (the slide's flex children shrink first, so it overflows by less than 600 - 40 to 303px measured).
  //   step 6 (signature set, go(5)): the page must not scroll either way, and every visible button on
  //   slide 5 must be the thing elementFromPoint finds at its own centre - in view AND not covered.
  // BREAK=bridgetall appends 3000px to the page; BREAK=bridgecover lays a fixed sheet over the bottom
  // of the screen; BREAK=bridgeslide sets the slides to overflow:hidden. None touches a file.
  const BREAK = process.env.BREAK || '';
  const until = async (e, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(e) === true) return true; await sleep(120); } return false; };
  const pageFit = () => ev(`JSON.stringify({ down: document.documentElement.scrollHeight - innerHeight, side: document.documentElement.scrollWidth - innerWidth })`).then(JSON.parse);
  for (const [W, H] of SIZES) {
    const phone = W < 600, tag = String(W + 'x' + H).padEnd(9);
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: phone });
    await send('Page.navigate', { url: 'http://localhost:8765/bridge.html' });
    await sleep(300); await until('typeof window.bridge === "object" && bridge.step === 0', 20000);
    if (BREAK === 'bridgetall') await ev('(() => { const d = document.createElement("div"); d.style.height = "3000px"; document.body.appendChild(d); })()');
    if (BREAK === 'bridgecover') await ev('(() => { const d = document.createElement("div"); d.style.cssText = "position:fixed;left:0;right:0;bottom:0;height:45%;z-index:99999;background:rgba(0,0,0,.01)"; document.body.appendChild(d); })()');
    if (BREAK === 'bridgeslide') await ev('(() => { const s = document.createElement("style"); s.textContent = ".slide{overflow:hidden !important}"; document.head.appendChild(s); })()');
    // A REAL Doopie (#24350, the DESIGN one-of-one), read once from arweave through the gateway the attestor
    // uses and resized 1000->400px so its data: url fits under the server's 64 KB request line. It used to be a
    // drawn blue square, which the converter rejects, so step 3 waited 15 s per size for a model that never
    // came and measured a layout with NO model on it. The step now asserts the model arrived.
    const png = 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, 'fixtures', 'doopie-24350.png')).toString('base64');
    await ev(`(() => { bridge.S.sol = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'; bridge.S.nfts = [{ name: 'Doopies #24350', mintAddress: 'BmAwHYEhSRetbEfSQoZQsrvnUgKBxu3vGNyZjzrru3Fb', collection: 'doopies',
      image: ${JSON.stringify(png)}, attributes: [{ trait_type: 'Background', value: 'Neotide' }, { trait_type: 'Evolution', value: 'Evolution 1' }] }]; bridge.go(1); })()`);
    await until('bridge.step === 1 && document.querySelectorAll("[data-n]").length === 1');
    await ev('document.querySelector("[data-n]").click()'); await until('bridge.S.chosen.length === 1');
    // step 3 is reached through CONVERT, the way a player reaches it, rather than a bare go(2).
    await ev('document.querySelector(".slide[data-slide=\\"1\\"] .btn.go").click()'); await until('bridge.step === 2'); const model = await until('!!document.querySelector("[data-cv] canvas")', 60000); await sleep(300);
    // step 3
    {
      const p = await pageFit();
      const s = await ev(`(() => { const e = document.querySelector('.slide[data-slide="2"]'); if (!e) return JSON.stringify({ missing: true });
        const over = e.scrollHeight - e.clientHeight; e.scrollTop = 60; const moved = e.scrollTop; e.scrollTop = 0;
        return JSON.stringify({ over, moved, oy: getComputedStyle(e).overflowY }); })()`).then(JSON.parse);
      const why = [];
      if (p.down > 1) why.push('the page scrolls ' + p.down + 'px down');
      if (p.side > 1) why.push('the page scrolls ' + p.side + 'px sideways');
      if (s.missing) why.push('no slide 2');
      if (!model) why.push('no model on screen: ' + await ev('((document.querySelector("[data-cv]") || {}).textContent || "no [data-cv]").trim().slice(0, 40)'));
      else if (s.over > 1 && !(s.moved > 0 && /auto|scroll/.test(s.oy))) why.push('the step is ' + s.over + 'px taller than its slide and the slide does not scroll (overflow ' + s.oy + ')');
      const f = await ev(`(() => { const e = document.querySelector('.slide[data-slide="2"]'); if (!e) return JSON.stringify({});
        const d = document.createElement('div'); d.style.cssText = 'height:600px;flex:0 0 600px'; e.appendChild(d);
        const down = document.documentElement.scrollHeight - innerHeight, over = e.scrollHeight - e.clientHeight;
        e.scrollTop = 1e6; const moved = e.scrollTop; e.scrollTop = 0; d.remove();
        return JSON.stringify({ down, over, moved, oy: getComputedStyle(e).overflowY }); })()`).then(JSON.parse);
      if (!(f.down <= 1 && f.over > 1 && f.moved >= f.over - 1 && /auto|scroll/.test(f.oy)))
        why.push('600px more in the slide: page scrolls ' + f.down + 'px, slide over ' + f.over + 'px, scrolled ' + f.moved + 'px, overflow ' + f.oy);
      if (why.length) bad++;
      out.push(`${why.length ? 'FAIL  ' : '  ok  '}${tag} bridge 3 ${phone ? '(phone) ' : ''}page scroll none · slide ${s.over > 1 ? 'scrolls ' + s.over + 'px' : 'fits'}, and scrolls when 600px taller${why.length ? ' · ' + why.join(', ') : ''}`);
    }
    // step 6
    await ev('(() => { bridge.S.signature = "0xdeadbeef"; bridge.go(5); })()'); await until('bridge.step === 5');
    await ev('bridge.frame && bridge.frame()'); await sleep(500);
    {
      const p = await pageFit();
      const b = await ev(`(() => { const all = [...document.querySelectorAll('.slide[data-slide="5"] button')];
        const res = all.map(e => { const r = e.getBoundingClientRect(), n = (e.textContent || '').trim().slice(0, 18);
          if (!r.width || !r.height) return [n, 'not displayed'];
          if (r.top < 0 || r.bottom > innerHeight + 1 || r.left < 0 || r.right > innerWidth + 1) return [n, 'off screen'];
          const h = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
          return [n, !!h && (h === e || e.contains(h)) ? true : 'covered by ' + (h ? h.tagName.toLowerCase() + (h.className && typeof h.className === 'string' ? '.' + h.className.trim().split(/\\s+/).join('.') : '') : 'nothing')]; });
        return JSON.stringify(res); })()`).then(JSON.parse);
      const why = [];
      if (p.down > 1) why.push('the page scrolls ' + p.down + 'px down');
      if (p.side > 1) why.push('the page scrolls ' + p.side + 'px sideways');
      if (!b.length) why.push('slide 5 has no buttons');
      for (const [n, v] of b) if (v !== true) why.push('"' + n + '" ' + v);
      if (why.length) { bad++; const s = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(process.env.SHOTS || os.tmpdir(), `fit-${W}x${H}-bridge6.png`), Buffer.from(s.data, 'base64')); }
      out.push(`${why.length ? 'FAIL  ' : '  ok  '}${tag} bridge 6 ${phone ? '(phone) ' : ''}${b.filter(x => x[1] === true).length} of ${b.length} buttons hit${why.length ? ' · ' + why.join(', ') : ''}`);
    }
  }
  console.log(out.join('\n'));
  // counted apart from `bad`, which counts screens: a 404 is not a screen that does not fit.
  const clean = watch.clean();
  console.log((clean ? '  ok  ' : 'FAIL  ') + 'nothing 404d and nothing was logged as an error, at any size' + (clean ? '' : '   -> ' + watch.why() + '   [already before the bridge steps: ' + whyBeforeBridge + ']'));
  console.log(bad ? `\n${bad} screen(s) don't fit` : '\nevery screen fits');
  await require('./pagewatch.js').shutdown(ch, prof); process.exit(bad || !clean ? 1 : 0);
})();
