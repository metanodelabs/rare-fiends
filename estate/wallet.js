// The one wallet connection. M5 item 1.
//
// A player IS an address (schema.json, entity `player`: "There is no id, no nickname and no
// registration"). This file is the only place a page asks the browser's EVM wallet for it.
// bridge.html and deployer.html each carry their own older copy of the same request
// (bridge.html's eth_requestAccounts, deployer.html's eth()); they are left as they are and are
// candidates to move onto this file, not rewritten here.
//
// What it does NOT do, on purpose:
//   - It never switches or adds a chain. Knowing who a player is needs no chain; the first page
//     that sends a transaction asks for chain 4663 itself, through Chance.CHAIN_ID.
//   - It stores nothing. Whether a page is still connected is asked of the wallet (eth_accounts,
//     which answers without a prompt once this site has been allowed), so there is no second
//     copy of the answer in localStorage to go stale.
//   - It holds no name. A display name (schema `player.displayName`, home: client) is M5 item 2,
//     which is not built - see DESIGN.md M5.
//
// Use:
//   RFWallet.available()           -> is there a wallet in this browser
//   await RFWallet.connect()       -> the address, after the wallet's own prompt (throws if refused)
//   await RFWallet.current()       -> the address if this site is already allowed, else ''
//   RFWallet.onChange(fn)          -> fn(address or '') whenever it changes
//   RFWallet.short(a)              -> 0x1234…abcd
//   <button data-wallet>           -> wired automatically: CONNECT WALLET, then the short address
(function () {
  const eth = () => (window.ethereum && typeof window.ethereum.request === 'function') ? window.ethereum : null;
  const short = (a) => a ? a.slice(0, 6) + '…' + a.slice(-4) : '';
  const isAddr = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
  let addr = '';
  const subs = [];

  function set(a) {
    const next = isAddr(a) ? a : '';
    if (next === addr) return;
    addr = next;
    subs.forEach((fn) => { try { fn(addr); } catch (e) { console.warn('wallet listener', e); } });
  }

  async function current() {
    const e = eth(); if (!e) return '';
    try { const a = await e.request({ method: 'eth_accounts' }); set(a && a[0]); }
    catch (_) { set(''); }
    return addr;
  }

  async function connect() {
    const e = eth();
    if (!e) throw Object.assign(new Error('There is no wallet in this browser.'), { code: 'NO_WALLET' });
    const a = await e.request({ method: 'eth_requestAccounts' });   // the wallet's own prompt
    if (!a || !isAddr(a[0])) throw Object.assign(new Error('The wallet gave no address.'), { code: 'NO_ADDRESS' });
    set(a[0]);
    return addr;
  }

  function onChange(fn) { subs.push(fn); return () => { const i = subs.indexOf(fn); if (i >= 0) subs.splice(i, 1); }; }

  let listening = false;
  function listen() {
    const e = eth(); if (!e || listening || typeof e.on !== 'function') return;
    listening = true;
    e.on('accountsChanged', (a) => set(a && a[0]));
  }

  // a button marked data-wallet: one label before, the short address after, the full one on hover
  function mount(b) {
    if (b.dataset.walletMounted) return; b.dataset.walletMounted = '1';
    const idle = b.textContent.trim() || 'CONNECT WALLET';
    const paint = (a, why) => {
      b.textContent = a ? short(a) : (why || idle);
      b.title = a ? a : (eth() ? 'Connect a wallet' : 'There is no wallet in this browser');
      b.dataset.wallet = a ? 'connected' : (why ? 'error' : 'idle');
      b.setAttribute('aria-label', a ? 'Wallet ' + a : idle);
    };
    paint(addr);
    onChange((a) => paint(a));
    b.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (addr) return;                     // connected: the address is what it shows, and that is all
      if (!eth()) { paint('', 'NO WALLET'); return; }
      b.disabled = true; b.textContent = 'CHECK WALLET';
      try { await connect(); }
      catch (err) { paint('', err && err.code === 4001 ? 'REFUSED' : 'NO WALLET'); }
      finally { b.disabled = false; }
    });
  }

  const api = { available: () => !!eth(), connect, current, onChange, short, isAddr, mount,
    get address() { return addr; } };
  window.RFWallet = api;

  function boot() {
    listen();
    document.querySelectorAll('[data-wallet]').forEach(mount);
    current();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
