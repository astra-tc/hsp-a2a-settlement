/**
 * Buyer agent: calls a paid agent endpoint. On 402 it checks the SpendGuard,
 * signs an HSP mandate bound to the quote, registers it with the Coordinator,
 * pays with a plain USDC transfer from its own wallet (zero-custody), then
 * retries with the payment proof.
 */
import { ethers } from "ethers";
import { buildMandate, nonceForQuote, signMandate, hspDomain } from "../hsp/mandate.ts";
import type { Coordinator } from "../hsp/coordinator.ts";
import type { SpendGuard } from "../hsp/spendGuard.ts";
import { enc, PAYMENT_HEADER, type PaymentRequired, type PaymentProof } from "./protocol.ts";

const ERC20 = ["function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"];

export interface BuyerDeps { wallet: ethers.Wallet; coordinator: Coordinator; guard: SpendGuard; confirmations?: number; log?: (s: string) => void }

export async function callPaidAgent(url: string, body: unknown, d: BuyerDeps) {
  const log = d.log ?? (() => {});
  const post = (headers: Record<string, string> = {}) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const first = await post();
  if (first.status !== 402) return { status: first.status, body: await first.json() };
  const pr = (await first.json()) as PaymentRequired;
  const req = pr.accepts.find((a) => a.scheme === "hsp-mandate");
  if (!req) throw new Error("seller offers no HSP payment option");
  const chainId = Number(req.network.split(":")[1]);
  const amount = BigInt(req.amount);
  log(`402 received: ${req.amount} base units of ${req.asset} to ${req.payTo} (quote ${req.quoteId})`);
  d.guard.check({ payTo: req.payTo, asset: req.asset, amount, chainId });
  log("SpendGuard: allowed");

  const domain = hspDomain(chainId, req.extra.verifyingContract);
  const deadline = Math.min(req.expiresAt, Math.floor(Date.now() / 1000) + 600);
  const body0 = buildMandate({ signer: d.wallet.address, recipient: req.payTo, token: req.asset, amount, chainId, deadline, nonce: nonceForQuote(req.quoteId) });
  const mandate = await signMandate(d.wallet, domain, body0);
  const paymentId = await d.coordinator.register(req.extra.hspChain, mandate);
  log(`HSP mandate registered: paymentId ${paymentId}`);

  const usdc = new ethers.Contract(req.asset, ERC20, d.wallet);
  const tx = await usdc.transfer(req.payTo, amount);
  await tx.wait(d.confirmations ?? 1);
  d.guard.record(amount);
  log(`USDC transfer confirmed: ${tx.hash}`);

  const proof: PaymentProof = { quoteId: req.quoteId, paymentId, txHash: tx.hash, mandate };
  const paid = await post({ [PAYMENT_HEADER]: enc(proof) });
  return { status: paid.status, body: await paid.json(), paymentId, txHash: tx.hash as string };
}
