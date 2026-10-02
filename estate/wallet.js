// The one wallet connection. M5 item 1.
//
// A player IS an address (schema.json, entity `player`: "There is no id and no registration"; a
// chosen name sits beside the address and never replaces it). This file is the only place a page asks the browser's EVM wallet for it - the
// whitelist card on start.html and the sign-in in session.js both come through here.
// bridge.html and deployer.html each carry their own older copy of the same request
// (bridge.html's eth_requestAccounts, deployer.html's eth()); they are left as they are and are
// candidates to move onto this file, not rewritten here.
//
// WHICH WALLET (the deployer, testing Server 1, 2026-10-01: "why won't it let me choose phantom.. it
// forces metamask"). `window.ethereum` is ONE object and whichever extension loads last claims it -
// usually MetaMask - so a page that only reads it can never reach Phantom. Wallets now announce
// themselves instead (EIP-6963, multi-injected provider discovery): this file dispatches
// `eip6963:requestProvider`, listens for every `eip6963:announceProvider`, and:
//   - one wallet announced: that one, no question asked;
//   - several: a small picker with each wallet's own name and icon, the first time; the choice is
//     remembered (localStorage key rf-wallet-pick, the wallet's rdns - never an address) and
//     RFWallet.change() asks again;
//   - none announced: `window.ethereum`, exactly as before (older wallets, in-app wallet browsers).
// Until a wallet is chosen nothing is sent to any of them - not even the quiet eth_accounts.
//
// What it does NOT do, on purpose:
//   - It never switches or adds a chain on its own. toChain() does, for the one page that asks
//     (the whitelist card), and it never throws and never blocks: signing a sign-in message needs no
//     chain - serve.py checks the signature and reads chain 4663 itself (whitelist-proof.js verify()
//     checks the "Chain ID:" line of the message the server wrote, never the wallet's chain) - and
//     Phantom's EVM side may not know Robinhood Chain at all.
//   - It stores no address. Whether a page is still connected is asked of the wallet (eth_accounts,
//     which answers without a prompt once this site has been allowed).
//   - It holds no name. A player's chosen name (schema `player.name`, home: server) is M5 item 2:
//     estate/names.py keeps it, session.js shows it in the header beside the address.
//
// Use:
//   RFWallet.available()           -> is there a wallet in this browser
//   await RFWallet.connect()       -> the address, after the wallet's own prompt (throws if refused;
//                                     code NO_WALLET, NO_PICK when the picker was closed, or the wallet's)
//   await RFWallet.sign(msg, addr) -> personal_sign of msg (UTF-8, sent as hex) by the chosen wallet
//   await RFWallet.toChain(chain)  -> { ok, why? } for { id, name, rpc } from the server; never throws
//   await RFWallet.change()        -> the picker again; resolves the chosen wallet's name
//   RFWallet.wallets()             -> [{ id, name, icon }] every wallet announced so far
//   RFWallet.chosen()              -> the name of the wallet in use, or ''
//   RFWallet.onWallets(fn)         -> fn() whenever a wallet is announced or chosen
//   await RFWallet.current()       -> the address if this site is already allowed, else ''
//   RFWallet.onChange(fn)          -> fn(address or '') whenever it changes
//   RFWallet.short(a)              -> 0x1234…abcd
//   await RFWallet.ask(method, ps) -> any read asked of the chosen wallet's own chain (eth_chainId, eth_getCode ...)
//   await RFWallet.send(tx)        -> eth_sendTransaction of { to, data, value? } from the connected address; the hash.
//                                     The wallet estimates the gas and shows its own prompt; nothing is signed here
//   <button data-wallet>           -> wired automatically: CONNECT WALLET, then the short address
(function () {
  if (window.RFWallet) return;                        // loaded twice (start.html fetches it on demand)
  const KEY = 'rf-wallet-pick';
  const short = (a) => a ? a.slice(0, 6) + '…' + a.slice(-4) : '';
  const isAddr = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
  const legacy = () => (window.ethereum && typeof window.ethereum.request === 'function') ? window.ethereum : null;
  const err = (message, code) => Object.assign(new Error(message), { code });
  const recall = () => { try { return localStorage.getItem(KEY) || ''; } catch (_) { return ''; } };
  const keep = (id) => { try { id ? localStorage.setItem(KEY, id) : localStorage.removeItem(KEY); } catch (_) {} };
  let addr = '';
  let active = null;                                  // the provider in use, once there is one
  const subs = [], wsubs = [];
  const found = [];                                   // [{ id, uuid, name, icon, provider }] in announcement order
  const heard = new WeakSet();                        // providers whose accountsChanged is already followed (declared
                                                      // up here: a wallet can announce during discover(), below)

  function set(a) {
    const next = isAddr(a) ? a : '';
    if (next === addr) return;
    addr = next;
    subs.forEach((fn) => { try { fn(addr); } catch (e) { console.warn('wallet listener', e); } });
  }
  const tellWallets = () => wsubs.forEach((fn) => { try { fn(); } catch (e) { console.warn('wallet listener', e); } });

  // ---------------------------------------------------------------- EIP-6963: every wallet says who it is
  window.addEventListener('eip6963:announceProvider', (e) => {
    const d = e && e.detail, info = d && d.info, p = d && d.provider;
    if (!info || !p || typeof p.request !== 'function') return;
    const w = { uuid: String(info.uuid || ''), name: String(info.name || 'Wallet').slice(0, 40),
      icon: typeof info.icon === 'string' && /^data:image\//.test(info.icon) ? info.icon : '', provider: p };
    w.id = String(info.rdns || info.name || info.uuid);
    const i = found.findIndex((x) => (w.uuid && x.uuid === w.uuid) || x.id === w.id);
    if (i >= 0) found[i] = w; else found.push(w);
    tellWallets();
    // a wallet that turned up after boot: settle once the burst is over. NOT inside this handler - wallets announce one
    // at a time, so while the first is being handled it looks like "the only one" and would be asked eth_accounts.
    clearTimeout(lateT);
    lateT = setTimeout(() => { if (active) return; const q = settled(); if (q) { listen(q); current(); } }, 0);
  });
  let lateT = 0;
  const discover = () => { try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch (_) {} };
  discover();

  // the wallet to use WITHOUT asking anything: the one in use, the remembered one, the only one, or the
  // old window.ethereum when nothing announced itself. Several and none chosen: null - nobody is asked.
  function settled() {
    if (active) return active;
    if (found.length) {
      const id = recall(), r = found.find((w) => w.id === id);
      if (r) return r.provider;
      return found.length === 1 ? found[0].provider : null;
    }
    return legacy();
  }
  const entry = (p) => found.find((w) => w.provider === p) || null;

  let waited = false;
  async function choose(force) {
    if (!found.length && !waited) { waited = true; discover(); await new Promise((r) => setTimeout(r, 250)); }   // a wallet that injects late
    if (!found.length) {
      const l = legacy();
      if (!l) throw err('There is no wallet in this browser.', 'NO_WALLET');
      return use(l);
    }
    if (!force) { const p = settled(); if (p) return use(p); }
    const w = await picker();
    keep(w.id);
    return use(w.provider);
  }
  function use(p) {
    if (p !== active) {
      const had = active;
      active = p; listen(p);
      if (had) set('');                               // another wallet: the old address is not this one's
      tellWallets();
    }
    return p;
  }

  // ---------------------------------------------------------------- the picker
  const STYLE = '.rfw-pick{width:min(360px,calc(100vw - 32px));max-height:calc(100dvh - 32px);padding:0;border:1px solid var(--ink,#fff);' +
    'box-shadow:4px 4px 0 var(--ink,#fff);background:var(--paper,#000);color:var(--ink,#fff);font-family:var(--body,system-ui,sans-serif)}' +
    '.rfw-pick::backdrop{background:rgba(0,0,0,.62)}' +
    '.rfw-pick h2{margin:0;padding:14px 16px 4px;font-family:var(--display,monospace);font-weight:400;font-size:15px;letter-spacing:.1em}' +
    '.rfw-pick p{margin:0;padding:0 16px 12px;font-size:14px;line-height:1.4;color:var(--dim,rgba(255,255,255,.62))}' +
    '.rfw-pick ul{list-style:none;margin:0;padding:0 16px;display:grid;gap:8px;max-height:min(50dvh,320px);overflow-y:auto}' +
    '.rfw-pick ul button{width:100%;display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid var(--ink,#fff);' +
    'background:transparent;color:var(--ink,#fff);font-family:var(--display,monospace);font-size:14px;letter-spacing:.06em;text-align:left;cursor:pointer;border-radius:0}' +
    '.rfw-pick ul button:hover,.rfw-pick ul button:focus-visible{background:var(--signal,#CCFF00);color:var(--on-signal,#000);outline:none}' +
    '.rfw-pick img,.rfw-pick .rfw-blank{width:28px;height:28px;flex:none;object-fit:contain}' +
    '.rfw-pick .rfw-blank{border:1px solid currentColor}' +
    '.rfw-pick span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.rfw-pick i{font-style:normal;font-size:10px;letter-spacing:.1em;opacity:.7}' +
    '.rfw-pick .rfw-foot{display:flex;justify-content:flex-end;padding:12px 16px 14px}' +
    '.rfw-pick .rfw-cancel{font-family:var(--display,monospace);font-size:12px;letter-spacing:.08em;padding:9px 12px;border:1px solid var(--ink,#fff);' +
    'background:var(--paper,#000);color:var(--ink,#fff);cursor:pointer;border-radius:0}';
  let open = null;                                    // the picker being shown, so a second ask joins it
  function picker() {
    if (open) return open;
    open = new Promise((resolve, reject) => {
      if (!document.getElementById('rfw-css')) {
        const st = document.createElement('style'); st.id = 'rfw-css'; st.textContent = STYLE; document.head.appendChild(st);
      }
      const dlg = document.createElement('dialog');
      dlg.className = 'rfw-pick'; dlg.setAttribute('aria-labelledby', 'rfwTitle');
      const h = document.createElement('h2'); h.id = 'rfwTitle'; h.textContent = 'CHOOSE A WALLET';
      const p = document.createElement('p'); p.textContent = 'This browser has more than one. Pick the one that holds your Friend.';
      const ul = document.createElement('ul');
      const last = recall();
      let done = false;
      const finish = (w) => {
        if (done) return; done = true;
        try { dlg.close(); } catch (_) {}
        dlg.remove(); open = null;
        w ? resolve(w) : reject(err('No wallet was chosen.', 'NO_PICK'));
      };
      found.forEach((w) => {
        const li = document.createElement('li'), b = document.createElement('button');
        b.type = 'button'; b.dataset.walletId = w.id;
        if (w.icon) { const img = document.createElement('img'); img.src = w.icon; img.alt = ''; b.appendChild(img); }
        else { const s = document.createElement('b'); s.className = 'rfw-blank'; b.appendChild(s); }
        const n = document.createElement('span'); n.textContent = w.name; b.appendChild(n);
        if (w.id === last) { const t = document.createElement('i'); t.textContent = 'LAST USED'; b.appendChild(t); }
        b.addEventListener('click', () => finish(w));
        li.appendChild(b); ul.appendChild(li);
      });
      const foot = document.createElement('div'); foot.className = 'rfw-foot';
      const c = document.createElement('button'); c.type = 'button'; c.className = 'rfw-cancel'; c.textContent = 'CANCEL';
      c.addEventListener('click', () => finish(null)); foot.appendChild(c);
      dlg.append(h, p, ul, foot);
      dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(null); });          // Esc
      dlg.addEventListener('click', (e) => { if (e.target === dlg) finish(null); });         // the backdrop
      document.body.appendChild(dlg);
      dlg.showModal();
      const first = ul.querySelector('[data-wallet-id="' + (window.CSS && window.CSS.escape ? window.CSS.escape(last) : last) + '"]') || ul.querySelector('button');
      if (first) first.focus();
    });
    return open;
  }

  // ---------------------------------------------------------------- asking the chosen wallet
  async function current() {
    const e = settled(); if (!e) { set(''); return addr; }
    try { const a = await e.request({ method: 'eth_accounts' }); set(a && a[0]); }
    catch (_) { set(''); }
    return addr;
  }

  async function connect(opts) {
    const e = await choose(opts && opts.change);
    const a = await e.request({ method: 'eth_requestAccounts' });   // the wallet's own prompt
    if (!a || !isAddr(a[0])) throw err('The wallet gave no address.', 'NO_ADDRESS');
    set(a[0]);
    return addr;
  }

  // personal_sign, with the message as hex of its UTF-8 bytes: the bytes signed are the same as for the
  // plain string, and every wallet takes hex (a plain string is a MetaMask courtesy, not the standard)
  async function sign(message, address) {
    const e = await choose(false);
    const hex = '0x' + Array.from(new TextEncoder().encode(String(message)), (b) => b.toString(16).padStart(2, '0')).join('');
    return e.request({ method: 'personal_sign', params: [hex, address] });
  }

  // Robinhood Chain, if the wallet will go there. The chain is the server's ({ id, name, rpc } from
  // /api/auth/nonce), so no chain value is typed here. Never throws and never waits past `ms`: a
  // wallet that refuses, does not know the chain, or never answers still gets to sign.
  async function toChain(chain, ms) {
    const e = settled();
    if (!e || !chain || !chain.id) return { ok: false, why: 'no chain given' };
    const hex = '0x' + Number(chain.id).toString(16);
    const code = (x) => x && (x.code || (x.data && x.data.originalError && x.data.originalError.code));
    const go = async () => {
      try { if (String(await e.request({ method: 'eth_chainId' })).toLowerCase() === hex) return { ok: true }; } catch (_) {}
      try { await e.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] }); return { ok: true }; }
      catch (x) {
        if (code(x) === 4902 && chain.rpc) {
          try {
            await e.request({ method: 'wallet_addEthereumChain', params: [{ chainId: hex, chainName: chain.name, rpcUrls: [chain.rpc],
              nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } }] });
            return { ok: true };
          } catch (y) { return { ok: false, why: y }; }
        }
        return { ok: false, why: x };
      }
    };
    return Promise.race([go(), new Promise((r) => setTimeout(() => r({ ok: false, why: 'no answer' }), ms || 10000))]);
  }

  // A read asked of the WALLET's chain, not ours: a page that reads one chain and has the wallet send on another must
  // be able to tell the two apart before anything is signed (the dev chain answers chain id 4663, like mainnet).
  async function ask(method, params) {
    const e = settled(); if (!e) throw err('There is no wallet in this browser.', 'NO_WALLET');
    return e.request({ method, params: params || [] });
  }

  async function send(tx) {
    const e = await choose(false);
    const from = addr || await connect();
    const t = { from, to: tx.to, data: tx.data };
    if (tx.value) t.value = tx.value;
    return e.request({ method: 'eth_sendTransaction', params: [t] });
  }

  async function change() {
    const had = active;
    if (!found.length) discover();
    if (found.length < 2) { await choose(false); return chosen(); }
    const w = await picker();
    keep(w.id);
    use(w.provider);
    if (active !== had) current();
    return chosen();
  }

  function chosen() {
    const p = active || settled();
    if (!p) return '';
    const w = entry(p);
    return w ? w.name : 'Browser wallet';
  }

  function onChange(fn) { subs.push(fn); return () => { const i = subs.indexOf(fn); if (i >= 0) subs.splice(i, 1); }; }
  function onWallets(fn) { wsubs.push(fn); return () => { const i = wsubs.indexOf(fn); if (i >= 0) wsubs.splice(i, 1); }; }

  // accountsChanged from the wallet in use only: another wallet's accounts are not this player's
  function listen(e) {
    if (!e || heard.has(e) || typeof e.on !== 'function') return;
    heard.add(e);
    e.on('accountsChanged', (a) => { if (e === (active || settled())) set(a && a[0]); });
  }

  // a button marked data-wallet: one label before, the short address after, the full one on hover
  function mount(b) {
    if (b.dataset.walletMounted) return; b.dataset.walletMounted = '1';
    const idle = b.textContent.trim() || 'CONNECT WALLET';
    const paint = (a, why) => {
      b.textContent = a ? short(a) : (why || idle);
      b.title = a ? a : (available() ? 'Connect a wallet' : 'There is no wallet in this browser');
      b.dataset.wallet = a ? 'connected' : (why ? 'error' : 'idle');
      b.setAttribute('aria-label', a ? 'Wallet ' + a : idle);
    };
    paint(addr);
    onChange((a) => paint(a));
    b.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (addr) return;                     // connected: the address is what it shows, and that is all
      if (!available()) { paint('', 'NO WALLET'); return; }
      b.disabled = true; b.textContent = 'CHECK WALLET';
      try { await connect(); }
      catch (x) { paint('', x && x.code === 'NO_PICK' ? '' : x && x.code === 4001 ? 'REFUSED' : 'NO WALLET'); }
      finally { b.disabled = false; }
    });
  }

  const available = () => found.length > 0 || !!legacy();
  const wallets = () => found.map((w) => ({ id: w.id, name: w.name, icon: w.icon }));
  const api = { available, connect, sign, send, ask, toChain, change, chosen, wallets, onWallets, current, onChange, short, isAddr, mount,
    get address() { return addr; } };
  window.RFWallet = api;

  function boot() {
    const e = settled(); if (e) listen(e);
    document.querySelectorAll('[data-wallet]').forEach(mount);
    current();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
