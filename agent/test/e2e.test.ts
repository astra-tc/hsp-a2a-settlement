import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { ethers } from "ethers";
import { startAnvil, deploy, KEYS } from "./harness.ts";
import { LocalCoordinator } from "../src/hsp/coordinator.ts";
import { hspDomain, buildMandate, signMandate, nonceForQuote } from "../src/hsp/mandate.ts";
import { SpendGuard } from "../src/hsp/spendGuard.ts";
import { createSeller } from "../src/a2a/seller.ts";
import { callPaidAgent } from "../src/a2a/buyer.ts";
import { enc, PAYMENT_HEADER, type PaymentRequired } from "../src/a2a/protocol.ts";

let env: Awaited<ReturnType<typeof setup>>;
async function setup() {
  const { proc, provider } = await startAnvil(8547);
  const buyer = new ethers.Wallet(KEYS[0], provider), seller = new ethers.Wallet(KEYS[1], provider);
  const usdc = await deploy(buyer, "MockUSDC.sol", "MockUSDC");
  const reg = await deploy(seller, "A2AReceiptRegistry.sol", "A2AReceiptRegistry");
  await (await usdc.mint(buyer.address, 1_000_000n)).wait();
  const domain = hspDomain(31337);
  const coordinator = new LocalCoordinator(provider, domain);
  const s = createSeller({ wallet: seller, provider, coordinator, domain, hspChain: "local", asset: await usdc.getAddress(), priceBaseUnits: 10_000n, registry: await reg.getAddress() });
  await new Promise<void>((r) => s.server.listen(0, r));
  const url = `http://127.0.0.1:${(s.server.address() as AddressInfo).port}/tasks/chain-snapshot`;
  const guard = (max = 50_000n) => new SpendGuard({ maxPerPayment: max, maxPerDay: 100_000n, allowedPayees: [seller.address], allowedTokens: [usdc.target as string], chainId: 31337 });
  return { proc, provider, buyer, seller, usdc, reg, coordinator, s, url, guard, domain };
}
before(async () => { env = await setup(); });
after(() => { env?.s.server.closeAllConnections(); env?.s.server.close(); env?.provider.destroy(); env?.proc.kill(); });

test("unpaid call returns 402 with an HSP requirement", async () => {
  const r = await fetch(env.url, { method: "POST", body: "{}" });
  assert.equal(r.status, 402);
  const pr = (await r.json()) as PaymentRequired;
  assert.equal(pr.accepts[0].scheme, "hsp-mandate");
  assert.equal(pr.accepts[0].payTo, env.seller.address);
});

test("buyer pays via HSP mandate + USDC transfer, seller delivers and anchors receipt", async () => {
  const before = await env.usdc.balanceOf(env.seller.address);
  const out = await callPaidAgent(env.url, {}, { wallet: env.buyer, coordinator: env.coordinator, guard: env.guard() });
  assert.equal(out.status, 200);
  const b = out.body as { result: { skill: string }; anchorTx: string; receipt: { status: string } };
  assert.equal(b.result.skill, "chain-snapshot");
  assert.equal(b.receipt.status, "settled");
  assert.equal((await env.usdc.balanceOf(env.seller.address)) - before, 10_000n);
  const rec = await env.reg.receipts(out.paymentId);
  assert.equal(rec.payer, env.buyer.address);
  assert.equal(rec.payee, env.seller.address);
  assert.equal(rec.amount, 10_000n);
});

test("replaying the same payment proof is refused", async () => {
  const pr = (await (await fetch(env.url, { method: "POST", body: "{}" })).json()) as PaymentRequired;
  const q = pr.accepts[0];
  const m = await signMandate(env.buyer, env.domain, buildMandate({ signer: env.buyer.address, recipient: q.payTo, token: q.asset, amount: 10_000n, chainId: 31337, deadline: q.expiresAt, nonce: nonceForQuote(q.quoteId) }));
  const paymentId = await env.coordinator.register("local", m);
  const tx = await env.usdc.transfer(q.payTo, 10_000n); await tx.wait();
  const h = { [PAYMENT_HEADER]: enc({ quoteId: q.quoteId, paymentId, txHash: tx.hash, mandate: m }) };
  assert.equal((await fetch(env.url, { method: "POST", headers: h, body: "{}" })).status, 200);
  const again = await fetch(env.url, { method: "POST", headers: h, body: "{}" });
  assert.equal(again.status, 402);
  assert.match(((await again.json()) as { error: string }).error, /unknown or expired quote|already used/);
});

test("mandate not bound to the quote is refused", async () => {
  const pr = (await (await fetch(env.url, { method: "POST", body: "{}" })).json()) as PaymentRequired;
  const q = pr.accepts[0];
  const m = await signMandate(env.buyer, env.domain, buildMandate({ signer: env.buyer.address, recipient: q.payTo, token: q.asset, amount: 10_000n, chainId: 31337, deadline: q.expiresAt }));
  const paymentId = await env.coordinator.register("local", m);
  const tx = await env.usdc.transfer(q.payTo, 10_000n); await tx.wait();
  const r = await fetch(env.url, { method: "POST", headers: { [PAYMENT_HEADER]: enc({ quoteId: q.quoteId, paymentId, txHash: tx.hash, mandate: m }) }, body: "{}" });
  assert.equal(r.status, 402);
  assert.match(((await r.json()) as { error: string }).error, /not bound/);
});

test("transfer that does not match the mandate is refused by the coordinator check", async () => {
  const pr = (await (await fetch(env.url, { method: "POST", body: "{}" })).json()) as PaymentRequired;
  const q = pr.accepts[0];
  const m = await signMandate(env.buyer, env.domain, buildMandate({ signer: env.buyer.address, recipient: q.payTo, token: q.asset, amount: 10_000n, chainId: 31337, deadline: q.expiresAt, nonce: nonceForQuote(q.quoteId) }));
  const paymentId = await env.coordinator.register("local", m);
  const tx = await env.usdc.transfer(q.payTo, 1n); await tx.wait(); // underpays on-chain
  const r = await fetch(env.url, { method: "POST", headers: { [PAYMENT_HEADER]: enc({ quoteId: q.quoteId, paymentId, txHash: tx.hash, mandate: m }) }, body: "{}" });
  assert.equal(r.status, 402);
  assert.match(((await r.json()) as { error: string }).error, /no Transfer log/);
});

test("SpendGuard blocks an over-cap price before anything is signed", async () => {
  const bal = await env.usdc.balanceOf(env.buyer.address);
  await assert.rejects(callPaidAgent(env.url, {}, { wallet: env.buyer, coordinator: env.coordinator, guard: env.guard(5_000n) }), /per-payment cap/);
  assert.equal(await env.usdc.balanceOf(env.buyer.address), bal);
});
