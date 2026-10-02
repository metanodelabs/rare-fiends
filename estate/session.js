// WHO IS SIGNED IN, AND AS WHAT. The deployer's ruling of 2026-10-01: a visitor signs in with their wallet
// before DEMO or START GAME does anything; a whitelisted wallet plays, the deployer's wallet gets everything,
// and the build tools and the deployer page exist only for the deployer's wallet.
//
// THE SERVER DECIDES. This file only asks it and draws the answer. serve.py holds the session (an HttpOnly
// cookie set when a signature verifies), knows which addresses are whitelisted and which one is the
// deployer's, and refuses the gated pages itself. Nothing here can grant anything: a page that believed it
// was the deployer's would still be refused every build tool by the server.
//
// The interface this is coded against - the chain engineer's planned endpoints as relayed by the coordinator
// on 2026-10-01 (the server side is designed and NOT built yet). The two shapes marked ASSUMED are this file's
// reading, to be confirmed; if anything moves, it moves HERE and nowhere else:
//   GET  /api/auth/me                       -> 200 { address: "0x…" | null, role: "deployer" | "player" | "none" }
//                                              ASSUMED always 200, signed in or not, so an anonymous visitor's
//                                              page logs no error
//   GET  /api/auth/nonce?address=0x…&purpose=signin
//                                           -> 200 { message }   ASSUMED: the whole EIP-4361 text to sign, built
//                                              by the server (domain, uri, chain id, nonce, issued-at, expiry);
//                                              this file types no chain value and builds no message
//   POST /api/auth/verify { message, signature }
//                                           -> 200 { address, role } and Set-Cookie rf_session (HttpOnly,
//                                              SameSite=Strict, 4 h); 4xx { error } when it does not verify
//   POST /api/auth/logout                   -> { ok }: serve.py forgets the session and clears the cookie. SIGN OUT in
//                                              the header calls it, then goes to the landing page.
//
// ON A DEVELOPER'S OWN MACHINE (localhost) nothing is asked: every check runs there against a server with
// no sign-in, and a developer's machine is not the server. It counts as the deployer's, as start.html's
// rf-app switch already counts localhost as "on".
//
// Use:
//   await RFSession.me()        -> { address, role, local? }      cached; me(true) asks again
//   await RFSession.signIn()    -> { address, role }  the wallet's prompt, then its signature; throws with a
//                                  message a page can show
//   await RFSession.signOut()   -> asks the server to forget the session, then lands on the landing page
//   await RFSession.name()      -> the signed-in wallet's chosen name, or null (GET /api/name, estate/names.py); cached
//   await RFSession.setName(n)  -> sets it (POST /api/name { name }) and repaints the header; throws with the server's why
//   await RFSession.baseNames() -> { "<base id>": name }, every named base (GET /api/name/base); {} on a developer's machine
//   await RFSession.setBaseName(base, n) -> names a base whose Genesis this wallet holds (POST /api/name/base { base, name })
//   RFSession.nav()             -> wires <header class="top">: GAMES added to a player nav, PAGES on a phone, the current page marked, SIGN OUT
//                                  for a signed-in wallet,
//                                  the demo pace carried into the game, and the deployer's pages added for
//                                  the deployer's wallet only
(function () {
  'use strict';
  const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  const API = '/api/auth';
  let cached = null;

  const tidy = (j) => ({ address: (j && typeof j.address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(j.address)) ? j.address : null,
    role: j && (j.role === 'deployer' || j.role === 'player') ? j.role : 'none' });

  function me(fresh) {
    if (LOCAL) return Promise.resolve({ address: null, role: 'deployer', local: true });
    if (cached && !fresh) return cached;
    cached = fetch(API + '/me', { cache: 'no-store', credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : { role: 'none' }))
      .then(tidy)
      .catch(() => ({ address: null, role: 'none', unread: true }));
    return cached;
  }

  async function post(path, body) {
    const r = await fetch(API + path, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || ('the server said ' + r.status)), { status: r.status });
    return j;
  }

  // THE NAME A PLAYER CHOSE (M5 item 2). DESIGN, Who a player is: "their address is always visible with it" - so
  // wherever this file shows the name, the short address is beside it, and the whole address is its title.
  let named = null;
  function name(fresh) {
    if (LOCAL) return Promise.resolve(null);              // a developer's machine has no session, so no name
    if (named && !fresh) return named;
    named = fetch('/api/name', { cache: 'no-store', credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => (j && j.ok && typeof j.name === 'string' && j.name ? j.name : null))
      .catch(() => null);
    return named;
  }
  async function setName(n) {
    const r = await fetch('/api/name', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: n }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw Object.assign(new Error(j.why || ('the server said ' + r.status)), { status: r.status, reason: j.reason });
    named = Promise.resolve(j.name);
    paintWho();
    return j.name;
  }
  // A HOME BASE NAME (the deployer, 2026-10-01): the name of a base, set by whoever holds the Genesis that owns it
  // (names.py). baseNames() -> { "<base id>": name }; setBaseName(base, n) throws with the server's why.
  function baseNames() {
    if (LOCAL) return Promise.resolve({});
    return fetch('/api/name/base', { cache: 'no-store', credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null)).then((j) => (j && j.ok && j.bases) || {}).catch(() => ({}));
  }
  async function setBaseName(base, n) {
    const r = await fetch('/api/name/base', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base, name: n }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw Object.assign(new Error(j.why || j.error || ('the server said ' + r.status)), { status: r.status, reason: j.reason });
    return j.name;
  }
  const shortAddr = (a) => a.slice(0, 6) + '…' + a.slice(-4);
  // the header's label: the name (when one is chosen) and the short address, both, always
  function paintWho() {
    const who = document.getElementById('signedAs');
    if (!who) return;
    const address = who.dataset.address;
    name().then((n) => {
      who.textContent = '';
      who.title = (n ? n + ' · ' : '') + address;
      if (n) { const b = document.createElement('b'); b.className = 'nm'; b.textContent = n; who.appendChild(b); }
      const s = document.createElement('span'); s.className = 'sa'; s.textContent = shortAddr(address); who.appendChild(s);
    });
  }

  async function signIn() {
    if (LOCAL) return me();
    if (!window.RFWallet) throw new Error('wallet.js is not on this page');
    // wallet.js picks the wallet (EIP-6963: Phantom, MetaMask, whichever the player chose) and throws NO_WALLET itself
    const address = await RFWallet.connect();                       // the wallet's own prompt
    const n = await fetch(API + '/nonce?address=' + encodeURIComponent(address) + '&purpose=signin', { cache: 'no-store', credentials: 'same-origin' });
    const { message } = await n.json().catch(() => ({}));
    if (!n.ok) throw Object.assign(new Error('the server would not issue a message to sign (' + n.status + ')'), { status: n.status });
    if (typeof message !== 'string' || !message) throw new Error('the server sent nothing to sign');
    // No chain switch: the signature is checked by serve.py, which reads chain 4663 itself, so the wallet may sit on any
    // chain - Phantom's EVM side may not know Robinhood Chain at all.
    const signature = await RFWallet.sign(message, address);       // the SAME wallet that gave the address
    const who = tidy(await post('/verify', { message, signature }));
    cached = Promise.resolve(who);
    return who;
  }

  // THE PAGE HEADER. The five a player sees are written in each page's HTML, so they work without this file;
  // what this adds is behaviour, and the deployer's own pages for the deployer's wallet.
  // The deployer's: the deployer page and the build tools. STUDIO and ARMOURY are panels of the game page, so they
  // open in studio.html - the deployer's own copy of the game with the tools switched on, which serve.py gives
  // to the deployer's wallet alone; on a developer's machine the base itself has them.
  const DEV_BASE = LOCAL ? 'base.html' : 'studio.html';
  const DEV_PAGES = [['deployer.html', 'DEPLOYER'], [DEV_BASE + '?studio=1', 'STUDIO'], [DEV_BASE + '?armoury=1', 'ARMOURY'],
    ['challenge.html', 'CHALLENGE'], ['economy.html', 'ECONOMY'], ['mapgen.html', 'MAP'], ['attack_defense.html', 'ATTACK & DEFENSE']];
  function nav() {
    const head = document.querySelector('header.top'), list = head && head.querySelector('nav');
    if (!list) return;
    const here = location.pathname.split('/').pop() || 'index.html', q = new URLSearchParams(location.search);
    // GAMES (M18: opening a game, joining one, the pot). games.html writes it in its own header; every other PLAYER
    // nav (one that links MY PROFILE) gets it here, after STANDINGS, so the player's pages that other hands own
    // (the base, MY PROFILE, STANDINGS) carry it without each header being edited. On the base it is tagged
    // data-page="games.html", the entry navcheck asks the base for.
    if (list.querySelector('a[href^="player.html"]') && !list.querySelector('a[href^="games.html"]')) {
      const g = document.createElement('a'); g.href = 'games.html'; g.id = 'gamesBtn'; g.dataset.page = 'games.html'; g.textContent = 'GAMES';
      const after = list.querySelector('a[href^="standings.html"]');
      if (after) after.after(g); else list.insertBefore(g, list.querySelector('[data-wallet], .sep, .dev'));
    }
    // the demo pace a visitor came in with (DEMO on the landing page) follows them into the game
    const carry = new URLSearchParams();
    ['pace', 'demo'].forEach((k) => { if (q.get(k)) carry.set(k, q.get(k)); });
    list.querySelectorAll('a[href]').forEach((a) => {
      const u = new URL(a.getAttribute('href'), location.href), file = u.pathname.split('/').pop();
      if (file === here && !u.searchParams.has('open')) a.setAttribute('aria-current', 'page');
      carry.forEach((v, k) => u.searchParams.set(k, v));
      a.setAttribute('href', file + u.search);
    });
    const btn = head.querySelector('.pagesbtn');
    if (btn) {
      btn.addEventListener('click', (e) => { e.stopPropagation(); const open = head.classList.toggle('open'); btn.setAttribute('aria-expanded', String(open)); });
      document.addEventListener('pointerdown', (e) => { if (head.classList.contains('open') && !head.contains(e.target)) { head.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); } }, true);
    }
    // The game page in dev mode (a developer's machine, studio.html) carries its build tools in its own nav, as
    // in-page buttons (STUDIO and ARMOURY open panels of that page, not other pages); adding these too would list
    // every one of them twice.
    const ownTools = document.documentElement.dataset.mode === 'dev' && list.querySelector('[data-dev]');
    me().then((m) => {
      if (m.role === 'deployer' && !ownTools) {
        const sep = document.createElement('span'); sep.className = 'sep'; sep.setAttribute('aria-hidden', 'true'); list.appendChild(sep);
        DEV_PAGES.forEach(([href, label]) => { const a = document.createElement('a'); a.href = href; a.textContent = label; a.className = 'dev';
          if (href === here) a.setAttribute('aria-current', 'page'); list.appendChild(a); });
      }
      // SIGN OUT, last, for a wallet the server has signed in. A developer's machine has no session, so no button.
      // and the wallet that signed in, short, in place of the header's CONNECT WALLET: there is nothing to connect
      if (m.address && !m.local) {
        head.querySelectorAll('[data-wallet]').forEach((w) => { w.hidden = true; });
        const who = document.createElement('span'); who.className = 'who'; who.id = 'signedAs'; who.title = m.address; who.dataset.address = m.address;
        who.textContent = shortAddr(m.address); list.appendChild(who);
        paintWho();                                     // and the chosen name beside it, once the server has said it
        const b = document.createElement('button'); b.type = 'button'; b.className = 'signout'; b.id = 'signOutBtn'; b.textContent = 'SIGN OUT';
        b.addEventListener('click', () => { b.disabled = true; b.textContent = 'SIGNING OUT'; signOut(); });
        list.appendChild(b);
      }
    });
  }

  // The server forgets the session and clears its cookie; then the landing page, where a visitor signs in again.
  // A failed request is not a sign-out: the button says so and stays, rather than pretend.
  async function signOut() {
    try {
      const r = await fetch(API + '/logout', { method: 'POST', credentials: 'same-origin', cache: 'no-store' });
      if (!r.ok) throw new Error('the server said ' + r.status);
      cached = null;
      location.replace('/');
    } catch (e) {
      const b = document.getElementById('signOutBtn');
      if (b) { b.disabled = false; b.textContent = 'SIGN OUT FAILED'; b.title = String(e && e.message || e); }
    }
  }

  window.RFSession = { me, signIn, signOut, nav, name, setName, baseNames, setBaseName, local: LOCAL };
})();
