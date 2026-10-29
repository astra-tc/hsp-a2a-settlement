import { test } from "node:test";
import assert from "node:assert/strict";
import { SpendGuard } from "../src/hsp/spendGuard.ts";

const payee = "0x000000000000000000000000000000000000bEEF", tok = "0x054ed45810DbBAb8B27668922D110669c9D88D0a";
const mk = (now = () => 1_000_000_000) => new SpendGuard({ maxPerPayment: 100n, maxPerDay: 150n, allowedPayees: [payee], allowedTokens: [tok], chainId: 177 }, now);

test("allows an in-policy payment", () => { mk().check({ payTo: payee, asset: tok, amount: 100n, chainId: 177 }); });
test("blocks over per-payment cap", () => assert.throws(() => mk().check({ payTo: payee, asset: tok, amount: 101n, chainId: 177 }), /per-payment/));
test("blocks unknown payee, token and chain", () => {
  const g = mk();
  assert.throws(() => g.check({ payTo: "0x000000000000000000000000000000000000dEaD", asset: tok, amount: 1n, chainId: 177 }), /allowlist/);
  assert.throws(() => g.check({ payTo: payee, asset: payee, amount: 1n, chainId: 177 }), /token/);
  assert.throws(() => g.check({ payTo: payee, asset: tok, amount: 1n, chainId: 1 }), /chain/);
});
test("daily cap rolls over after 24h", () => {
  let t = 1_000_000_000; const g = mk(() => t);
  g.record(100n);
  assert.throws(() => g.check({ payTo: payee, asset: tok, amount: 60n, chainId: 177 }), /daily/);
  t += 86_400_001;
  g.check({ payTo: payee, asset: tok, amount: 60n, chainId: 177 });
});
