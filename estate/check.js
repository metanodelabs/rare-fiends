// Guardrail for the estate mockup: load it at several rotations, fail loudly on a JS
// error or a canvas that stopped drawing, and leave a contact sheet to eyeball.
const { execSync } = require('child_process');
const fs = require('fs');
const CH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const YAWS = [0, 0.8, 1.6, 2.4, 3.2, 4.0];
const URL = process.argv[2] || require('./pagewatch.js').SITE+'/base.html';
// Its own directory per run, not fixed /tmp/ec_<yaw> paths: two runs at once (the suite and a breakall.js mutant, or
// two agents) overwrote each other's screenshots and logs, so a FAIL could be read off somebody else's run.
const DIR = process.env.SHOTS || fs.mkdtempSync(require('path').join(require('os').tmpdir(), 'ec-'));
let bad = 0;
for (const y of YAWS) {
  const out = `${DIR}/ec_${y}.png`, log = `${DIR}/ec_${y}.log`;
  try {
    execSync(`"${CH}" --headless=new --disable-gpu --hide-scrollbars --virtual-time-budget=5000 ` +
      `--enable-logging=stderr --v=0 --window-size=1000,700 --screenshot="${out}" ` +
      `"${URL}${URL.includes('?') ? '&' : '?'}yaw=${y}" 2>"${log}"`, { stdio: 'pipe' });
  } catch (e) { console.log(`yaw ${y}: chrome failed`); bad++; continue; }
  const errs = (fs.readFileSync(log, 'utf8').match(/^.*(SEVERE|Uncaught|is not defined|before initialization).*$/gm) || [])
    .filter(l => !/Fontconfig|GPU|gl_|dbus|Vulkan/i.test(l));
  const px = fs.statSync(out).size;                      // a blank canvas compresses to almost nothing
  const ok = px > 30000 && !errs.length;
  if (!ok) bad++;
  console.log(`yaw ${y.toFixed(1)}  ${String(px).padStart(7)} bytes  ${ok ? 'ok' : 'FAIL'}` +
    (errs.length ? '\n   ' + errs.slice(0, 3).join('\n   ') : ''));
}
console.log('      (the contact sheet and logs: ' + DIR + ')');
console.log(bad ? `\n${bad}/${YAWS.length} angles FAILED` : `\nall ${YAWS.length} angles render`);
process.exit(bad ? 1 : 0);
