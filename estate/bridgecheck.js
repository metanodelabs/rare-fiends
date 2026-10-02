// The bridge: the Doopie is converted by the converter itself (doopies_converter/tools, run by the local
// server), the page builds the voxel model from that sprite with the converter's own mesh builder, and what
// the chain will keep of it is packed here. Checked below: the packing survives a round trip, and the page
// shows the model, what crosses over, the message that proves the wallet is yours and the fee.
// (That the contract holds it all is estate/contracts/paritycheck.js.)
const { spawn } = require('child_process'); const fs=require('fs'),os=require('os'),path=require('path');
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'; const PORT=require('./pagewatch.js').debugPort(9547);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
// a browser left over from an earlier run still holds this port, and a new run would attach to it and
// read the page as it was then — so clear it first
try { require('child_process').execSync('pkill -f "remote-debugging-port=' + PORT + '" 2>/dev/null || true'); } catch (e) {}
(async()=>{
  let bad=0; const ok=(n,c,v)=>{console.log((c?'  ok  ':'FAIL  ')+n+(c?'':'   -> '+v)); if(!c) bad++;};

  // what the chain keeps: a real converted Doopie, packed and unpacked again
  const fix = JSON.parse(fs.readFileSync(path.join(__dirname, 'contracts/test/doopie-sprite.json'), 'utf8'));
  const { pack, unpack } = await import('./doopie-pack.mjs');
  const rgba = new Uint8ClampedArray(64 * 64 * 4);
  fix.rgb.forEach((c, i) => { if (!c) return; rgba[i*4] = c[0]; rgba[i*4+1] = c[1]; rgba[i*4+2] = c[2]; rgba[i*4+3] = 255; });
  const p1 = pack(rgba, 64), p2 = pack(rgba, 64);
  ok('the sprite packs the same way every time (' + p1.words + ' words for ' + p1.count + ' pixels)',
    JSON.stringify(p1) === JSON.stringify(p2) && p1.count === fix.count, JSON.stringify([p1.words, p1.count, fix.count]));
  ok('it is a mask of 16 words, a palette and five bits a pixel',
    p1.mask.length === 16 && p1.mask.every(w => /^0x[0-9a-f]{64}$/.test(w)) &&
    p1.pixels.length === Math.ceil(p1.count * 5 / 256), JSON.stringify([p1.mask.length, p1.palette.length, p1.pixels.length]));
  const back = unpack(p1);
  let wrong = 0, worst = 0;
  for (let i = 0; i < 64 * 64; i++) {
    const a = rgba[i*4+3] > 127, b = back[i*4+3] > 127;
    if (a !== b) { wrong++; continue; }
    if (!a) continue;
    worst = Math.max(worst, Math.abs(rgba[i*4]-back[i*4]) + Math.abs(rgba[i*4+1]-back[i*4+1]) + Math.abs(rgba[i*4+2]-back[i*4+2]));
  }
  const again = unpack(pack(back, 64));
  let moved = 0;
  for (let i = 0; i < 64 * 64 * 4; i++) if (back[i] !== again[i]) moved++;
  ok('unpacking gives the same picture back: every pixel in place, colours within ' + worst + ' of 765, and stable after that',
    wrong === 0 && worst < 96 && moved === 0, JSON.stringify([wrong, worst, moved]));

  // ---------------------------------------------------------------- what decides a Doopie is a 1/1
  // M21 item 5 is a contract read whose trust root is the signed attestation, and the parts of it are in
  // three files: the bytes (doopie-trait.mjs), the signature over them (attestor.mjs) and the reader that
  // gets at them on chain (ShadowFriends.traitOf). These assert the joins, with an EPHEMERAL key and no
  // network - nothing here uses the deployer's key, signs anything real or reaches a chain.
  const T = await import('./doopie-trait.mjs');
  const A = await import('./attestor.mjs');
  // The bytes, and they are not a preference: `Evolution` with a capital E and `1/1` as three ASCII
  // characters, looked up off Solana - 75 of 75 one-of-ones across 4,194 tokens, no competing field.
  ok('the one-of-one is marked by Evolution = 1/1, right-padded, and the bytes are these ones',
    T.KEY_B32 === '0x45766f6c7574696f6e' + '00'.repeat(23) && T.ONE_OF_ONE_B32 === '0x312f31' + '00'.repeat(29) &&
    T.unb32(T.KEY_B32) === 'Evolution' && T.unb32(T.ONE_OF_ONE_B32) === '1/1',
    JSON.stringify([T.KEY_B32, T.ONE_OF_ONE_B32]));
  // The attestor's EIP-712 type is the CONTRACT'S, read out of the .sol rather than copied into here: the
  // domain and the type are frozen into every signature ever made, so a drift between the two files is a
  // claim that verifies nowhere.
  const sol = fs.readFileSync(path.join(__dirname, 'contracts/ShadowFriends.sol'), 'utf8');
  ok('the claim the attestor signs is the type ShadowFriends declares, read from the source',
    sol.includes('"' + A.claimTypeString() + '"') && sol.includes('EIP712("' + A.DOMAIN_NAME + '"'),
    A.claimTypeString());
  // "could not read it" is never "not a one-of-one" - M21 item 9, and the failure it prevents is invisible
  const tri = [
    ['nothing was read', T.oneOfOne(null)], ['the JSON had no attributes', T.oneOfOne({})],
    ['no Evolution trait at all', T.oneOfOne([{ trait_type: 'Species', value: 'Dallop' }])],
    ['Evolution spelled another way', T.oneOfOne([{ trait_type: 'evolution', value: '1/1' }])],
  ];
  ok('a Doopie whose metadata could not be read is never reported as "not a one-of-one"',
    tri.every(([, r]) => r.ok === false && r.oneOfOne === null) &&
    T.oneOfOne([{ trait_type: 'Evolution', value: '1/1' }]).oneOfOne === true &&
    T.oneOfOne([{ trait_type: 'Evolution', value: 'Evolution 3' }]).oneOfOne === false,
    JSON.stringify(tri.map(([n, r]) => [n, r.ok, r.oneOfOne])));
  // and the badge the shelf draws reads the same bytes, so a card and a signature cannot disagree
  ok('the badge reads 1/1 on a one-of-one even though Species is listed first, and the stage otherwise',
    T.badge([{ trait_type: 'Species', value: 'Dallop' }, { trait_type: 'Background', value: 'Dusk' }, { trait_type: 'Evolution', value: '1/1' }]).text === '1/1' &&
    T.badge([{ trait_type: 'Background', value: 'Dusk' }, { trait_type: 'Species', value: 'McMuffin' }, { trait_type: 'Evolution', value: 'Evolution 1' }]).text === 'Evolution 1',
    JSON.stringify(T.badge([{ trait_type: 'Species', value: 'Dallop' }, { trait_type: 'Evolution', value: '1/1' }])));

  // the attestor: an EPHEMERAL key, a made-up Solana wallet, and nothing that leaves this process
  let ethers = null;
  try { ethers = require('module').createRequire(path.join(__dirname, 'contracts/package.json'))('ethers').ethers; } catch (e) {}
  if (!ethers) {
    ok('the attestor signs a claim the contract will accept', false, 'the contracts are not installed: cd estate/contracts && npm i');
    ok('and refuses, signing nothing, in every case it cannot be certain', false, 'same');
  } else {
    const crypto = require('crypto');
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');       // a Solana wallet, made here
    const SOL = A.b58encode(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
    const EVM = '0x1111111111111111111111111111111111111111', MINT = process.env.BREAK === 'mintkey' ? 'OneOfOne11111111111111111111111111111111' : 'BmAwHYEhSRetbEfSQoZQsrvnUgKBxu3vGNyZjzrru3Fb';   // a real 32-byte key: the attestor refuses anything else (ruling 22)
    const AT = '0x2222222222222222222222222222222222222222';                        // a stand-in: nothing is deployed
    const art = [{ mint: MINT, mask: fix.mask, palette: fix.palette, pixels: fix.pixels, colors: fix.colors, count: fix.count }];
    const message = ['Rare Fiends Bridge', 'solana: ' + SOL, 'robinhood: ' + EVM, 'chain: 4663', 'doopie: x · ' + MINT].join('\n');
    const signature = '0x' + crypto.sign(null, Buffer.from(message, 'utf8'), privateKey).toString('hex');
    const attestor = ethers.Wallet.createRandom();                                 // EPHEMERAL, never the deployer's
    const ONE = [{ trait_type: 'Species', value: 'Dallop' }, { trait_type: 'Background', value: 'Dusk' }, { trait_type: 'Evolution', value: '1/1' }];
    const io = (over) => Object.assign({ ethers, signer: attestor, contract: AT, chainId: 4663,
      readAsset: async () => ({ owner: SOL, name: 'Doopies #1', uri: 'ar://x' }),
      readMetadata: async () => ({ name: 'Doopies #1', attributes: ONE }) }, over || {});
    const req = (over) => Object.assign({ solana: SOL, evm: EVM, message, signature, art }, over || {});
    const signed = await A.attest(req(), io());
    const recovers = signed.ok && ethers.verifyTypedData(
      { name: A.DOMAIN_NAME, version: A.DOMAIN_VERSION, chainId: 4663, verifyingContract: AT },
      A.CLAIM_TYPES, signed.claims[0].claim, signed.claims[0].signature) === attestor.address;
    ok('the attestor signs a one-of-one claim and it recovers to the attestor, nobody else',
      signed.ok === true && signed.claims[0].oneOfOne === true && recovers &&
      signed.claims[0].claim.traitValues.includes(T.ONE_OF_ONE_B32) &&
      String(signed.claims[0].claim.solMint).toLowerCase() === A.keyToBytes32(MINT).toLowerCase() && A.bytes32ToKey(signed.claims[0].claim.solMint) === MINT,
      signed.ok ? 'does not recover' : signed.error);
    // Every way it must REFUSE, and a refusal means no signature and no calldata - not a claim with a
    // trait missing, which is the shape of the silent downgrade this exists to prevent.
    const refusals = [
      ['the gateway rate-limited the metadata', io({ readMetadata: async () => { throw new Error('429'); } }), req()],
      ['the metadata came back as markup', io({ readMetadata: async () => { throw new Error('not JSON'); } }), req()],
      ['the metadata has no Evolution trait', io({ readMetadata: async () => ({ attributes: [{ trait_type: 'Species', value: 'Dallop' }] }) }), req()],
      ['the metadata spells Evolution another way', io({ readMetadata: async () => ({ attributes: [{ trait_type: 'evolution', value: '1/1' }] }) }), req()],
      ['a trait key appears twice', io({ readMetadata: async () => ({ attributes: [{ trait_type: 'Evolution', value: '1/1' }, { trait_type: 'Evolution', value: 'Evolution 2' }] }) }), req()],
      ['Solana says another wallet holds it', io({ readAsset: async () => ({ owner: 'So11111111111111111111111111111111111111112', uri: 'ar://x' }) }), req()],
      ['Solana could not be read at all', io({ readAsset: async () => { throw new Error('rpc down'); } }), req()],
      ['there is no way to read Solana', io({ readAsset: undefined }), req()],
      ['there is no key', io({ signer: null }), req()],
      ['ShadowFriends is not deployed', io({ contract: null }), req()],
      ['the Solana signature is somebody else\'s', io(), req({ signature: '0x' + '11'.repeat(64) })],
      ['the signed message names another chain', io(), req({ message: message.replace('chain: 4663', 'chain: 1') })],
      ['the signed message does not name the Doopie', io(), req({ message: message.split('\n').slice(0, 4).join('\n') })],
      ['the art is over the format\'s own limit', io(), req({ art: [Object.assign({}, art[0], { colors: 33 })] })],
    ];
    const outs = [];
    for (const [name, i, r] of refusals) outs.push([name, await A.attest(r, i)]);
    const leaked = outs.filter(([, o]) => o.ok || o.claims || o.signature);
    ok('and refuses, signing nothing, in all ' + refusals.length + ' cases it cannot be certain',
      leaked.length === 0 && outs.every(([, o]) => typeof o.code === 'string' && typeof o.error === 'string'),
      JSON.stringify(leaked.map(([n]) => n).concat(outs.filter(([, o]) => !o.code).map(([n]) => n + ': no code'))));
  }

  // api/claim exists, on a server of this check's own so the one on 8765 is never restarted under anybody
  const port = await new Promise((res) => { const s = require('net').createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  const srv = spawn('python3', [path.join(__dirname, 'serve.py'), String(port)], { stdio: 'ignore' });
  try {
    let got = null;
    for (let i = 0; i < 40 && !got; i++) {
      await sleep(250);
      try {
        const r = await fetch('http://127.0.0.1:' + port + '/api/claim', { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ solana: 'x', evm: 'y', art: [] }) });
        got = { status: r.status, body: await r.json() };
      } catch (_) {}
    }
    // A REFUSAL COMES BACK 200 on purpose: the page's contract is `out.ok`, and "the attestor has no key"
    // is this endpoint answering correctly, not failing. A 5xx for the expected condition would turn every
    // walk of this page red for the weather.
    ok('api/claim exists, answers the bridge page\'s POST, and refuses without a key rather than 404ing',
      !!got && got.status === 200 && got.body.ok === false && got.body.code === 'no-key',
      JSON.stringify(got));
  } finally { srv.kill(); }

  // the page
  require("./pagewatch.js").claimPort(PORT);   // never attach to a browser this check did not start
  const prof=fs.mkdtempSync(path.join(os.tmpdir(),'br-'));
  require("./pagewatch.js").guard(prof);            // close it even if this check throws, or is killed
  const ch=spawn(CHROME,['--headless=new','--hide-scrollbars','--remote-debugging-port='+PORT,'--user-data-dir='+prof,'--window-size=1200,900',require('./pagewatch.js').SITE+'/bridge.html'],{stdio:'ignore'});
  let send, sock;
  for(let i=0;i<160&&!send;i++){await sleep(250);try{
    const t=(await(await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find(x=>x.type==='page');
    const ws=new WebSocket(t.webSocketDebuggerUrl);await new Promise((a2,b2)=>{ws.onopen=a2;ws.onerror=b2;});
    let id=0;const m=new Map();ws.onmessage=e=>{const o=JSON.parse(e.data);if(o.id&&m.has(o.id)){m.get(o.id)(o);m.delete(o.id);}};
    send=(me,pa={})=>new Promise((a2,b2)=>{const n=++id;m.set(n,o=>o.error?b2(new Error(o.error.message)):a2(o.result));ws.send(JSON.stringify({id:n,method:me,params:pa}));});
    sock=ws;
  }catch(_){send=null;}}
  // This page is the reason pagewatch.js exists: it 404'd on EVERY open for as long as it existed and
  // this check passed 17 of 17 throughout, because nothing here was watching the network or the
  // console. Now it is watched, and asserted on at the end of the walk.
  const watch = await require('./pagewatch.js').attach(sock, send);
  const ev=async e=>{const r=await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true});
    return r.exceptionDetails?'THREW: '+r.exceptionDetails.exception.description.split('\n')[0]:r.result.value;};
  // the page fetches the market and its pictures on step 1, so how long anything takes varies:
  // wait for the thing to be true rather than for a number of milliseconds
  const until=async(expr,ms=8000)=>{const t=Date.now();while(Date.now()-t<ms){if(await ev(expr)===true)return true;await sleep(120);}return false;};
  try {
    for (let i=0;i<80 && (await ev('typeof window.bridge')) !== 'object';i++) await sleep(250);
    await until('bridge.step === 0 && !!document.querySelector(".slide h2")');
    // step 1 fetches the market and eighteen pictures for the shelf; let that finish before walking
    // the steps, or the page is still busy when the next click lands
    await until('(()=>{const b=document.getElementById("shelf");return !!b && (b.hidden || document.querySelectorAll("#lane .dcard").length > 0);})()', 20000);
    ok('the bridge opens on step 1, asking for the Solana wallet', await ev('bridge.step') === 0 &&
      /connect the solana wallet/i.test(await ev('document.querySelector(".slide h2").textContent')), await ev('document.querySelector(".slide h2").textContent'));
    ok('it is a walk of six steps, one at a time', await ev('bridge.STEPS.length') === 6 && await ev('document.querySelectorAll(".slide").length') === 6, await ev('bridge.STEPS.length'));
    // a Doopie of our own making, so the check needs no network
    const png = await ev(`(async () => {
      const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d');
      x.fillStyle = '#2878ff'; x.fillRect(0, 0, 64, 64);
      x.fillStyle = '#0c0c0c'; x.beginPath(); x.arc(32, 32, 24, 0, 7); x.fill();
      x.fillStyle = '#9ce1c6'; x.beginPath(); x.arc(32, 32, 20, 0, 7); x.fill();
      x.fillStyle = '#fafafa'; x.beginPath(); x.arc(38, 26, 7, 0, 7); x.fill();
      return c.toDataURL('image/png'); })()`);
    await ev(`(() => { bridge.S.sol = 'TestWa11etAddressTestWa11etAddressTestWa11'; bridge.S.nfts = [{ name: 'Doopies #1', mintAddress: 'MintAddr111', collection: 'doopies',
      image: ${JSON.stringify(png)}, attributes: [{ trait_type: 'Background', value: 'Neotide' }, { trait_type: 'Evolution', value: 'Evolution 1' }] }]; bridge.go(1); })()`);
    await until('bridge.step === 1 && document.querySelectorAll("[data-n]").length === 1');
    ok('step 2 lists what the wallet holds', await ev('document.querySelectorAll("[data-n]").length') === 1 && await ev('bridge.step') === 1, await ev('document.querySelectorAll("[data-n]").length'));
    await ev('document.querySelector("[data-n]").click()'); await until('bridge.S.chosen.length === 1');
    ok('tapping one picks it, and the button says what it will do', await ev('JSON.stringify(bridge.S.chosen)') === '[0]' &&
      /CONVERT 1 DOOPIE/.test(await ev('document.querySelector(".slide[data-slide=\\"1\\"] .btn.go").textContent')), await ev('document.querySelector(".slide[data-slide=\\"1\\"] .btn.go").textContent'));
    await ev('document.querySelector(".slide[data-slide=\\"1\\"] .btn.go").click()'); await until('bridge.step === 2');
    ok('step 3 is the last look: the art beside the picture, with its traits', await ev('bridge.step') === 2 &&
      await ev('document.querySelectorAll(".slide[data-slide=\\"2\\"] .model[data-cv]").length') === 1 &&
      /NEOTIDE/.test(await ev('document.querySelector(".slide[data-slide=\\"2\\"] .traits").innerText')), await ev('bridge.step'));
    await until('!!document.querySelector("[data-cv] canvas")', 30000);
    ok('the model is there, turnable, built by the converter\'s own mesh builder',
      await ev('!!document.querySelector("[data-cv] canvas")') === true &&
      await ev('bridge.S.nfts[0].tris > 1000') === true, await ev('bridge.S.nfts[0].tris'));
    ok('what goes on chain is packed from the sprite the converter made',
      await ev('bridge.S.nfts[0].chain.mask.length') === 16 &&
      await ev('bridge.S.nfts[0].chain.count > 100') === true &&
      await ev('bridge.S.nfts[0].chain.words < 100') === true,
      await ev('JSON.stringify([bridge.S.nfts[0].chain.count, bridge.S.nfts[0].chain.colors, bridge.S.nfts[0].chain.words])'));
    ok('and the card says so', /words on chain/.test(await ev('document.querySelector("[data-hex=\\"0\\"]").textContent')),
      await ev('document.querySelector("[data-hex=\\"0\\"]").textContent'));
    await ev('document.querySelector(".slide[data-slide=\\"2\\"] .btn.go").click()'); await until('bridge.step === 3');
    ok('step 4 asks where the shadows should live', await ev('bridge.step') === 3 && await ev('!!document.getElementById("evm")') === true, await ev('bridge.step'));
    await ev('(() => { document.getElementById("evm").value = "0x1111111111111111111111111111111111111111"; const b = document.querySelectorAll(".slide[data-slide=\\"3\\"] .acts .btn"); b[b.length - 1].click(); })()'); await sleep(500);
    ok('step 5 is the message to sign, naming both wallets, the art and the chain', await ev('bridge.step') === 4 &&
      /solana: TestWa11et/.test(await ev('bridge.S.message')) && /robinhood: 0x1111/.test(await ev('bridge.S.message')) &&
      /chain: 4663/.test(await ev('bridge.S.message')) && /MintAddr111/.test(await ev('bridge.S.message')), (await ev('bridge.S.message') || '').slice(0, 120));
    await ev('(() => { bridge.S.signature = "0xdeadbeef"; bridge.go(5); })()'); await until('bridge.step === 5');
    // the fee is read from the chain when the page opens, and shows as — until that answers
    await until('!!bridge.S.live && !!bridge.S.gas', 20000);
    await ev('bridge.frame()'); await sleep(150);
    const fees = await ev('document.querySelector(".slide[data-slide=\\"5\\"] .fees").innerText');
    ok('step 6 shows the fee, from the contract\'s measured gas and the chain\'s price', /GAS EACH/.test(fees) && /GAS PRICE/.test(fees) && /THE FEE/.test(fees) &&
      !/GAS EACH\s*\n\s*—/.test(fees), fees.replace(/\n/g, ' | '));
    ok('and it says plainly that the contract is not deployed yet', /not deployed yet/i.test(await ev('document.querySelector(".slide[data-slide=\\"5\\"]").innerText')) &&
      await ev('document.querySelector(".slide[data-slide=\\"5\\"] .btn.go").disabled') === true, 'no warning');
    await ev('document.querySelector(".slide[data-slide=\\"5\\"] .btn.back").click()'); await sleep(400);
    ok('BACK walks it the other way', await ev('bridge.step') === 4, await ev('bridge.step'));
    // THE BADGE, inside the watched walk and drawn by the page's own card builder rather than by a copy of
    // its rule. The bug: `.find()` over /evolution|species/i, and SPECIES IS LISTED FIRST on every
    // one-of-one - so a 1/1's card read `Dallop`, and the one token whose rarity you would most want shown
    // was the only one showing something else. The art is a data: uri so this asks nothing of the network.
    const px = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    await ev(`(() => { bridge.S.listings = { stats: null, usd: null, list: [
      { price: 1.5, token: { name: 'OneOfOne', image: ${JSON.stringify(px)}, attributes: [
        { trait_type: 'Species', value: 'Dallop' }, { trait_type: 'Background', value: 'Dusk' }, { trait_type: 'Evolution', value: '1/1' } ] } },
      { price: 0.2, token: { name: 'Ordinary', image: ${JSON.stringify(px)}, attributes: [
        { trait_type: 'Background', value: 'Dusk' }, { trait_type: 'Species', value: 'McMuffin' },
        { trait_type: 'Body', value: 'Splats' }, { trait_type: 'Evolution', value: 'Evolution 1' } ] } } ] }; bridge.go(0); })()`);
    await until('document.querySelectorAll("#lane .dcard").length >= 2', 8000);
    const badges = await ev(`JSON.stringify([...document.querySelectorAll('#lane .dcard')].slice(0, 2).map(c =>
      [c.querySelector('.nm').textContent, c.querySelector('.tr').textContent, c.querySelector('.tr').classList.contains('one')])
      .sort((a, b) => a[0] < b[0] ? -1 : 1))`);
    ok('a one-of-one\'s card reads 1/1 and is marked as rare; an ordinary Doopie reads its stage',
      badges === JSON.stringify([['OneOfOne', '1/1', true], ['Ordinary', 'Evolution 1', false]]), badges);
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }); await sleep(500);
    ok('nothing scrolls sideways on a phone', await ev('document.documentElement.scrollWidth') <= 390, await ev('document.documentElement.scrollWidth'));
    ok('nothing 404d and nothing was logged as an error, over the whole walk', watch.clean(), watch.why());
  } finally { await require('./pagewatch.js').shutdown(ch, prof); }
  console.log(bad ? '\n' + bad + ' step(s) failed' : '\nthe bridge works');
  process.exit(bad ? 1 : 0);
})();
