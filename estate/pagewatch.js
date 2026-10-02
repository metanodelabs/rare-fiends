// What a check cannot see, it cannot check.
//
// Twenty-one of the checks in this folder drive a real Chrome, and for a long time NOT ONE of them
// enabled `Network` or `Log`. Two enabled `Runtime` and then threw every event away, because their
// `ws.onmessage` only forwards messages that carry an `id` - a reply - and an event has no `id`.
//
// The consequence was not hypothetical. The bridge page 404'd on every single open for as long as it
// existed, and `bridgecheck` passed 17 of 17 throughout. A green run meant the things asserted were
// true. It said nothing about whether the page worked.
//
// This is the missing eye, written once so it is not pasted twenty-one times. A check attaches it
// straight after its CDP socket is up, and asserts on it at the end:
//
//   const watch = await require('./pagewatch.js').attach(sock, send);
//   ...                                                   // the check does its work
//   ok('nothing 404s and nothing is logged as an error', watch.clean(), watch.why());
//
// It reports two things and nothing else:
//   - a request that came back 400 or worse, or that failed to connect at all on our own origin, and
//   - an error logged to the console, an uncaught exception included.
// (A request that failed to connect OFF our origin is printed and not counted - see below for why.)
//
// WHY `Log` IS ENABLED AS WELL AS `Network`. Every check here launches Chrome with the URL already on
// the command line and attaches a quarter of a second later, by which time the document and most of
// its subresources have been asked for and answered - so the `Network` events for the OPENING LOAD
// are over before anybody is listening, which is exactly the load the bridge page was failing.
// `Log.enable` is the way back in: the Log domain keeps what it has collected and replays it to a
// client that enables it, so a 404 from before we attached still arrives. `Network` then covers
// everything the check itself goes on to provoke, with the url and status rather than a sentence.
//
// A REQUEST THIS STILL CANNOT SEE: one made and answered before the browser's own debugging
// endpoint is up at all, on a page that logs nothing about it. Nothing here navigates the page, so
// what `Log` did not keep is gone. A check that must be certain of its opening load should launch on
// `about:blank` and navigate after attaching.
'use strict';
const fs = require('fs');

