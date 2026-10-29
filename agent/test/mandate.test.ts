import { test } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { buildMandate, signMandate, verifyMandate, paymentIdOf, hspDomain, nonceForQuote, decodeAddress, profileIdHash } from "../src/hsp/mandate.ts";

const w = new ethers.Wallet("0x" + "11".repeat(32));
const USDC = "0x054ed45810DbBAb8B27668922D110669c9D88D0a";
const base = { signer: w.address, recipient: "0x000000000000000000000000000000000000bEEF", token: USDC, amount: 10_000n, chainId: 177, deadline: 2_000_000_000, nonce: nonceForQuote("q1") };

test("mandate encodes signer/recipient as ABI address payloads and EOA profile", () => {
  const b = buildMandate(base);
  assert.equal(decodeAddress(b.signer.payload), w.address);
  assert.equal(b.signer.payload.length, 66);
  assert.equal(b.signer.profileId, ethers.keccak256(ethers.toUtf8Bytes("eip712-eoa.v1")));
  assert.equal(b.signer.profileId, profileIdHash());
  assert.equal(b.requiredCapabilitiesHash, ethers.ZeroHash);
});

test("paymentId is deterministic and changes when any field changes", () => {
  const a = paymentIdOf(buildMandate(base));
  assert.equal(a, paymentIdOf(buildMandate(base)));
  assert.notEqual(a, paymentIdOf(buildMandate({ ...base, amount: 10_001n })));
  assert.notEqual(a, paymentIdOf(buildMandate({ ...base, nonce: nonceForQuote("q2") })));
});

test("signature verifies and tampering is detected", async () => {
  const d = hspDomain(177);
  const m = await signMandate(w, d, buildMandate(base));
  assert.equal(verifyMandate(d, m), w.address);
  assert.throws(() => verifyMandate(d, { ...m, body: { ...m.body, amount: "999999" } }), /mismatch/);
  assert.throws(() => verifyMandate(hspDomain(133), m), /mismatch/);
});

test("zero amount is rejected", () => {
  assert.throws(() => buildMandate({ ...base, amount: 0n }), /amount/);
});
