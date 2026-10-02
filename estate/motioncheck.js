// motioncheck: THE REDUCED-MOTION POLICY (M22 item 6), declared in DESIGN.md under "Accessibility" and held here.
//
// The policy, in the words the check holds it to - when the system asks for reduced motion
// (`prefers-reduced-motion: reduce`):
//   1. NO CSS ANIMATION RUNS. Every @keyframes animation a page can apply is off under that query, and what it
//      signalled is shown still (a steady mark for a blink, a red fill for a refusal).
//   2. NO GLITCH IS DRAWN ON A CANVAS. Code that draws one asks `matchMedia('(prefers-reduced-motion: reduce)')` and
//      draws the settled frame.
//   3. What moves because THE GAME moved stays - a Friend walking, a fight, a build rising, the camera the player
//      turns. That is information, not decoration, and this check does not touch it.
//
// HOW, in a real Chrome with the media feature emulated:
//   A. every page in estate/ (and base.html, the game, which injects the mini map's and the feed's styles at run
//      time) is opened, and EVERY style rule that applies an animation - from a stylesheet, a <style> block or a style
//      element a script inserted - is found through the CSSOM. For each, an element the rule matches is found or BUILT
//      (the selector's compounds made as nested elements, so `.card .mtop.cold .dot` or a class only added on a click
//      is reached without playing the game to that point), and its computed `animation-name` must be `none` (or its
//      duration 0s) under reduce. Then `document.getAnimations()` must hold no running CSS animation.
//   B. every file a page loads (browsercheck.js's own reading of what a page loads) whose CODE - comments and strings
//      stripped - names a glitch must ask for `prefers-reduced-motion`.
//
// THE RATCHET. Most screens predate the policy, and implementing it is the screens' owners' work ("every screen
// implements it", DESIGN.md), not this check's. So what does NOT yet comply is listed below in OWED - each entry named,
// with its owner - and this check FAILS on (a) anything that breaks the policy and is NOT in that list, so nothing new
// arrives without it, and (b) an entry in the list that now complies, so the list cannot go stale and hide a
// regression behind an old excuse. The owed list is printed on every run. A green run means "no NEW motion without a
// reduce path", NOT "the game honours reduced motion" - today it does not, and OWED says where.
//
// NOT COVERED: whether the reduce path of a canvas glitch actually draws a still frame - B asks only that the file
// ASKS (a file that reads the query and ignores it passes); JS that moves things by setting styles frame by frame
// (no @keyframes); CSS transitions (short, and triggered by the player); a selector the builder cannot construct
// (`:not()`, `:nth-*`, `+`, `~`) when no element on the page already matches - each is printed, not counted; anything
// that FLASHES - three flashes a second is a separate rule (WCAG 2.3.1) this does not measure; the pages outside
// estate/ (the landing title, the anim/ frames); and a contrast, keyboard or focus rule - the rest of the
// accessibility position is still unwritten.
const { spawn } = require('child_process'); const fs = require('fs'), os = require('os'), path = require('path');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PW = require('./pagewatch.js'); const PORT = require('./pagewatch.js').debugPort(9579);
const SITE = PW.SITE;
const { loaded, stripJs } = require('./browsercheck.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// What does not comply today, and whose it is. Keys are what the check prints: '<page> <selector> (<keyframes>)' for
// a CSS rule, 'canvas: <file>' for a file that draws a glitch without asking.
const OWED = {
  'challenge.html .mtop .dot (blink)': 'front-end - the live dot blinks forever; reduce wants it steady',
  'challenge.html .pot .gem.l (inL)': 'front-end - the stake gems fly into the pot',
  'challenge.html .pot .gem.r (inR)': 'front-end - the stake gems fly into the pot',
  'challenge.html .shake canvas (shake)': 'front-end - the hands shake before a throw',
  'challenge.html .hand.theirs.shake canvas (shakeT)': 'front-end - the other hand shakes before a throw',
  'start.html .eyebrow .dot (blink)': 'front-end - the era dot blinks forever',
  'base.html .announce .alist li.fresh (announceIn)': 'front-end - announce.js: a new feed line fades in from signal green',
  // the mini map is built only on a signed-in player's map, which no page opened here is, so its rule is read off the file
  'unreached: mmAlarm (minimap.js)': 'front-end - minimap.js: the alarm blinks forever; reduce wants it steady and still marked',
  'canvas: index.html': 'game engineer / asset maker - the claimed ground, the terminals and the meme arrival glitch (memeGlitch); M19 item 5 is the meme',
};

(async () => {
  PW.claimPort(PORT);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'mot-'));
  PW.guard(prof);
  const ch = spawn(CHROME, ['--headless=new', '--enable-unsafe-swiftshader', '--hide-scrollbars', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + prof, '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
  let send;
  for (let i = 0; i < 160 && !send; i++) { await sleep(250); try {
    const t = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((x) => x.type === 'page');
    const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
    let id = 0; const m = new Map(); ws.onmessage = (e) => { const o = JSON.parse(e.data); if (o.id && m.has(o.id)) { m.get(o.id)(o); m.delete(o.id); } };
    send = (me, pa = {}) => new Promise((ok, no) => { const n = ++id; m.set(n, (o) => (o.error ? no(new Error(o.error.message)) : ok(o.result))); ws.send(JSON.stringify({ id: n, method: me, params: pa })); });
  } catch (_) { send = null; } }
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    return r.exceptionDetails ? 'THREW: ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text).split('\n')[0] : r.result.value; };
  let bad = 0; const ok = (n, c, v) => { console.log((c ? '  ok  ' : 'FAIL  ') + n + (c ? '' : '   -> ' + v)); if (!c) bad++; };

  const REDUCE = 'BREAK_NO_EMULATION' in process.env ? [] : [{ name: 'prefers-reduced-motion', value: 'reduce' }];
  await send('Emulation.setEmulatedMedia', { features: REDUCE });
  ok('the browser reports prefers-reduced-motion: reduce', (await ev(`matchMedia('(prefers-reduced-motion: reduce)').matches`)) === true, 'not emulated');

  // ---------------------------------------------------------------- A. every animation rule, under reduce
  // Runs in the page: every style rule outside a reduce block that names an animation, an element it matches (found,
  // or built from the selector), and that element's computed animation under the emulated query.
  const PROBE = `(() => {
    const rules = [];
    const walk = (list, reduce) => { for (const r of list) {
      if (r instanceof CSSMediaRule) { walk(r.cssRules, reduce || /prefers-reduced-motion\\s*:\\s*reduce/.test(r.conditionText || r.media.mediaText)); continue; }
      if (r instanceof CSSStyleRule) { const n = r.style.animationName; if (!reduce && n && n !== 'none' && n !== 'initial') rules.push([r.selectorText, n]);
        if (r.cssRules && r.cssRules.length) walk(r.cssRules, reduce); continue; }
      if (r.cssRules) walk(r.cssRules, reduce);
    } };
    for (const ss of document.styleSheets) { let l; try { l = ss.cssRules; } catch (_) { continue; } walk(l, false); }
    // a compound "tag#id.cls[attr=v]" made into an element; html and body are the real ones, classes added for the read
    const made = [], touched = [];
    const build = (sel) => {
      const parts = sel.trim().split(/\\s*>\\s*|\\s+/);
      let parent = document.body, last = null;
      for (const p of parts) {
        const m = p.match(/^([a-zA-Z][\\w-]*|\\*)?((?:[#.][\\w-]+|\\[[^\\]]+\\])*)$/); if (!m) return null;
        const tag = (m[1] && m[1] !== '*') ? m[1].toLowerCase() : 'div';
        let el;
        if (tag === 'html' || tag === 'body') el = tag === 'html' ? document.documentElement : document.body;
        else { el = document.createElement(tag); parent.appendChild(el); made.push(el); }
        for (const t of m[2].match(/[#.][\\w-]+|\\[[^\\]]+\\]/g) || []) {
          if (t[0] === '.') { if (!el.classList.contains(t.slice(1))) { el.classList.add(t.slice(1)); touched.push([el, t.slice(1)]); } }
          else if (t[0] === '#') { if (!el.id) el.id = t.slice(1); }
          else { const a = t.slice(1, -1).match(/^([\\w-]+)(?:[~|^$*]?=["']?([^"']*)["']?)?$/); if (a) el.setAttribute(a[1], a[2] || ''); }
        }
        parent = el; last = el;
      }
      return last;
    };
    const out = [];
    for (const [selText, name] of rules) for (const one of selText.split(/,(?![^(]*\\))/)) {
      let s = one.trim(), pe = null;
      const pm = s.match(/::?(before|after|marker|placeholder)$/); if (pm) { pe = '::' + pm[1]; s = s.slice(0, -pm[0].length); }
      const dyn = /:(hover|focus|focus-visible|focus-within|active|checked|disabled)\\b/.test(s);
      s = s.replace(/:(hover|focus|focus-visible|focus-within|active|checked|disabled)\\b/g, '');
      // BUILT FIRST: an element made from the selector and nothing else is what the rule alone applies to. An element
      // already on the page can carry a second class that switches the animation off (start.html's .dot.idle), and
      // reading that one would call the rule compliant when it is not.
      let el = build(s), how = 'built';
      if (!el) { try { el = document.querySelector(s); } catch (_) {} how = 'found'; }
      if (!el) { out.push({ sel: one.trim(), name, how: 'unreachable' }); continue; }
      const cs = getComputedStyle(el, pe);
      const off = cs.animationName === 'none' || cs.animationDuration.split(',').every(d => parseFloat(d) === 0);
      out.push({ sel: one.trim(), name, how: how + (dyn ? ' (its :hover/:focus state taken as on)' : ''), off, now: cs.animationName + ' ' + cs.animationDuration });
    }
    for (const e of made.reverse()) e.remove();
    for (const [e, c] of touched) e.classList.remove(c);
    const running = document.getAnimations().filter(a => a.playState === 'running' && a.animationName).map(a => a.animationName + ' on ' + (a.effect && a.effect.target ? (a.effect.target.tagName.toLowerCase() + (a.effect.target.className && typeof a.effect.target.className === 'string' ? '.' + a.effect.target.className.trim().split(/\\s+/).join('.') : '')) : '?'));
    return JSON.stringify({ out, running });
  })()`;
  const pages = fs.readdirSync(__dirname).filter((f) => f.endsWith('.html') && f !== 'index.html').sort().concat(['base.html', 'base.html?world=1']);
  const seen = new Set(), unreachable = [], names = new Set(), printed = new Set();
  for (const pg of pages) {
    await send('Page.navigate', { url: SITE + '/' + pg + (pg.startsWith('base.html') ? (pg.includes('?') ? '&' : '?') + 'record=0' : '') });
    for (let i = 0; i < 80 && (await ev('document.readyState')) !== 'complete'; i++) await sleep(150);
    if (pg.startsWith('base.html')) await PW.waitForGame(send); else await sleep(800);
    await sleep(1200);
    const r = await ev(PROBE); let R; try { R = JSON.parse(r); } catch (_) { ok(pg + ': the probe ran', false, r); continue; }
    const name = (o) => pg.split('?')[0] + ' ' + o.sel + ' (' + o.name + ')';
    for (const o of R.out) {
      if (o.how === 'unreachable') { unreachable.push(name(o)); continue; }
      seen.add(name(o)); for (const n of o.name.split(',')) names.add(n.trim());
      const owed = OWED[name(o)];
      if (o.off) ok(name(o) + ' is off under reduce (' + o.how + ')' + (owed ? ' - and it is in OWED, which must lose it' : ''), !owed, 'complies now: remove it from OWED');
      else if (owed) { if (!printed.has(name(o))) console.log('  owed ' + name(o) + ' still animates (' + o.now + ') - ' + owed); printed.add(name(o)); }
      else ok(name(o) + ' is off under reduce (' + o.how + ')', false, 'still animates: ' + o.now + ' - stop it under @media (prefers-reduced-motion: reduce)');
    }
    const running = R.running.filter((a) => !Object.keys(OWED).some((k) => k.startsWith(pg.split('?')[0] + ' ') && k.endsWith('(' + a.split(' on ')[0] + ')')));
    ok(pg + ': no CSS animation is running under reduce' + (R.running.length > running.length ? ' (owed ones aside)' : ''), running.length === 0, running.join('; '));
  }
  for (const k of Object.keys(OWED).filter((k) => !/^(canvas|unreached):/.test(k))) ok('OWED entry still names a rule that exists: ' + k, seen.has(k), 'no such rule any more - remove it from OWED');
  // every @keyframes any loaded file defines, against the ones a browser run reached: one never applied on a page
  // opened here (a style only built in a mode this does not open) is printed, not counted
  const defined = new Map();
  for (const f of loaded().filter((f) => !f.startsWith('('))) for (const m of fs.readFileSync(path.join(__dirname, f), 'utf8').matchAll(/@keyframes\s+([\w-]+)/g)) if (!defined.has(m[1])) defined.set(m[1], f);
  const never = [...defined].filter(([n]) => !names.has(n));
  // Those are held by their FILE instead: the file that defines one must ask prefers-reduced-motion somewhere. Weaker
  // than the computed read above - it cannot tell which rule the file switches off - and said so.
  for (const [n, f] of never) {
    const key = 'unreached: ' + n + ' (' + f + ')', owed = OWED[key], asks = /prefers-reduced-motion/.test(fs.readFileSync(path.join(__dirname, f), 'utf8'));
    if (owed && !asks) { console.log('  owed ' + key + ' - never applied on a page opened here, and its file never asks - ' + owed); continue; }
    ok(key + ': never applied on a page opened here, so read off the file: it asks prefers-reduced-motion' + (owed ? ' - and it is in OWED, which must lose it' : ''), asks && !owed, asks ? 'complies now: remove it from OWED' : 'the file never reads the query');
  }
  for (const k of Object.keys(OWED).filter((k) => k.startsWith('unreached:'))) ok('OWED entry still names a keyframes no page reaches: ' + k, never.some(([n, f]) => k === 'unreached: ' + n + ' (' + f + ')'), 'it is reached now, or gone - move or remove it');
  if (unreachable.length) console.log('      not reached (no element matches and the selector cannot be built): ' + unreachable.join('; '));

  // ---------------------------------------------------------------- B. a canvas glitch asks
  const files = loaded().filter((f) => !f.startsWith('('));
  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    const code = stripJs(/\.html$/.test(f) ? [...src.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n') : src, false);
    if (!/glitch/i.test(code)) continue;
    const asks = /prefers-reduced-motion/.test(src);
    const owed = OWED['canvas: ' + f];
    if (owed && !asks) { console.log('  owed canvas: ' + f + ' draws a glitch and does not ask - ' + owed); continue; }
    ok('canvas: ' + f + ' draws a glitch and asks prefers-reduced-motion' + (owed ? ' - and it is in OWED, which must lose it' : ''), asks && !owed, asks ? 'complies now: remove it from OWED' : 'it never reads the query');
  }

  console.log('\n      OWED - what does not honour reduced motion yet, and whose it is (' + Object.keys(OWED).length + '):');
  for (const [k, v] of Object.entries(OWED)) console.log('        ' + k + ': ' + v);
  console.log(bad ? `\n${bad} step(s) failed` : '\nnothing animates under reduced motion that is not on the owed list');
  await PW.shutdown(ch, prof); process.exit(bad ? 1 : 0);
})();
