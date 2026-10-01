#!/usr/bin/env node
// Record the estate reel to a GIF.
//
//   node estate/reel.js                        every scene, one gif each, into estate/clips/
//   node estate/reel.js --from 13000 --to 19500 --out tower.gif
//   node estate/reel.js --fps 16 --scale 1
//
// The page exposes window.reelFrame(ms), which renders exactly that moment of the reel and
// nothing else — no live animation, no rAF. So each capture is deterministic: the same ms
// gives the same picture every run, which is what makes a clean GIF possible at all.
'use strict';
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const URL_BASE = arg('url', 'http://localhost:8765/base.html');
const FPS = parseInt(arg('fps', '14'), 10);
const SCALE = parseFloat(arg('scale', '1'));
const OUTDIR = arg('dir', path.join(__dirname, 'clips'));
const COLORS = arg('colors', '48');   // the estate is black, white and one green — it does not need 256

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function cdp() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json`);
  const targets = await res.json();
  const page = targets.find(t => t.type === 'page');
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
  let id = 0; const waiting = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((ok, no) => {
    const n = ++id; waiting.set(n, (m) => m.error ? no(new Error(method + ': ' + m.error.message)) : ok(m.result));
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  return { send, close: () => ws.close() };
}

async function main() {
  fs.mkdirSync(OUTDIR, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-'));
  const url = URL_BASE + (URL_BASE.includes('?') ? '&' : '?') + 'reel=1&rec=1';
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    '--window-size=1000,700', url,
  ], { stdio: 'ignore' });

  let c = null;
  for (let i = 0; i < 40 && !c; i++) { await sleep(250); try { c = await cdp(); } catch (_) {} }
  if (!c) { chrome.kill(); throw new Error('chrome never came up on ' + PORT); }

  // wait for the page to define its recorder hook
  let info = null;
  for (let i = 0; i < 60 && !info; i++) {
    await sleep(250);
    const r = await c.send('Runtime.evaluate', { expression: 'window.reelInfo && JSON.stringify(window.reelInfo)', returnByValue: true });
    if (r.result && typeof r.result.value === 'string') info = JSON.parse(r.result.value);
  }
  if (!info) { chrome.kill(); throw new Error('the page never exposed reelInfo — is the server running?'); }

  const box = JSON.parse((await c.send('Runtime.evaluate', {
    expression: '(()=>{const r=document.querySelector(".frame").getBoundingClientRect();' +
      'return JSON.stringify({x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)})})()',
    returnByValue: true,
  })).result.value);

  // one clip per scene unless the caller asked for a specific span
  const fromArg = arg('from', null), toArg = arg('to', null);
  const clips = (fromArg !== null || toArg !== null)
    ? [{ name: arg('out', 'clip.gif'), from: parseInt(fromArg || '0', 10), to: parseInt(toArg || String(info.ms), 10) }]
    : info.scenes.map((s, i) => ({
        name: String(i + 1).padStart(2, '0') + '-' + s.cap.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '.gif',
        from: s.t, to: i + 1 < info.scenes.length ? info.scenes[i + 1].t : info.ms,
      }));

  for (const clip of clips) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frames-'));
    const step = 1000 / FPS;
    const n = Math.max(1, Math.round((clip.to - clip.from) / step));
    process.stdout.write(`${clip.name}  ${n} frames @ ${FPS}fps  `);
    for (let i = 0; i < n; i++) {
      await c.send('Runtime.evaluate', { expression: `reelFrame(${clip.from + i * step})`, returnByValue: true });
      const shot = await c.send('Page.captureScreenshot', { format: 'png', clip: { ...box, scale: SCALE } });
      fs.writeFileSync(path.join(tmp, String(i).padStart(4, '0') + '.png'), Buffer.from(shot.data, 'base64'));
    }
    const out = path.join(OUTDIR, clip.name);
    const pal = path.join(tmp, 'pal.png');
    // a per-clip palette, or the signal green bands badly against the near-black ground
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(tmp, '%04d.png'),
      '-vf', 'palettegen=max_colors=' + COLORS + ':stats_mode=diff', pal]);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS),
      '-i', path.join(tmp, '%04d.png'), '-i', pal,
      '-lavfi', 'paletteuse=dither=bayer:bayer_scale=3', '-loop', '0', out]);
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('-> ' + out + '  ' + (fs.statSync(out).size / 1024).toFixed(0) + ' KB');
  }
  c.close(); chrome.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}   // chrome may still be letting go
}

main().catch(e => { console.error(e.message); process.exit(1); });
