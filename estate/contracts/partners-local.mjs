// THE FAKE WORLD ONLY: RarePartners on the local or dev anvil, so the server's clock (estate/clockwork.mjs, M16
// item 7) has partnerships to settle. Not part of the M20 deploy: deploy.mjs still passes RareMarket partners = 0,
// and whether and how RarePartners joins the real deploy (RareMarket's immutable `partners`, RareGame.setPartners)
// is M20's, not this file's.
//
//   EVM_RPC=http://127.0.0.1:<port> DEPLOYER_KEY=... node partners-local.mjs [--yes-local]
//
// Reads FakeRF and MockGenesis from the local config (deploy/local-chain.sh fake wrote them), refuses unless the RPC is
// a loopback, UNFORKED anvil with no ArbSys (deploylib requireUnforkedAnvil) and the config says fakeWorld, deploys
// RarePartners(roles, FakeRF, 24 h) - DESIGN, Partnerships: "24 hours to start, and it is a number the deployer can
// change" - switches MockGenesis on as partnerable (SET_PARTNERSHIPS, root), and writes `rarePartners` to the config.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { Wallet, Contract, ContractFactory, NonceManager } from 'ethers';
import { HERE, compileAll, readKey, connect, confirm, eth, cfgPath, readCfg, LOCAL, EVM_RPC, requireUnforkedAnvil, chainlive } from './deploylib.mjs';

if (!LOCAL) { console.error('partners-local: EVM_RPC is not a loopback address (' + (EVM_RPC || 'unset - that is chain 4663 itself') + '). Refusing.'); process.exit(2); }
const KEY = readKey([path.join(HERE, 'partners-local.mjs'), path.join(HERE, 'deploylib.mjs')]);
const WAIT = 24 * 3600;   // DESIGN, Partnerships: the waiting period is 24 hours to start
const cfg = readCfg();
if (cfg.fakeWorld !== true || !cfg.fakeRF || !cfg.mockGenesis || !cfg.rareRoles) { console.error(path.basename(cfgPath()) + ' is not a fake world with fakeRF, mockGenesis and rareRoles - run deploy/local-chain.sh fake first. Refusing.'); process.exit(2); }
const provider = await connect(chainlive().rpcs);
await requireUnforkedAnvil(provider);
const wallet = new NonceManager(new Wallet(KEY, provider));
const art = compileAll().RarePartners;
console.log('RarePartners on the FAKE world at ' + EVM_RPC + ': roles ' + cfg.rareRoles + ', $RF ' + cfg.fakeRF + ' (FakeRF), waiting period ' + WAIT + ' s');
if (cfg.rarePartners && (await provider.getCode(cfg.rarePartners)) !== '0x') { console.log('already deployed at ' + cfg.rarePartners + ' - nothing sent'); process.exit(0); }
await confirm('Deploy RarePartners to the local fake world?');
const f = new ContractFactory(art.abi, art.bytecode, wallet);
const c = await f.deploy(cfg.rareRoles, cfg.fakeRF, WAIT);
await c.waitForDeployment();
console.log('deployed at ' + c.target);
const tx = await new Contract(c.target, art.abi, wallet).setPartnerable(cfg.mockGenesis, true); await tx.wait();
console.log('setPartnerable(MockGenesis ' + cfg.mockGenesis + ', true)  tx ' + tx.hash);
cfg.rarePartners = c.target;
writeFileSync(cfgPath(), JSON.stringify(cfg, null, 2) + '\n');
console.log(path.basename(cfgPath()) + ': rarePartners = ' + c.target + '  (deployer balance ' + eth(await provider.getBalance(await wallet.getAddress())) + ')');
