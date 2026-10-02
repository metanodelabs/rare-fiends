// A throwaway copy of the repository that a check can be run against, and a site served out of it.
//
// It exists for M22 item 2 - every check made to fail on purpose once. To break a page without touching the real
// one, the page has to be broken SOMEWHERE ELSE, and a check has to be pointed there. So this:
//
//   1. copies estate/ whole into a temporary directory (6-7 MB; contracts/node_modules is linked, not copied),
//   2. links every other top-level entry of the repository beside it, so a check reading `../TOOLKIT.md` or
//      `../game plan/DESIGN.pdf` finds it exactly where it does in the real tree,
//   3. builds site/ as the local site/ is built - a link into ../estate for every file, base.html and hero.html
//      the game, and the extra links deploy-test.sh makes - and
//   4. serves that site/ with the copy's own serve.py on a free port (records and whitelist inside the copy).
//
// `materialize(rel)` turns a linked path into a real copy so it can be edited: a mutant on TOOLKIT.md must not
// edit the real TOOLKIT.md through a symlink. Nothing here ever writes outside the temporary directory, and
// `remove()` takes the whole of it away, server first.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { spawn } = require('child_process');

const ESTATE = __dirname, REPO = path.resolve(__dirname, '..');
// Never linked into a staged tree: version control, the worktrees, and a site/ we build ourselves.
const SKIP_TOP = new Set(['.git', '.claude', 'site', 'estate']);

// site/ beside this checkout, and beside the main checkout when this is a git worktree (found through git, never typed)
function liveSites() {
  const out = [path.join(REPO, 'site')];
  try {
    const common = require('child_process').execFileSync('git', ['-C', REPO, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
    out.push(path.join(path.dirname(common), 'site'));
  } catch (_) {}
  return out.filter((d) => fs.existsSync(d));
}

function stage() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rfbrk-'));
  const est = path.join(root, 'estate');
  fs.cpSync(ESTATE, est, { recursive: true, dereference: false, preserveTimestamps: true,
    filter: (src) => !/[\/\\](node_modules|__pycache__|clips)([\/\\]|$)/.test(src.slice(ESTATE.length)) });
  const nm = path.join(ESTATE, 'contracts', 'node_modules');
  if (fs.existsSync(nm)) fs.symlinkSync(nm, path.join(est, 'contracts', 'node_modules'));
  for (const n of fs.readdirSync(REPO)) if (!SKIP_TOP.has(n)) fs.symlinkSync(path.join(REPO, n), path.join(root, n));
  // the site, as the local one is laid out (CLAUDE.md: site/ holds links into estate/, base.html is the game)
  const site = path.join(root, 'site'); fs.mkdirSync(site);
  for (const n of fs.readdirSync(est)) {
    if (/^(contracts|fixtures|index\.html)$/.test(n)) continue;
    fs.symlinkSync('../estate/' + n, path.join(site, n));
  }
  fs.symlinkSync('../estate/index.html', path.join(site, 'base.html'));
  fs.symlinkSync('../estate/index.html', path.join(site, 'hero.html'));
  const extra = [['anim', '../web_assets/doopie-voxel-animations'], ['burrow', '../web_assets/social/burrow'],
    ['rarefiends-title.html', '../web_assets/rarefiends-title.html'], ['doopie-mesh.mjs', '../doopies_converter/tools/doopie-mesh.mjs'],
    ['token.svg', '../static/token.svg'], ['vendor', '../static/vendor'],
    ['three.core.js', '../web_assets/three.core.js'], ['three.module.js', '../web_assets/three.module.js']];
  for (const [n, to] of extra) if (fs.existsSync(path.join(site, to)) && !fs.existsSync(path.join(site, n))) fs.symlinkSync(to, path.join(site, n));
  // The collector's output (collector.py writes site/stats.json - the prices chainlive.js reads - and holders.json).
  // It is not in the repository, so it is COPIED from the local site/ this checkout or its main checkout already has,
  // read-only. Without it every page reading prices 404s, and the checks say so - which is them working.
  for (const d of liveSites()) for (const n of ['stats.json', 'holders.json']) {
    const f = path.join(d, n);
    if (fs.existsSync(f) && !fs.existsSync(path.join(site, n))) fs.copyFileSync(f, path.join(site, n));
  }

  let srv = null, origin = null;
  const api = {
    root, estate: est, site,
    // a path relative to the repository root, made a real file (or directory chain) inside the copy
    materialize(rel) {
      const parts = rel.split('/'); let cur = root;
      for (let i = 0; i < parts.length; i++) {
        const p = path.join(cur, parts[i]);
        const st = fs.lstatSync(p);
        if (st.isSymbolicLink()) {
          const real = fs.realpathSync(p);
          fs.unlinkSync(p);
          if (fs.statSync(real).isDirectory()) { fs.mkdirSync(p); for (const c of fs.readdirSync(real)) fs.symlinkSync(path.join(real, c), path.join(p, c)); }
          else fs.copyFileSync(real, p);
        }
        cur = p;
      }
      return cur;
    },
    async serve() {
      const port = await require('./pagewatch.js').freePort(30000, 4000);
      // serve.py, as the local site is served (its api/convert is what the bridge page converts through), from the
      // COPY - it serves ../site beside its own path - with its records and whitelist kept inside the copy too
      srv = spawn('python3', [path.join(est, 'serve.py'), String(port), '--records=' + path.join(root, 'records'), '--whitelist=' + path.join(root, 'whitelist.json')],
        { stdio: 'ignore', detached: true });
      origin = 'http://localhost:' + port;
      for (let i = 0; i < 100; i++) {
        if (srv.exitCode !== null) throw new Error('the staged site\'s server exited before it answered');
        try { const r = await fetch(origin + '/base.html'); if (r.ok) return origin; } catch (_) {}
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('the staged site never answered on ' + origin);
    },
    origin: () => origin,
    remove() {
      if (srv) { try { process.kill(-srv.pid, 'SIGKILL'); } catch (_) { try { srv.kill('SIGKILL'); } catch (__) {} } srv = null; }
      try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
    },
  };
  return api;
}

module.exports = { stage, ESTATE, REPO };

// `node estate/stage.js <check> [RF_PORT_OFFSET]` runs ONE check, unmutated, against a staged copy served on a free
// port, with every fixed port it uses moved by the offset (default 2000). It is how a check is run on a machine where
// somebody else's suite holds :8765 and the unshifted debug ports - without touching either.
if (require.main === module) {
  const [check, off] = process.argv.slice(2);
  if (!check) { console.log('usage: node estate/stage.js <check> [port offset]'); process.exit(2); }
  (async () => {
    const stg = stage(); let code = 1;
    try {
      const origin = await stg.serve();
      console.log('  (staged copy served at ' + origin + ', ports offset by ' + (+off || 2000) + ')');
      code = await new Promise((done) => {
        const p = spawn(process.execPath, [path.join(stg.estate, check.replace(/\.js$/, '') + '.js')], { cwd: stg.estate, stdio: 'inherit',
          env: Object.assign({}, process.env, { RF_SITE: origin, RF_PORT_OFFSET: String(+off || 2000) }) });
        p.on('close', (c) => done(c));
      });
    } finally { stg.remove(); }
    process.exit(code);
  })();
}
