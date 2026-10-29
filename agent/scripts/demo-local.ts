/** End-to-end A2A payment on a local anvil chain (HSP checks emulated by LocalCoordinator). */
import type { AddressInfo } from "node:net";
import { ethers } from "ethers";
import { startAnvil, deploy, KEYS } from "../test/harness.ts";
import { LocalCoordinator, hspDomain, SpendGuard, createSeller, callPaidAgent } from "../src/index.ts";

const say = (s: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
const { proc, provider } = await startAnvil(8548);
try {
  const buyer = new ethers.Wallet(KEYS[0], provider), seller = new ethers.Wallet(KEYS[1], provider);
  say(`buyer agent  ${buyer.address}`); say(`seller agent ${seller.address}`);
  const usdc = await deploy(buyer, "MockUSDC.sol", "MockUSDC");
  const reg = await deploy(seller, "A2AReceiptRegistry.sol", "A2AReceiptRegistry");
  await (await usdc.mint(buyer.address, 1_000_000n)).wait();
  await (await reg.registerAgent("astra-snapshot-seller", "http://127.0.0.1/tasks/chain-snapshot")).wait();
  say(`registry ${await reg.getAddress()} | token ${await usdc.getAddress()}`);
  const domain = hspDomain(31337);
  const coordinator = new LocalCoordinator(provider, domain);
  const s = createSeller({ wallet: seller, provider, coordinator, domain, hspChain: "local", asset: await usdc.getAddress(), priceBaseUnits: 10_000n, registry: await reg.getAddress() });
  await new Promise<void>((r) => s.server.listen(0, r));
  const url = `http://127.0.0.1:${(s.server.address() as AddressInfo).port}/tasks/chain-snapshot`;
  const guard = new SpendGuard({ maxPerPayment: 50_000n, maxPerDay: 200_000n, allowedPayees: [seller.address], allowedTokens: [await usdc.getAddress()], chainId: 31337 });
  say(`buyer -> POST ${url}`);
  const out = await callPaidAgent(url, {}, { wallet: buyer, coordinator, guard, log: say });
  say(`seller -> ${out.status} ${JSON.stringify((out.body as { result: unknown }).result)}`);
  say(`receipt anchored on-chain: ${(out.body as { anchorTx: string }).anchorTx}`);
  say(`registry.receiptCount = ${await reg.receiptCount()}`);
  s.server.closeAllConnections(); s.server.close();
} finally { provider.destroy(); proc.kill(); }
