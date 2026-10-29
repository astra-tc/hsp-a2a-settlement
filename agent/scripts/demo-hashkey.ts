/**
 * Live run on HashKey Chain (mainnet 177 or testnet 133) through the real HSP Coordinator.
 * Env: HSK_RPC, HSK_CHAIN_ID, HSP_COORDINATOR_URL, HSP_API_KEY, HSP_CHAIN (hashkey|hashkey-testnet),
 *      USDC_ADDRESS, BUYER_KEY, SELLER_KEY, [REGISTRY], [PRICE_BASE_UNITS=10000], [MAX_PER_PAYMENT=20000]
 * Writes ../proofs/hashkey-<chainId>.json
 */
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import { ethers } from "ethers";
import { artifact } from "../test/harness.ts";
import { HttpCoordinator, hspDomain, SpendGuard, createSeller, callPaidAgent, REGISTRY_ABI } from "../src/index.ts";

const need = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`missing env ${k}`); return v; };
const chainId = Number(need("HSK_CHAIN_ID"));
const provider = new ethers.JsonRpcProvider(need("HSK_RPC"), chainId, { staticNetwork: true });
const buyer = new ethers.Wallet(need("BUYER_KEY"), provider), seller = new ethers.Wallet(need("SELLER_KEY"), provider);
const usdcAddr = need("USDC_ADDRESS");
const price = BigInt(process.env.PRICE_BASE_UNITS ?? "10000");
const log = (s: string) => console.log(s);

let registry = process.env.REGISTRY;
const proof: Record<string, unknown> = { chainId, buyer: buyer.address, seller: seller.address, usdc: usdcAddr, startedAt: new Date().toISOString() };
if (!registry) {
  const a = artifact("A2AReceiptRegistry.sol", "A2AReceiptRegistry");
  const c = await new ethers.ContractFactory(a.abi, a.bytecode, seller).deploy();
  await c.waitForDeployment();
  registry = await c.getAddress();
  proof.registryDeployTx = c.deploymentTransaction()?.hash;
  log(`deployed A2AReceiptRegistry ${registry}`);
}
proof.registry = registry;
const reg = new ethers.Contract(registry, REGISTRY_ABI, seller);
const rtx = await reg.registerAgent("astra-snapshot-seller", "https://github.com/astra-tc/hsp-a2a-settlement");
proof.registerAgentTx = (await rtx.wait())?.hash;

const coordinator = new HttpCoordinator(need("HSP_COORDINATOR_URL"), need("HSP_API_KEY"));
const domain = hspDomain(chainId, process.env.HSP_VERIFYING_CONTRACT);
const s = createSeller({ wallet: seller, provider, coordinator, domain, hspChain: need("HSP_CHAIN"), asset: usdcAddr, priceBaseUnits: price, registry });
await new Promise<void>((r) => s.server.listen(0, r));
const url = `http://127.0.0.1:${(s.server.address() as AddressInfo).port}/tasks/chain-snapshot`;
const guard = new SpendGuard({ maxPerPayment: BigInt(process.env.MAX_PER_PAYMENT ?? "20000"), maxPerDay: 100_000n, allowedPayees: [seller.address], allowedTokens: [usdcAddr], chainId });
const out = await callPaidAgent(url, {}, { wallet: buyer, coordinator, guard, log, confirmations: chainId === 177 ? 5 : 2 });
Object.assign(proof, { paymentId: out.paymentId, usdcTransferTx: out.txHash, response: out.body, finishedAt: new Date().toISOString() });
writeFileSync(new URL(`../../proofs/hashkey-${chainId}.json`, import.meta.url), JSON.stringify(proof, null, 2));
log(JSON.stringify(proof, null, 2));
s.server.closeAllConnections(); s.server.close(); provider.destroy();
