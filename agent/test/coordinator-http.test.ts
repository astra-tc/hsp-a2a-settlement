import { test } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { HttpCoordinator } from "../src/hsp/coordinator.ts";
import { buildMandate, signMandate, hspDomain, paymentIdOf } from "../src/hsp/mandate.ts";

test("HttpCoordinator sends the HSP wire format with Bearer auth and retries 202 on observe", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  let observeHits = 0;
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("/payments")) return new Response(JSON.stringify({ paymentId: "0xabc" }), { status: 201 });
    observeHits++;
    if (observeHits < 2) return new Response("{}", { status: 202 });
    return new Response(JSON.stringify({ payer: "0x1", payee: "0x2", amount: "5", blockNumber: 9 }), { status: 200 });
  }) as unknown as typeof fetch;
  const c = new HttpCoordinator("https://coord.example/", "k-123", { attempts: 3, fetch: fakeFetch });
  const w = ethers.Wallet.createRandom();
  const m = await signMandate(w, hspDomain(177), buildMandate({ signer: w.address, recipient: w.address, token: "0x054ed45810DbBAb8B27668922D110669c9D88D0a", amount: 5n, chainId: 177, deadline: 2_000_000_000 }));
  assert.equal(await c.register("hashkey", m), "0xabc");
  const sent = JSON.parse(String(calls[0].init.body));
  assert.equal(calls[0].url, "https://coord.example/payments");
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer k-123");
  assert.equal(sent.chain, "hashkey");
  assert.deepEqual(sent.attestations, []);
  assert.equal(sent.mandate.signerProof, m.signerProof);
  const r = await c.observe("0xabc", "0xdead");
  assert.equal(r.status, "settled");
  assert.equal(observeHits, 2);
  assert.equal(calls[1].url, "https://coord.example/payments/0xabc/observe");
  assert.ok(paymentIdOf(m.body).startsWith("0x"));
});

test("HttpCoordinator surfaces coordinator errors", async () => {
  const f = (async () => new Response("bad key", { status: 401 })) as unknown as typeof fetch;
  const c = new HttpCoordinator("https://c", "x", { attempts: 1, fetch: f });
  const w = ethers.Wallet.createRandom();
  const m = await signMandate(w, hspDomain(177), buildMandate({ signer: w.address, recipient: w.address, token: w.address, amount: 1n, chainId: 177, deadline: 2_000_000_000 }));
  await assert.rejects(c.register("hashkey", m), /401/);
});
