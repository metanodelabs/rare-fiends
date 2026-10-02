// announce.js - THE EVENT OVERLAY. The deployer's ruling of 2026-10-01:
//   "the front end ought to have an area where announcements can arrive as they happen. Users can choose
//    to turn them off, but it should always be visible. Probably best as an event overlay: a small overlay
//    that is semi-transparent, which posts events or updates as they happen. If people wish to see them
//    they can minimise or leave them open. That overlay should be optimised for mobile and desktop."
//
// One small module and its own styles (there is no stylesheet in this estate to put them in). It knows
// nothing about the game except the shapes the named hooks below are handed; the game ADDS one line where
// a thing happens and changes nothing else.
//
//   Announce.post({ kind, text, at })   kind: a short tag ('capture', 'fight', ...); text: the line;
//                                       at: ms since the epoch, default now. Returns the item, or null.
//   Announce.on.<event>(...)            the named hooks - see EVENTS at the bottom, and which are wired.
//   Announce.set({ min, off })          minimise / turn off, remembered in localStorage (try/catch: a
//                                       private window or blocked storage just forgets, it never throws)
//   Announce.state()                    { min, off, unread, count }   - for a check
//   Announce.place()                    re-seat it; it does this itself on resize
//
// THREE STATES, AND THE OVERLAY IS ON SCREEN IN ALL THREE ("it should always be visible"):
//   open       - a small semi-transparent card: the newest events, newest first.
//   minimised  - a pill: EVENTS and how many arrived since it was minimised.
//   off        - events are still kept, but none is shown or counted; the pill reads EVENTS OFF, and the
//                card (if open) says it is off. Turning it on shows what was kept.
//
// WHERE IT SITS (the template, 2026-10-01) - never over the resources card, the foot or the build panel:
//   - a solid card in the map's TOP RIGHT (the resources card holds the top left), UNDER THE MINI MAP (minimap.js,
//     2026-10-01: the mini map holds the corner), stopping above the foot (#dock: the selected Friend's card and the roster);
//   - ON A PHONE (720px and under) it is CLOSED by default: a pill of a dot and a count in the same corner. Opened,
//     it is a sheet across the foot of the window, closed again by its minimise button. A choice the player has
//     made (open or minimised) is remembered and wins.
//   - Its z-index (7) is above the map, the resources card (5) and the foot (6), and below every modal: the market
//     (8), the reel frame (9), the build panel (25, and 40 as the phone's sheet) and the challenge (60). Its own
//     phone sheet is 41, over the foot it opens across. A modal covers it; it never covers a modal.
(function (root) {
  'use strict';
  if (root.Announce) return;
  const doc = root.document;
  const KEY = { min: 'rf.announce.min', off: 'rf.announce.off' };
  const KEEP = 40;                                   // how many it remembers; the card scrolls inside itself
  const store = {
    get(k) { try { return root.localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { root.localStorage.setItem(k, v); } catch (_) { /* forgotten, never thrown */ } },
  };
  const PHONE = () => !!(root.matchMedia && root.matchMedia('(max-width: 720px)').matches);
  const minSaved = store.get(KEY.min);
  const S = { min: minSaved === '1' || (minSaved == null && PHONE()), off: store.get(KEY.off) === '1', unread: 0, items: [] };

  // The template's card (page.css's tokens; the fallbacks are only for a page without page.css): solid paper, a faint
  // border, square, no blur, no shadow. Silkscreen for the labels, Sometype Mono for the lines themselves.
  const CSS = `
.announce { position: fixed; z-index: 7; right: 12px; top: 12px; width: 300px; max-width: calc(100vw - 16px);
  display: flex; flex-direction: column; font-family: var(--mono, ui-monospace, monospace); color: var(--ink, #fff);
  background: var(--paper, #000); border: 1px solid var(--faint, rgba(255,255,255,.28)); pointer-events: auto; user-select: none; }
.announce.min { width: auto; }
body.hero .announce { display: none !important; }   /* the landing page's reel is a picture of the game, not the game */
.announce .ahead { display: flex; align-items: center; gap: 6px; padding: 3px 4px 3px 10px; }
.announce:not(.min) .ahead { border-bottom: 1px solid var(--rule, rgba(255,255,255,.12)); }
.announce .atitle { font-family: var(--display, monospace); font-size: 12px; letter-spacing: .1em; color: var(--ink, #fff);
  display: inline-flex; align-items: center; gap: 8px; background: none; border: 0; padding: 4px 0; cursor: pointer; white-space: nowrap; }
.announce .adot { width: 7px; height: 7px; border-radius: 50%; background: var(--signal, #CCFF00); flex: none; }
.announce.off .adot { background: var(--faint, rgba(255,255,255,.28)); }
.announce.off .atitle { color: var(--dim, rgba(255,255,255,.62)); }
.announce .acount { font-family: var(--display, monospace); font-weight: 400; font-size: 12px; color: var(--paper, #000); background: var(--signal, #CCFF00); padding: 1px 5px; letter-spacing: 0; }
.announce .asp { flex: 1; }
.announce .abtn { font-family: var(--display, monospace); font-size: 12px; letter-spacing: .08em; color: var(--ink, #fff);
  background: none; border: 1px solid var(--faint, rgba(255,255,255,.28)); padding: 4px 7px; min-height: 26px; cursor: pointer; }
.announce .abtn[aria-pressed="true"] { background: var(--signal, #CCFF00); color: var(--paper, #000); border-color: var(--signal, #CCFF00); }
.announce .alist { list-style: none; margin: 0; padding: 4px 10px 8px; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; }
.announce .alist li { display: grid; grid-template-columns: 74px 1fr; gap: 0 7px; padding: 4px 0; border-top: 1px solid var(--rule, rgba(255,255,255,.12));
  font-size: 13px; line-height: 1.35; color: var(--dim, rgba(255,255,255,.62)); }
.announce .alist li:first-child { border-top: 0; }
.announce .alist li.fresh { animation: announceIn .9s ease-out; }
@keyframes announceIn { from { color: var(--signal, #CCFF00); } to { color: var(--dim, rgba(255,255,255,.62)); } }
.announce .akind { font-family: var(--display, monospace); font-size: 11px; letter-spacing: .08em; color: var(--signal, #CCFF00); }
.announce .aat { grid-column: 1; font-size: 11px; color: var(--dim, rgba(255,255,255,.62)); }
.announce .atext { grid-column: 2; grid-row: 1 / span 2; overflow-wrap: anywhere; color: var(--ink, #fff); }
.announce .aempty { margin: 0; padding: 6px 10px 8px; font-size: 13px; color: var(--dim, rgba(255,255,255,.62)); }
.announce.min .alist, .announce.min .aempty, .announce.min .aon, .announce.min .amin { display: none; }
/* A PHONE: closed, a pill of a dot and a count in the map's top right; open, a sheet across the foot of the window */
@media (max-width: 720px) {
  .announce .atitle { min-height: 40px; padding: 0 4px; }
  .announce .abtn { min-height: 40px; min-width: 40px; }
  .announce.min .aname { display: none; }
  .announce.min .ahead { padding: 0 6px; }
  .announce.sheet { left: 0 !important; right: 0 !important; top: auto !important; bottom: 0 !important; width: auto !important; max-width: none !important;
    max-height: 55dvh !important; border-left: 0; border-right: 0; border-bottom: 0; border-top: 1px solid var(--line, rgba(204,255,0,.4));
    z-index: 41; padding-bottom: env(safe-area-inset-bottom, 0px); }
}
`;

  let el, list, title, count, onBtn, minBtn, empty;
  const hhmm = (t) => { const d = new Date(t); return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':'); };
  const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function build() {
    const st = doc.createElement('style'); st.id = 'announce-css'; st.textContent = CSS; doc.head.appendChild(st);
    el = doc.createElement('section'); el.className = 'announce'; el.id = 'announce';
    el.setAttribute('aria-label', 'Events'); el.setAttribute('aria-live', 'polite');
    el.innerHTML = '<div class="ahead"><button class="atitle" type="button" aria-expanded="true"><i class="adot"></i><span class="aname">EVENTS</span><b class="acount" hidden></b></button>'
      + '<span class="asp"></span><button class="abtn aon" type="button" aria-pressed="true" title="Turn announcements on or off">ON</button>'
      + '<button class="abtn amin" type="button" title="Minimise">&#8211;</button></div>'
      + '<p class="aempty"></p><ol class="alist"></ol>';
    title = el.querySelector('.atitle'); count = el.querySelector('.acount'); onBtn = el.querySelector('.aon');
    minBtn = el.querySelector('.amin'); list = el.querySelector('.alist'); empty = el.querySelector('.aempty');
    // The pill's own label opens it; when open, the same label minimises it - one target either way.
    title.addEventListener('click', () => set({ min: !S.min }));
    minBtn.addEventListener('click', () => set({ min: true }));
    onBtn.addEventListener('click', () => set({ off: !S.off }));
    // a tap on the overlay is the overlay's - it must never fall through to the map underneath
    ['pointerdown', 'pointerup', 'click', 'touchstart'].forEach(t => el.addEventListener(t, e => e.stopPropagation()));
    doc.body.appendChild(el);
    render(); place();
    root.addEventListener('resize', schedule);
    root.addEventListener('orientationchange', schedule);
    if (root.ResizeObserver) { const ro = new ResizeObserver(schedule); ['frame'].forEach(id => { const n = doc.getElementById(id); if (n) ro.observe(n); });
      const hud = doc.querySelector('.hud'); if (hud) ro.observe(hud); }
  }

  let queued = 0;
  function schedule() { if (!queued) queued = root.requestAnimationFrame(() => { queued = 0; place(); }); }

  // Seat it. Measured, not assumed: the HUD wraps differently at every width and carries a wallet button
  // whose label changes, so the line it must stay under is read off the HUD each time.
  function place() {
    if (!el) return;
    const vw = root.innerWidth, vh = root.innerHeight, frame = doc.getElementById('frame');
    const s = el.style;
    const sheet = PHONE() && !S.min;
    el.classList.toggle('sheet', sheet);
    if (sheet) return;                               // a phone's open card is a sheet; the stylesheet seats it
    const f = frame ? frame.getBoundingClientRect() : null;
    if (!f || f.width < 2) { s.right = '8px'; s.left = 'auto'; s.top = '8px'; s.maxHeight = Math.max(80, vh * 0.4) + 'px'; s.width = Math.min(300, vw - 16) + 'px'; return; }
    // the map's top right, under the reel's top bar when the studio films; it stops above the foot (#dock)
    const r = (sel) => { const n = doc.querySelector(sel); if (!n) return null; const b = n.getBoundingClientRect(); return b.height > 0 ? b : null; };
    const rtop = r('#reelframe:not([hidden]) .rtop'), dock = r('#dock');
    const gap = PHONE() ? 8 : 12;
    // the mini map (minimap.js) holds the corner on anything wider than a phone: EVENTS sits under it. On a phone the
    // pill keeps the corner and the mini map's MAP and HOME sit under the pill (minimap.js reads this element).
    const mm = PHONE() ? null : r('#minimap:not([hidden])');
    const top = Math.max(f.top + gap, rtop ? rtop.bottom + 4 : 0, mm ? mm.bottom + 8 : 0);
    const width = Math.max(160, Math.min(300, f.width - 2 * gap));
    const floor = Math.min(f.bottom - gap, dock ? dock.top - gap : Infinity);
    const maxH = Math.max(40, Math.min(f.height * 0.5, floor - top));
    s.top = Math.round(top) + 'px'; s.left = 'auto'; s.right = Math.round(Math.max(gap, vw - f.right + gap)) + 'px';
    s.width = S.min ? 'auto' : Math.round(width) + 'px'; s.maxWidth = Math.round(width) + 'px'; s.maxHeight = Math.round(maxH) + 'px';
  }

  function row(it, fresh) {
    const li = doc.createElement('li'); if (fresh) li.className = 'fresh';
    li.innerHTML = '<span class="akind">' + esc(it.kind.toUpperCase()) + '</span><span class="atext">' + esc(it.text) + '</span><span class="aat">' + hhmm(it.at) + '</span>';
    return li;
  }
  function render() {
    if (!el) return;
    el.classList.toggle('min', S.min); el.classList.toggle('off', S.off);
    title.setAttribute('aria-expanded', String(!S.min));
    title.querySelector('.aname').textContent = S.off ? 'EVENTS OFF' : 'EVENTS';
    count.hidden = !(S.min && !S.off); count.textContent = String(S.unread);   // closed: a dot and a count, 0 included
    onBtn.setAttribute('aria-pressed', String(!S.off)); onBtn.textContent = S.off ? 'OFF' : 'ON';
    minBtn.setAttribute('aria-label', 'Minimise');
    list.hidden = S.off;
    empty.hidden = !(S.off || !S.items.length);
    empty.textContent = S.off ? 'Off. Events are kept, not shown. Tap ON to see them.' : 'Nothing yet. Events arrive here as they happen.';
    list.innerHTML = ''; S.items.forEach(it => list.appendChild(row(it, false)));
    place();
  }

  function set(o) {
    if ('min' in o) { S.min = !!o.min; store.set(KEY.min, S.min ? '1' : '0'); if (!S.min) S.unread = 0; }
    if ('off' in o) { S.off = !!o.off; store.set(KEY.off, S.off ? '1' : '0'); S.unread = 0; }
    render(); return state();
  }
  const state = () => ({ min: S.min, off: S.off, unread: S.unread, count: S.items.length, shown: !!el && el.isConnected });

  // post never throws: it is called from inside the game, and an announcement must never break the thing
  // it announces.
  function post(o) {
    try {
      if (!o || o.text == null || String(o.text).trim() === '') return null;
      const it = { kind: String(o.kind || 'news').slice(0, 16), text: String(o.text).slice(0, 240), at: Number.isFinite(o.at) ? o.at : Date.now() };
      S.items.unshift(it); if (S.items.length > KEEP) S.items.length = KEEP;
      if (!el) return it;
      if (S.off) { render(); return it; }            // kept, not shown, not counted
      if (S.min) { S.unread++; render(); return it; }
      list.insertBefore(row(it, true), list.firstChild);
      while (list.children.length > KEEP) list.lastChild.remove();
      empty.hidden = true; list.scrollTop = 0;
      return it;
    } catch (_) { return null; }
  }

  // ---------- EVENTS: the named hooks ----------
  // A hook takes the game's own object and writes the line, so the game's side is one line and changes
  // nothing. Every hook is wrapped: a shape it does not expect posts nothing rather than throwing.
  const safe = (f) => function () { try { return f.apply(null, arguments); } catch (_) { return null; } };
  const kindName = (t) => String(t || 'building').replace(/([a-z])([A-Z])/g, '$1 $2').toUpperCase();
  const whose = (id) => (root.base && root.base.HOME === id) ? 'your' : 'base ' + id + "'s";
  const mins = (ms) => { const m = Math.round(ms / 60000); return m + (m === 1 ? ' minute' : ' minutes'); };
  const on = {
    // WIRED - index.html's capture window (Capture ownership; M14 item 2).
    captured: safe((w) => post({ kind: 'capture', text: (w.intruder.name || 'A Friend') + ' captured ' + whose(w.owner) + ' ' + kindName(w.building.type) + '. ' + mins(w.closes - w.opened) + ' to act on it.' })),
    returned: safe((w, how) => post({ kind: 'returned', text: kindName(w.building.type) + ' is ' + whose(w.owner).replace(/^your$/, 'yours') + ' again: ' + (how === 'beaten' ? 'the intruder was beaten.' : how === 'ran' ? 'the intruder ran.' : 'the window closed.') })),
    fightStarted: safe((w) => post({ kind: 'fight', text: ((root.base && root.base.HOME === w.owner) ? 'Your base' : 'Base ' + w.owner) + ' fights ' + (w.intruder.name || 'the intruder') + ' for its ' + kindName(w.building.type) + '.' })),
    fightEnded: safe((w, r) => post({ kind: 'fight', text: 'Fight for the ' + kindName(w.building.type) + ' over: ' + (r.beaten ? 'the intruder is beaten.' : r.fled ? 'the intruder ran.' : r.won ? 'the intruder won.' : 'no winner.') })),
    // the intruder won the takeover (no defender standing, nobody home, or a stalemate): the claim stands
    won: safe((w) => post({ kind: 'captured', text: (w.intruder.name || 'The intruder') + ' won ' + whose(w.owner) + ' ' + kindName(w.building.type) + ': the claim stands for ' + mins(Math.max(0, w.closes - (w.wonAt != null ? w.wonAt : w.opened))) + '.' })),
    // NOT WIRED - no code exists yet for these. They are named here so the code that makes them happen
    // adds one line, and so nobody announces an event the game does not have.
    //   captureExpired: the five-minute window running out (ownership reverts, the taker takes a hit).
    //   ordersRevealed: sealed standing orders revealed at a fight - "orders are announced when revealed".
    //   trapSprung: a hidden 1/1 Doopie engaging whoever crossed it - rulings 34, 51, 55.
    //   memeAttack: a meme attack card spent. The armoury's throw is a rehearsal stage, not a game event,
    //               so it is deliberately not announced.
    captureExpired: safe((w) => on.returned(w, 'expired')),
    // WIRED - every attack on this server, from minimap.js's fight poll ('rf:fights', below). The deployer, 2026-10-01:
    // "yes show attacks but not their location .. just the player names that are set in the profile between fighters".
    // So a line names the two PLAYERS (by, on: names, or a short address for a player with none) and NOTHING ELSE:
    // no base, no Genesis, no plot, no side, no count - nothing that says where.
    attackStarted: safe((a) => post({ kind: 'attack', text: a.by + ' attacked ' + a.on })),
    attackEnded: safe((a) => post({ kind: 'attack', text: a.won ? a.by + ' broke through' : a.on + ' held' })),
    ordersRevealed: safe((o) => post({ kind: 'orders', text: 'Base ' + o.base + "'s standing orders revealed" + (o.orders && o.orders.length ? ': ' + o.orders.map(x => String(x).toUpperCase()).join(', ') : '') + '.' })),
    trapSprung: safe((t) => post({ kind: 'trap', text: 'A hidden Doopie sprang from a ' + (t.disguise || 'disguise') + (t.victim ? ' on ' + t.victim : '') + (t.outcome ? ': ' + t.outcome : '') + '.' })),
    memeAttack: safe((m) => post({ kind: 'meme', text: (m.by || 'Someone') + ' threw ' + (m.name || 'a meme attack') + (m.target ? ' at ' + m.target : '') + (m.outcome ? ': ' + m.outcome : '') + '.' })),
  };
  const WIRED = ['captured', 'won', 'returned', 'fightStarted', 'fightEnded', 'attackStarted', 'attackEnded'];

  // ATTACKS, fed by the one fight poll there is (minimap.js): each fight our server settled since this page opened,
  // with the heads polled beside it. A fight settles on our server the moment it is ordered (serve.py fight_post), so
  // its attack line and its outcome arrive together, in that order. A player is their profile name (names.py, on the
  // heads as ownerName), else their short address; a base with no owner at all (a developer's own unsigned machine)
  // is "a player". The base ids the fight carries are used to find the owner and are never written into the line.
  const shortAddr = (a) => (typeof a === 'string' && /^0x[0-9a-f]{40}$/i.test(a) ? a.slice(0, 6) + '…' + a.slice(-4) : null);
  const playerOf = (heads, id) => { const h = (heads || []).find(x => x && x.id === id) || {};
    return (typeof h.ownerName === 'string' && h.ownerName) || shortAddr(h.owner) || 'a player'; };
  root.addEventListener('rf:fights', (e) => {
    try {
      const d = (e && e.detail) || {};
      (d.fights || []).forEach((f) => {
        const att = playerOf(d.heads, f.attacker), def = playerOf(d.heads, f.defender);
        on.attackStarted({ by: att, on: def });
        on.attackEnded({ by: att, on: def, won: !!f.won });
      });
    } catch (_) { /* an announcement never breaks the page that hears it */ }
  });

  root.Announce = { post, on, set, state, place, WIRED, get el() { return el; }, get items() { return S.items.slice(); } };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', build); else build();
})(window);