// Noise that is not the page failing. EVERY LINE SAYS WHY: an unexplained pattern in this list is
// how a real failure gets silenced, and this file exists because of a failure that was silenced.
const IGNORE = [
  // Chrome asks for these itself, on any page, whether or not the site has one.
  [/\/favicon\.ico$/, 'the browser asks for a favicon on its own; a missing one is not the page'],
  [/\/\.well-known\//, 'the browser probes .well-known paths on its own'],
  // A request the page abandons - navigating away, or dropping a fetch it no longer needs - arrives as
  // a failure with no status. `Network` flags most of those with `canceled`, which is handled below;
  // this catches the rest, which only ever reach us as an errorText.
  [/^failed net::ERR_ABORTED\b/, 'the page abandoned its own request'],
];
const ignored = (s) => IGNORE.find(([re]) => re.test(s));

// OURS AND NOT OURS, and why this line decides whether these checks are trustworthy. The pages used to
// load Google's fonts (served from estate/fonts/ since 2026-10-01), and the ones reading chain values call
// two public RPC endpoints. If a check went red because a host like those was unreachable, it would be reporting the weather,
// and the lesson taught would be to re-run until green - the lesson `cellcheck` and `woodcheck`
// already cost this project twice.
//
// So the rule is by kind, not by host:
//   - a STATUS of 400 or worse fails wherever it came from: a 404 from a font CDN is a url WE typed
//     wrong, and that is our page being broken.
//   - a request that never connected fails only if it was OUR OWN origin. Off-origin, it is somebody
//     else's server or this machine's network, and it is reported beside the result, not counted.
const sameOrigin = (url, origin) => !!origin && String(url || '').startsWith(origin);

// The console lines a check is allowed to expect, passed in per check as `opts.allow`. Each entry is
// a [RegExp, why] pair for the same reason the list above is: a bare regex teaches nothing.
async function attach(ws, send, opts = {}) {
  const allow = (opts.allow || []).map(([re, why]) => [re, why]);
  // Seen off our own origin: not counted against the page, but SAID THE MOMENT IT HAPPENS. A check
  // that passes while quietly holding something it saw is how the blind spot this file fixes began.
  const aside = [];
  const setAside = (line) => { if (aside.includes(line)) return; aside.push(line); console.log('      (off-origin, not counted against the page) ' + line); };
  // key -> what to print. The same 404 arrives twice, once from `Network` and once as `Log`'s
  // sentence about it, so the key is what makes them one finding; there is deliberately no count,
  // because a number that sometimes doubles is worse than no number.
  const found = new Map();
  const note = (key, what) => {
    if (ignored(key) || allow.find(([re]) => re.test(key)) || found.has(key)) return;
    found.set(key, what);
  };

  // Our own origin, asked for BEFORE the handler goes on: the backlog `Log.enable` replays is the
  // opening load, and by then the document's own `requestWillBeSent` is long past, so there would be
  // nothing left to learn it from. `Network` fills it in later for a check that attaches before its
  // page exists. Without it every off-origin hiccup counts against the page.
  //
  // The same read asks the page for THE STATUS OF ITS OWN DOCUMENT, and that line is here because
  // everything above missed it. A page whose MAIN DOCUMENT came back 404 - the exact shape of a rename
  // that leaves one url behind - was reported CLEAN: `Network` never saw the response, because it
  // happened before we attached, and Chrome writes NO log entry for a 404 navigation, because from the
  // browser's point of view nothing failed: the server answered, and it rendered the answer. Measured,
  // not reasoned: `http://localhost:8765/armoury.html` (a panel, never a page) and a url invented on the
  // spot both came back `clean` from this file while the server was returning 404 for both.
  // `performance.getEntriesByType('navigation')[0].responseStatus` is the way in - the Performance
  // Timeline keeps the status after the fact, so it is still there when we arrive late. It reads 0 for
  // `about:blank` and for anything cross-origin without Timing-Allow-Origin, which is why only >= 400
  // counts; a page navigated AFTER we attach is covered by `Network.responseReceived` instead, and this
  // timeline is replaced with the new document's on every navigation.
  let origin = opts.origin || '';
  try {
    const r = await send('Runtime.evaluate', { returnByValue: true, expression:
      "(()=>{const n=performance.getEntriesByType('navigation')[0]||{};return JSON.stringify([location.origin, n.responseStatus|0, n.name||location.href]);})()" });
    const [org, status, url] = JSON.parse((r && r.result && r.result.value) || '[]');
    if (!origin && /^https?:\/\//.test(org || '')) origin = org;
    if (status >= 400) note(status + ' ' + url, status + '  ' + url + '  (the page\'s own document)');
  } catch (_) {}

  // `Network.loadingFailed` names only the request id, so the url has to be remembered from when the
  // request went out - otherwise there is no way to tell our own server from somebody else's.
  const urlOf = new Map();
  const remember = (id, url) => { if (urlOf.size > 4000) urlOf.clear(); urlOf.set(id, url); };

  // The check owns `ws.onmessage` and routes replies by `id`. Wrap it rather than replace it: the
  // check's own routing must keep working, and the events it discards come here.
  const prev = ws.onmessage;
  ws.onmessage = (e) => {
    if (prev) prev(e);
    let o; try { o = JSON.parse(e.data); } catch (_) { return; }
    if (!o.method) return;
    const p = o.params || {};
    if (o.method === 'Network.requestWillBeSent') {
      remember(p.requestId, p.request && p.request.url);
      if (!origin && p.type === 'Document' && /^https?:/.test(p.request.url || '')) origin = new URL(p.request.url).origin;
    } else if (o.method === 'Network.responseReceived') {
      remember(p.requestId, p.response && p.response.url);
      const st = p.response && p.response.status;
      if (st >= 400) note(st + ' ' + p.response.url, st + '  ' + p.response.url);
    } else if (o.method === 'Network.loadingFailed') {
      // `canceled` is the page changing its mind; a real failure carries an error text
      const why = p.errorText || 'failed', url = urlOf.get(p.requestId);
      // No url means the request went out before we attached, and `Network` does not replay - so this
      // is the failure `Log` is about to report WITH its url. Leave it to that one rather than print a
      // second line that cannot say what failed.
      if (p.canceled || !url) return;
      const line = 'request failed: ' + why + '  ' + url + (p.type ? '  (' + p.type + ')' : '');
      if (sameOrigin(url, origin) || !origin) note('failed ' + why + ' ' + url, line);
      else setAside(line);
    } else if (o.method === 'Runtime.exceptionThrown') {
      const d = p.exceptionDetails || {};
      const line = (d.exception && (d.exception.description || d.exception.value)) || d.text || 'exception';
      note('threw ' + String(line).split('\n')[0], 'uncaught: ' + String(line).split('\n')[0]);
    } else if (o.method === 'Runtime.consoleAPICalled') {
      if (p.type !== 'error' && p.type !== 'assert') return;
      const text = (p.args || []).map((a) => a.description || (a.value === undefined ? a.type : String(a.value))).join(' ');
      note('console ' + text.split('\n')[0], 'console.' + p.type + ': ' + text.split('\n')[0].slice(0, 200));
    } else if (o.method === 'Log.entryAdded') {
      const en = p.entry || {};
      if (en.level !== 'error') return;
      const text = String(en.text || '');
      // A network entry here is the same 404 `Network.responseReceived` reports, said in a sentence.
      // Key it by url and status so the two do not count twice.
      const st = (text.match(/status of (\d{3})/) || [])[1];
      if (en.source === 'network') {
        // the same finding `Network` already reported, said in a sentence; keyed the same way so it
        // counts once, and held to the same ours/not-ours rule
        if (st && en.url) note(st + ' ' + en.url, st + '  ' + en.url);
        else if (sameOrigin(en.url, origin) || !origin) note('failed ' + text.split('\n')[0] + ' ' + en.url, text.split('\n')[0] + '  ' + (en.url || ''));
        else setAside(text.split('\n')[0] + '  ' + en.url);
      } else note(en.source + ' ' + text.split('\n')[0], en.source + ': ' + text.split('\n')[0].slice(0, 200) + (en.url ? '  <- ' + en.url : ''));
    }
  };

  // Network first, so nothing the check provokes is missed while Log replays its backlog.
  await send('Network.enable');
  await send('Runtime.enable');
  await send('Log.enable');

  const list = () => [...found.values()];
  return {
    clean: () => found.size === 0,
    list,
    origin: () => origin,
    // what was seen off our own origin and deliberately not counted - printed so it is never silent
    aside: () => aside.slice(),
    why: () => (found.size ? found.size + ': ' + list().join(' | ') : 'clean')
      + (aside.length ? '   [off-origin, not counted: ' + aside.join(' ; ') + ']' : ''),
    // for a check that wants to name what it saw without failing on it
    report: (label) => { const l = list(); console.log('      ' + (label || 'page') + ': ' + (l.length ? l.join('\n        ') : 'no 4xx, no console error')); },
  };
}

// =================================================================================================
// CLOSING THE BROWSER - and the 43 GB that is the other thing a check could not see.
// =================================================================================================
// Every check in this folder makes a throwaway Chrome profile with `fs.mkdtempSync` and then closed the
// browser with `ch.kill()`, which removes nothing. Nothing else removed it either. The result was
// measured, not guessed: 1,617 orphaned profiles, 43 GB, a 460 GB disk at 100%, and the work stopped.
// One profile is 3-150 MB and there is one per run of one check.
//
// `ch.kill()` AND `rmSync` still is not enough on its own, and this is the part worth reading. SIGTERM
// is a request; a `--headless=new` Chrome does not always take it, and two were found still up, one for
// eleven hours. While a browser holds its files open, unlinking the directory removes the NAME and
// keeps the BLOCKS - so `rmSync` returns success, the directory is gone from `ls`, and the disk does
// not move. Trusting the return value is how this would be "fixed" and still leak.
//
// So the order is: ask it to go, WAIT until it has actually gone, insist if it has not, and only then
// remove the tree. The wait is capped, because a check must never hang in its own cleanup - and if the
// cap is reached the browser is reported, because `checkall.js` sweeps the prefixes at the end and that
// is the one that will catch it.
//
// It lives here because this is the file every check that drives a browser already requires, and the
// alternative was the same eight lines pasted twenty times - which is how the first version of the
// watcher above was nearly written, and why it is a module.
function stillUp(ch) {
  if (!ch) return false;
  if (ch.exitCode !== null || ch.signalCode !== null) return false;
  try { process.kill(ch.pid, 0); return true; } catch (_) { return false; }
}
// Chrome is not one process. A `--headless=new` browser has a GPU process, a renderer and two utility
// processes, and they are children of the one we spawned - so killing only the parent can leave a
// helper holding the profile open, and while ANY of them holds a file there the blocks are not
// released however cleanly `rmSync` returns. So the last step before removing is to look for anything
// still holding THIS profile and insist.
//
// Held to the profile path and nothing wider, for the same reason `checkall.js`'s stray-killer is:
// a blanket pattern over Chrome or over a debug port has already killed another agent's run on this
// machine and produced a silent empty pass. The profile path is unique to this check's own browser -
// `mkdtempSync` made it seconds ago - so this cannot reach anybody else's.
function holdersOf(prof) {
  if (!prof) return [];
  try {
    const out = require('child_process').execFileSync('/bin/sh',
      ['-c', "ps -ww -Ao pid=,args= 2>/dev/null || true"], { encoding: 'utf8' });
    return out.split('\n')
      .filter((l) => l.includes('--user-data-dir=' + prof))
      .map((l) => +l.trim().split(/\s+/)[0])
      .filter((p) => p && p !== process.pid);
  } catch (_) { return []; }
}
async function shutdown(ch, prof, capMs = 3000) {
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));
  try { if (ch) ch.kill(); } catch (_) {}
  const t0 = Date.now();
  while (stillUp(ch) && Date.now() - t0 < capMs) await nap(50);
  let insisted = false;
  if (stillUp(ch)) { insisted = true; try { ch.kill('SIGKILL'); } catch (_) {} for (let i = 0; i < 20 && stillUp(ch); i++) await nap(50); }
  // Anything left holding this profile - a helper that outlived its parent, or a browser that never
  // took SIGTERM. Two were found up on this machine today, one for eleven hours.
  let left = holdersOf(prof);
  if (left.length) {
    insisted = true;
    for (const pid of left) { try { process.kill(pid, 'SIGKILL'); } catch (_) {} }
    for (let i = 0; i < 20 && holdersOf(prof).length; i++) await nap(50);
    left = holdersOf(prof);
  }
  const held = stillUp(ch) || left.length > 0;
  // REMOVING IT IS NOT THE SAME AS IT BEING GONE. Removing a tree a browser is still writing into
  // throws ENOTEMPTY - the directory refills underneath the walk - and an orphan survives while the
  // call looks like it worked. So: retry, then ASK THE FILESYSTEM rather than trusting the return.
  let removed = false;
  if (prof) {
    for (let i = 0; i < 4 && !removed; i++) {
      try { fs.rmSync(prof, { recursive: true, force: true, maxRetries: 3 }); } catch (_) {}
      removed = !fs.existsSync(prof);
      if (!removed) await nap(150);
    }
  }
  // Said out loud only when something was wrong, so a clean run stays quiet.
  if (held) console.log('      (the browser would not close, so its profile may still hold its blocks; left for checkall.js to sweep: ' + prof + ')');
  else if (prof && !removed) console.log('      (the profile would not remove: ' + prof + ')');
  return { removed, insisted, held, prof };
}

