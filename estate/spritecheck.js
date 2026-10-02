// THE FRIEND'S SPRITES, WHICH NOTHING READ.
//
// Nothing here read `spriteSets`, `family`, `familyName` or the facing, and the facing is the one thing
// about a sprite that a screenshot cannot tell you apart from by eye. `headingFacing` was drawing THE
// WRONG FRAME 30% OF THE TIME - at yaw 0 every cardinal heading did, so a Friend walking along +x read
// as walking at the camera - and no check in this folder could see it. `headingFacing`, `setFrame`,
// `ROSTER`, `SETS` and `FACINGS` were put on `window.base` read-only specifically to make this cheap.
//
//   node estate/spritecheck.js                (needs the local server on :8765)
//
// THE RULE BEING CHECKED, because it is not obvious and it is the whole bug. The art ships four real
// facings, straight off the registry the SDK points at - no mirroring. Our world TURNS where the SDK's
// does not, so the facing is picked in SCREEN space: rotate the world heading by the camera's yaw,
// project it, and compare the two pixel deltas the way the SDK's movement.ts does. The projection is
// flat - its horizontal weight is about 0.87 against 0.28 vertical - so the bands are NOT quarters: the
// two side views carry about four fifths of the circle and front and back share the remaining fifth.
// Working the boundary out from those weights puts it at 27.1 and 62.9 degrees, which makes up + down
// 71.6 degrees of 360, or 19.9%. Drop the projection weights and the comparison becomes |x| against
// |y|, the boundary moves to 45 degrees, and up + down take HALF the circle instead of a fifth. That is
// the 30% of headings that drew the wrong frame, and the band measurement below is what catches it.
//
// WHAT IT DOES NOT COVER. Not one pixel of what is drawn on the canvas: this reads the frame the game
// would choose, not the image it paints, so a frame chosen correctly and then drawn at the wrong
// scale, tint or place passes every line. Nothing about the Doopies' slab art (a different path -
// `paintFace`), nothing about the halo or rim caches, and nothing about animation SPEED - the 110 ms a
// frame is read back from the game rather than asserted to be right. The band tolerance (17% to 23%) is
// judgement: it is wide enough to survive a small change to the projection's weights and narrow enough
// to catch their removal, which is the failure that happened. And `ISO`'s weights are not exposed, so
// the expected fifth is derived in this comment and not recomputed from the page.
const { spawn } = require('child_process'); const fs = require('fs'), os = require('os'), path = require('path');
const BREAK = process.env.BREAK || '';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = require('./pagewatch.js').debugPort(9559);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  require('./pagewatch.js').claimPort(PORT);   // never attach to a browser this check did not start
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-'));
  require('./pagewatch.js').guard(prof);       // close it even if this check throws, or is killed
  const ch = spawn(CHROME, ['--headless=new', '--enable-unsafe-swiftshader', '--hide-scrollbars',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + prof, '--window-size=1100,800',
    require('./pagewatch.js').SITE+'/base.html'], { stdio: 'ignore' });
  let send, sock;
  for (let i = 0; i < 160 && !send; i++) {
    await sleep(250);
    try {
      const t = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((x) => x.type === 'page');
      const ws = new WebSocket(t.webSocketDebuggerUrl);
      await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
      let id = 0; const m = new Map();
      ws.onmessage = (e) => { const o = JSON.parse(e.data); if (o.id && m.has(o.id)) { m.get(o.id)(o); m.delete(o.id); } };
      send = (me, pa = {}) => new Promise((ok, no) => { const n = ++id; m.set(n, (o) => o.error ? no(new Error(o.error.message)) : ok(o.result)); ws.send(JSON.stringify({ id: n, method: me, params: pa })); });
      sock = ws;
    } catch (_) { send = null; }
  }
  if (!send) throw new Error('chrome never came up on ' + PORT);
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    return r.exceptionDetails ? 'THREW: ' + r.exceptionDetails.exception.description.split('\n')[0] : r.result.value; };
  const J = async (e) => { const v = await ev('JSON.stringify(' + e + ')'); if (typeof v !== 'string') throw new Error('not JSON from ' + e + ': ' + v); return JSON.parse(v); };
  const watch = await require('./pagewatch.js').attach(sock, send);
  let bad = 0; const ok = (n, c, v) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (c ? '' : '   -> ' + v)); if (!c) bad++; };

  try {
    // Waited on the page itself, not a stopwatch: a fixed 2 s was a claim about how much CPU the run had, and
    // under `-j 4` base.html was not up yet - the first J() then threw on a ReferenceError and took the check down.
    const READY = '!!(window.base && base.SETS && base.ROSTER && base.FACINGS && base.headingFacing && base.setFrame)';
    const t0 = Date.now();
    while (Date.now() - t0 < 30000 && (await ev(READY)) !== true) await sleep(250);
    console.log('      (waited ' + (Date.now() - t0) + ' ms of wall clock for the estate, at most 30000)');
    ok('the estate is up and its sprite tables are on the page',
      await ev('!!(window.base && base.SETS && base.ROSTER && base.FACINGS && base.headingFacing && base.setFrame)') === true,
      await J('Object.keys(window.base||{}).filter(k=>/SET|ROSTER|FACING|Frame|Facing/.test(k))'));

    // ---------- the art the registry ships ----------
    const FACINGS = await J('base.FACINGS');
    ok('four facings, and they are the registry\'s own four: ' + FACINGS.join(', '),
      JSON.stringify(FACINGS) === JSON.stringify(['down', 'up', 'left', 'right']), JSON.stringify(FACINGS));

    const sets = await J('base.SETS.map(s=>({token:s.token,family:s.family,familyName:s.familyName,generation:s.generation}))');
    ok('the family reference is every family, one real token each, all at generation 0 on chain ('
      + sets.length + ' families: ' + sets.map((s) => s.familyName).join(', ') + ')',
      sets.length >= 9 && sets.every((s) => s.generation === 0 && s.token && s.familyName)
      && new Set(sets.map((s) => s.family)).size === sets.length,
      JSON.stringify(sets));

    // Shape, for every set and every facing. `clip()` decodes 16 rows of 16 from one 256-bit word per
    // frame, so a frame that came back short means the decode is wrong or the registry returned less
    // art than the page thinks it did.
    const shape = await J(`(()=>{const out={bad:[],frames:0};
      for (const list of [['SETS',base.SETS],['ROSTER',base.ROSTER]])
        list[1].forEach((s,i)=>{ for(const clip of ['idle','walk']) for(const f of base.FACINGS){
          const c = s[clip] && s[clip][f];
          if(!Array.isArray(c)||c.length!==8) { out.bad.push(list[0]+'['+i+'].'+clip+'.'+f+' has '+(c?c.length:'no')+' frames'); continue; }
          for(const fr of c){ out.frames++;
            if(!Array.isArray(fr)||fr.length!==16||fr.some(r=>typeof r!=='string'||r.length!==16))
              out.bad.push(list[0]+'['+i+'].'+clip+'.'+f+' is not 16x16'); } } });
      return out;})()`);
    ok('every set carries idle and walk for all four facings, eight frames of 16x16 each ('
      + shape.frames + ' frames read)', shape.bad.length === 0 && shape.frames > 0, shape.bad.slice(0, 4).join('; '));

    // ---------- the Friends on the estate are real, claimed by their token ----------
    const roster = await J('base.ROSTER.map(r=>({token:r.token,family:r.family,familyName:r.familyName,generation:r.generation}))');
    const dupes = roster.map((r) => r.token).filter((t, i, a) => a.indexOf(t) !== i);
    ok('no two Friends in the roster share a token (' + roster.length + ' tokens)', dupes.length === 0, dupes.join(', '));
    ok('every roster Friend is of a real generation, 1 to 6',
      roster.every((r) => r.generation >= 1 && r.generation <= 6), JSON.stringify(roster.map((r) => r.generation)));

    const friends = await J(`base.actors.filter(a=>a.kind==='friend'&&a.set)
      .map(a=>({name:a.name,gen:a.gen,token:a.set.token,setGen:a.set.generation,family:a.set.family,familyName:a.set.familyName}))`);
    ok('every Friend standing on the estate carries a real roster token (' + friends.length + ' Friends)',
      friends.length > 0 && friends.every((f) => roster.some((r) => r.token === f.token)),
      JSON.stringify(friends.filter((f) => !roster.some((r) => r.token === f.token))));
    // A Friend is CLAIMED from the roster by the generation it is - nothing is dealt out in turn - so its
    // generation and its art's generation are the same number, and its family comes from its own token.
    ok('and its generation is its token\'s generation: the token decides the art, nothing is dealt in turn',
      friends.every((f) => f.gen === f.setGen), JSON.stringify(friends.filter((f) => f.gen !== f.setGen)));
    ok('and its family name is the roster\'s for that token, not a title',
      friends.every((f) => { const r = roster.find((x) => x.token === f.token); return r && r.family === f.family && r.familyName === f.familyName; }),
      JSON.stringify(friends.filter((f) => { const r = roster.find((x) => x.token === f.token); return !r || r.familyName !== f.familyName; })));
    ok('no two Friends on the estate are the same token', new Set(friends.map((f) => f.token)).size === friends.length,
      JSON.stringify(friends.map((f) => f.token).filter((t, i, a) => a.indexOf(t) !== i)));

    // ---------- the facing, at yaw 0 ----------
    // These six are the ones the old bug got wrong: at yaw 0 EVERY cardinal heading drew the wrong
    // frame. Isometrically the world axes run diagonally on screen, so +x is 'right', +y is 'left', and
    // the diagonals are what face the camera and away from it.
    await ev('base.yaw = 0'); await sleep(300);
    const at0 = await J(`({right: base.headingFacing(1,0), leftY: base.headingFacing(0,1), leftX: base.headingFacing(-1,0),
      rightY: base.headingFacing(0,-1), down: base.headingFacing(1,1), up: base.headingFacing(-1,-1),
      cam: base.headingFacing(1,1)})`);
    ok('at yaw 0 the world axes read as screen sides: +x right, +y left, -x left, -y right',
      at0.right === 'right' && at0.leftY === 'left' && at0.leftX === 'left' && at0.rightY === 'right', JSON.stringify(at0));
    ok('and the diagonals are the ones facing the camera and away from it: (1,1) down, (-1,-1) up',
      at0.down === 'down' && at0.up === 'up', JSON.stringify(at0));

    // ---------- the bands: a fifth, not a half ----------
    const bands = await J(`(()=>{const n=3600, c={down:0,up:0,left:0,right:0,other:0};
      for(let i=0;i<n;i++){const a=i/n*Math.PI*2, f=base.headingFacing(Math.cos(a),Math.sin(a));
        if(f in c) c[f]++; else c.other++;}
      return {n, c, frontBack:(c.up+c.down)/n, sides:(c.left+c.right)/n};})()`);
    ok('the facing bands are the projection\'s, not quarters: front and back share '
      + (bands.frontBack * 100).toFixed(1) + '% of the circle and the two sides carry '
      + (bands.sides * 100).toFixed(1) + '% (want 17-23% front and back; drop the projection weights and it is 50%)',
      bands.frontBack >= 0.17 && bands.frontBack <= 0.23 && bands.c.other === 0, JSON.stringify(bands));
    ok('and all four facings are used, none of them empty', Object.values(bands.c).slice(0, 4).every((v) => v > 0), JSON.stringify(bands.c));

    // ---------- it turns with the camera ----------
    // The sprite turns with the camera: that is the rule, and it is the reason the facing is picked in
    // screen space at all. One fixed WORLD heading must sweep all four facings as the camera goes round,
    // in one cyclic order, and come back to where it started. An implementation that ignored yaw - or
    // one that turned the wrong way - fails here.
    const sweep = await J(`(()=>{const out=[]; const keep=base.yaw;
      for(let i=0;i<24;i++){ base.yaw = i/24*Math.PI*2; out.push(base.headingFacing(1,0)); }
      base.yaw = keep; return out;})()`);
    const runs = sweep.filter((f, i) => f !== sweep[(i + sweep.length - 1) % sweep.length]);
    ok('one fixed world heading sweeps all four facings as the camera turns, and only changes four times '
      + 'in a full turn: ' + [...new Set(sweep)].join(' -> '),
      new Set(sweep).size === 4 && runs.length === 4, JSON.stringify(sweep));
    ok('and it comes back to the facing it started on after a full turn', sweep[0] === 'right', JSON.stringify([sweep[0], sweep[sweep.length - 1]]));
    // The standing-still heading is asked of the schedule rather than written down as "towards the
    // camera": (0,1) is only that at a few yaws. So whatever yaw the camera is at, SOME heading reads
    // 'down' - otherwise a Friend standing still has nothing to look out of.
    const camOk = await J(`(()=>{const keep=base.yaw, H=[[0,1],[1,0],[0,-1],[-1,0],[1,1],[1,-1],[-1,1],[-1,-1]], out=[];
      for(let i=0;i<12;i++){ base.yaw=i/12*Math.PI*2; out.push(!!H.find(h=>base.headingFacing(h[0],h[1])==='down')); }
      base.yaw=keep; return out;})()`);
    ok('at every camera angle some world heading faces the camera, so a Friend standing still has one',
      camOk.every(Boolean), JSON.stringify(camOk));

    // ---------- family 6 has no front or back art, and the fallback is real ----------
    await ev('base.yaw = 0'); await sleep(200);
    const blank = (rows) => rows.every((r) => /^\.+$/.test(r));
    // Two shapes, branched on the DATA (set.drawn, from the asset-maker's drawnFacings), never on the family
    // number: with front/back drawn, setFrame must show them; without, the side fallback must hold.
    // BREAK=nodrawn clears drawn on the page's set, so the side-only branch runs against drawn art and the
    // "ships no front or back" line goes red; BREAK=fallback makes setFrame ignore drawn (the drawn branch
    // goes red). Neither touches a file.
    if (BREAK === 'nodrawn') await ev(`(()=>{const s=base.SETS.find(x=>x.family===6)||base.ROSTER.find(x=>x.family===6); if(s) s.drawn=false; return true;})()`);
    if (BREAK === 'fallback') await ev(`(()=>{const s=base.SETS.find(x=>x.family===6)||base.ROSTER.find(x=>x.family===6); if(s) Object.defineProperty(s,'drawn',{get:()=>false,configurable:true}); window.__sp6drawn=true; return true;})()`);
    const fam6 = await J(`(()=>{const s=base.SETS.find(x=>x.family===6)||base.ROSTER.find(x=>x.family===6);
      if(!s) return null;
      const empty=(c)=>c.every(fr=>fr.every(r=>/^\\.+$/.test(r)));
      return {name:s.familyName, drawn: !!s.drawn || !!window.__sp6drawn, up:empty(s.idle.up), down:empty(s.idle.down), left:empty(s.idle.left), right:empty(s.idle.right)};})()`);
    const f6 = await J(`(()=>{const s=base.SETS.find(x=>x.family===6)||base.ROSTER.find(x=>x.family===6);
      const mem={}; const blank=(fr)=>fr.every(r=>/^\\.+$/.test(r)); const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
      // turn it to the left first, then ask for the camera-facing heading
      const l = base.setFrame(s, 0, 1, false, 0, mem);      // (0,1) reads 'left' at yaw 0
      const sideAfterLeft = mem.side;
      const front = base.setFrame(s, 1, 1, false, 0, mem);  // (1,1) reads 'down' at yaw 0
      const sameAsLeft = eq(front, s.idle.left[0]), isDown = eq(front, s.idle.down[0]);
      const r = base.setFrame(s, 0, -1, false, 0, mem);     // (0,-1) reads 'right'
      const front2 = base.setFrame(s, 1, 1, false, 0, mem);
      const sameAsRight = eq(front2, s.idle.right[0]);
      const back = base.setFrame(s, -1, -1, false, 0, mem); // (-1,-1) reads 'up' at yaw 0
      return {sideAfterLeft, sideAfterRight: mem.side, frontBlank: blank(front), sameAsLeft, sameAsRight, isDown, isUp: eq(back, s.idle.up[0]), backBlank: blank(back)};})()`);
    if (fam6 && fam6.drawn) {
      ok('family 6 (' + fam6.name + ') ships drawn front and back art (drawnFacings) and both sides',
        !fam6.up && !fam6.down && !fam6.left && !fam6.right, JSON.stringify(fam6));
      ok('with front/back drawn, setFrame shows family 6\'s own front and back, not a side and never a blank frame',
        f6.isDown && f6.isUp && !f6.frontBlank && !f6.backBlank && !f6.sameAsLeft, JSON.stringify(f6));
    } else {
      ok('family 6 (' + (fam6 && fam6.name) + ') ships no front or back art at all, and does ship both sides '
        + '- which is why there is a fallback', !!fam6 && fam6.up && fam6.down && !fam6.left && !fam6.right, JSON.stringify(fam6));
      // A heading that would ask family 6 for its front must come back with a SIDE frame, never the blank
      // one. And the side it comes back with is the one it last turned to, remembered on the actor.
      ok('asked for family 6\'s front, setFrame gives the side it last turned to and never a blank frame',
        f6.frontBlank === false && f6.sameAsLeft === true && f6.sameAsRight === true, JSON.stringify(f6));
    }
    ok('and the side it turned to is remembered on the actor (left, then right)',
      f6.sideAfterLeft === 'left' && f6.sideAfterRight === 'right', JSON.stringify(f6));

    // ---------- the animation: eight slots over a shorter loop, and walk is not how they stand ----------
    // MEASURED BEFORE ASSERTED, and the first version of these two lines was wrong because it was not.
    // It asserted eight DISTINCT walk frames and that walk[0] differs from idle[0]. Neither is true of
    // any set: all twenty-four - nine families and fifteen roster Friends - ship eight slots over
    // exactly FOUR distinct poses, and every one of them starts its walk on the same pose it stands on.
    // That is uniform across the whole registry, so it is the art's design and not a fault. What is
    // worth asserting is the uniformity itself (a set down to one pose would be broken art, and a set
    // out of step with the other twenty-three is a decode bug) and the cycle's timing.
    const anim = await J(`(()=>{const step=110, out={poses:[], names:[], bad:[]};
      const all=[...base.SETS,...base.ROSTER];
      all.forEach(s=>{ const d=new Set(s.walk.right.map(f=>f.join(''))).size; out.poses.push(d);
        if (JSON.stringify(s.walk.right)===JSON.stringify(s.idle.right)) out.names.push(s.familyName); });
      const s=base.ROSTER.find(x=>x.family!==6)||base.SETS[0], mem={};
      const at=(t,w)=>JSON.stringify(base.setFrame(s,1,0,w,t,mem));
      return Object.assign(out, {slots:s.walk.right.length, wraps: at(0,true)===at(8*step,true),
        advances: at(0,true)!==at(step,true), holds: at(0,true)===at(step-1,true), sets: all.length});})()`);
    const poses = [...new Set(anim.poses)];
    ok('every one of the ' + anim.sets + ' sets walks on the same loop: eight slots over ' + poses.join('/')
      + ' distinct poses', anim.slots === 8 && poses.length === 1 && poses[0] > 1, JSON.stringify(anim.poses));
    ok('the walk advances one slot every 110 ms of game time and wraps after eight',
      anim.wraps === true && anim.advances === true && anim.holds === true, JSON.stringify(anim));
    // The one exception is named rather than tolerated: the Hoverer floats, so it has no gait and its
    // walk clip IS its idle clip. If a second family lost its walk this line would say which.
    ok('every family walks differently from how it stands, except the one that hovers ('
      + (anim.names.join(', ') || 'none') + ')',
      anim.names.every((n) => n === 'Hoverer') , 'these have no walk of their own: ' + anim.names.join(', '));

    ok('nothing 404d and nothing was logged as an error, over the whole run', watch.clean(), watch.why());
  } finally {
    await require('./pagewatch.js').shutdown(ch, prof);
  }
  console.log(bad ? `\n${bad} step(s) failed` : '\nthe sprites are real, claimed by token, and they face the way the projection says');
  process.exit(bad ? 1 : 0);
})();