// =================================================================================================
// THE HOLE `shutdown()` LEFT, AND THE RUN THAT REPORTED THE PREVIOUS PAGE AS ITS OWN
// =================================================================================================
// `shutdown(ch, prof)` is wired into every check that makes a profile. It is the LAST line of each of
// them - so a check that THROWS half way through never reaches it. Found the hard way, not reasoned:
// a probe threw before its close(), its Chrome kept the debug port, and the next two runs spawned a
// browser that could not bind and then talked to THE ORPHAN. The orphan's page already had the tower
// the earlier run had built, so the run reported '2 towers on load' and it read exactly like the file
// having changed underneath. Three orphans also survived a `terraincheck` run that died on a stale
// listener.
//
// Two things were missing, and they are different things:
//
//   1. THE BROWSER MUST BE CLOSED EVEN WHEN THE CHECK DIES. `guard(prof)` below does that.
//   2. A CHECK MUST REFUSE TO TALK TO A BROWSER IT DID NOT START. `claimPort(port)` does that. This one
//      matters more, because without it failure 1 is SILENT: every assertion still runs, against
//      somebody else's page, and the output is fiction rather than an error.
//
// WHY `guard` TAKES THE PROFILE AND NOT THE CHILD. `shutdown()` already finds stragglers by looking for
// `--user-data-dir=<prof>` in the process list, because Chrome is four processes and killing the parent
// can leave a helper holding the profile open. The profile path is therefore a better handle than the
// child object: it is unique (mkdtempSync made it seconds ago), it finds the helpers as well as the
// parent, and it needs only ONE line per check, placed on the line after the profile is made, which is
// a single line in every check here. A `try/finally` round each check's body would have been the other
// way and it covers less: not a throw before the `try`, not a SIGTERM from the runner's own
// stray-killer, and not `process.exit` on a path that forgot to close.
//
// EVERYTHING IN THE CRASH PATH IS SYNCHRONOUS, because `process.on('exit')` cannot await and a dying
// process will not run a timer. So the kill is SIGKILL rather than a polite SIGTERM and a wait: the
// process is going away regardless, and a Chrome asked politely has already been seen to ignore it.
function killHolders(prof) {
  const left = holdersOf(prof);
  for (const pid of left) { try { process.kill(pid, 'SIGKILL'); } catch (_) {} }
  return left.length;
}
function shutdownSync(prof) {
  if (!prof) return { killed: 0, removed: false, had: false };
  // `had` is whether there was anything to do at all. Without it the ordinary path - a check that
  // reached its own `shutdown()` and then exited - printed "this check exited without closing its
  // browser ... and removed it" on every clean run, about a profile that was already gone. A cleanup
  // line that appears when nothing was cleaned up is noise, and noise is what stops being read.
  const had = fs.existsSync(prof);
  const killed = killHolders(prof);
  if (!had && !killed) return { killed: 0, removed: false, had: false };
  // A SIGKILLed Chrome releases its files a moment later, and removing a tree it is still writing into
  // throws ENOTEMPTY - the directory refills underneath the walk. There is no awaiting here, so the wait
  // is /bin/sleep, and the filesystem is asked rather than `rmSync`'s return value trusted.
  for (let i = 0; i < 4; i++) {
    try { fs.rmSync(prof, { recursive: true, force: true, maxRetries: 3 }); } catch (_) {}
    if (!fs.existsSync(prof)) return { killed, removed: true, had };
    if (i < 3) { try { require('child_process').execFileSync('/bin/sleep', ['0.2']); } catch (_) {} killHolders(prof); }
  }
  return { killed, removed: !fs.existsSync(prof), had };
}
const guarded = new Set();
function guard(prof) {
  if (!prof || guarded.has(prof)) return () => {};
  guarded.add(prof);
  const clean = (why) => {
    if (!guarded.has(prof)) return;
    guarded.delete(prof);
    const r = shutdownSync(prof);
    if (r.had) console.log('      (' + why + ': killed ' + r.killed + ' process(es) holding ' + prof
      + ', and ' + (r.removed ? 'removed it)' : 'COULD NOT remove it)'));
  };
  // A throw or a rejected promise: say what it was - swallowing it would turn a crash into a silent
  // early exit, which is its own kind of fiction - then close the browser and exit non-zero.
  const onErr = (kind) => (e) => { console.error('\n' + kind + ': ' + ((e && e.stack) || e)); clean('the check died, so its browser was closed'); process.exit(1); };
  process.once('uncaughtException', onErr('uncaught exception'));
  process.once('unhandledRejection', onErr('unhandled rejection'));
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'])
    process.once(sig, () => { clean('killed by ' + sig + ', so its browser was closed'); process.exit(130); });
  // The ordinary path too: a check that reached its own `shutdown()` leaves nothing for this to find, and
  // one that called `process.exit` without closing is covered. Must not throw - nothing can catch it here.
  process.on('exit', () => { try { clean('this check exited without closing its browser'); } catch (_) {} });
  return () => guarded.delete(prof);
}

// WHO IS ON THIS PORT. `lsof` rather than a `fetch` of /json, because the question is "is anything
// listening" and not "is a browser answering": a Chrome that is starting up, or wedged, holds the port
// without answering, and the check would then bind nothing and attach to it a moment later anyway.
//
// FAIL-OPEN IF `lsof` IS NOT THERE, and said out loud when it happens: a machine without lsof should not
// have all its checks turn red, but it must not look as though the port was proved free either.
function portHolders(port) {
  try {
    const out = require('child_process').execFileSync('/bin/sh',
      ['-c', 'lsof -nP -iTCP:' + (+port) + ' -sTCP:LISTEN 2>/dev/null || true'], { encoding: 'utf8' }).trim();
    if (!out) return [];
    return out.split('\n').filter((l) => !/^COMMAND\s/.test(l)).map((l) => l.trim().split(/\s+/).slice(0, 2).join(' '));
  } catch (_) { console.log('      (lsof could not be run, so port ' + port + ' was not proved free)'); return []; }
}
function claimPort(port) {
  const held = portHolders(port);
  if (!held.length) return true;
  throw new Error('port ' + port + ' is already listening (' + held.join(', ') + ') - refusing to start, because a check that '
    + 'cannot bind its own debug port attaches to whatever IS there and reports that page\'s state as its own. '
    + 'Kill it, or run `node estate/checkall.js` which clears its own ports first.');
}

// WAIT FOR THE GAME, NOT FOR A STOPWATCH. Checks used to sleep 1.5-2.5 s after opening the base and then read
// `window.base`. Since merge round 3 the page loads more (the template header, session.js, the mini map, names) and
// it parses only after its stylesheets: under -j 4, or with the font CDN slow (as it was then), 2 s was not enough and a whole check
// went red on "base is not defined". This waits until the game is UP - window.base exists and its clock has moved -
// with a wall cap that only says the page never came up. `send` is the check's own CDP send(method, params).
async function waitForGame(send, capMs = 45000) {
  const t0 = Date.now();
  while (Date.now() - t0 < capMs) {
    try { const r = await send('Runtime.evaluate', { expression: '!!(window.base && base.simT > 0)', returnByValue: true });
      if (r && r.result && r.result.value === true) return { ok: true, ms: Date.now() - t0 }; } catch (_) { /* navigating */ }
    await new Promise((ok) => setTimeout(ok, 150));
  }
  console.log('      the base page never came up: window.base after ' + capMs + ' ms of wall clock is still missing');
  return { ok: false, ms: Date.now() - t0 };
}

// A FREE PORT, ASKED FOR AND NOT GUESSED. The proofs used to take `base + random` and start serve.py or Chrome on it
// without looking: duelproof (8920-9320), nameproof (8930-9330), attacknameproof (8940-9340) and playcheck (8931-8990)
// overlap, and under checkall -j 4 two of them run at once. A serve.py that cannot bind exits, the readiness poll is
// answered by the OTHER proof's server on that port, and a mutant "stays green" against code it never ran - a check
// passing or failing for a reason that is not its own. This picks a port nothing answers on and that binds, and never
// hands the same one out twice in one process.
const _handed = new Set();
function _answers(port) { return new Promise((res) => { const sk = require('net').connect({ port, host: '127.0.0.1' });
  sk.once('connect', () => { sk.destroy(); res(true); }); sk.once('error', () => res(false)); sk.setTimeout(400, () => { sk.destroy(); res(false); }); }); }
function _binds(port) { return new Promise((res) => { const sv = require('net').createServer(); sv.once('error', () => res(false));
  sv.listen(port, () => sv.close(() => res(true))); }); }
async function freePort(lo, span) {
  const start = Math.floor(Math.random() * span);
  for (let i = 0; i < span; i++) {
    const port = lo + ((start + i) % span);
    if (_handed.has(port)) continue;
    if (!(await _answers(port)) && (await _binds(port))) { _handed.add(port); return port; }
  }
  throw new Error('no free port in ' + lo + '..' + (lo + span - 1));
}

// WHERE THE SITE IS, AND WHICH PORTS ARE OURS - two lines every browser check reads instead of typing them.
//
// Every check used to carry `http://localhost:8765` and a fixed debug port. That made two things impossible, and
// both are the reason M22 item 2 could not be done before: (1) a check could not be pointed at a BROKEN COPY of the
// site, so nobody could show it going red when the page is wrong - `breakall.js` stages a mutated copy, serves it
// on a port of its own and sets RF_SITE; and (2) two runs on one machine (another agent's suite, a worktree's) fight
// over the same debug ports, and `checkall.js`'s stray-killer then kills the other run's browser. RF_PORT_OFFSET
// moves every fixed port a check uses by the same amount, so a second run never shares a port with the first.
// Unset, both are exactly what the checks always used: :8765, and the port written in the file.
// `checkall.js` reads the port numbers out of `debugPort(NNNN)` the way it read `PORT = NNNN`, so the stray-killer
// still finds them.
const SITE = String(process.env.RF_SITE || 'http://localhost:8765').replace(/\/+$/, '');
const debugPort = (n) => n + (+process.env.RF_PORT_OFFSET || 0);

module.exports = { attach, IGNORE, shutdown, stillUp, guard, shutdownSync, claimPort, portHolders, waitForGame, freePort, SITE, debugPort };
