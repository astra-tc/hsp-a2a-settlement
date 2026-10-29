/**
 * Seller agent: sells a "chain-snapshot" skill to other agents over HTTP.
 * Unpaid request -> 402 + HSP requirement. Paid request -> verify mandate binds
 * to the quote, have HSP confirm settlement, deliver, and anchor the receipt
 * in A2AReceiptRegistry on HashKey Chain.
 */
import http from "node:http";
import { ethers } from "ethers";
import { decodeAddress, nonceForQuote, verifyMandate, type HspDomain } from "../hsp/mandate.ts";
import type { Coordinator, HspReceipt } from "../hsp/coordinator.ts";
import { dec, enc, PAYMENT_HEADER, RECEIPT_HEADER, type PaymentProof, type PaymentRequired, type HspRequirement } from "./protocol.ts";

export const REGISTRY_ABI = [
  "function registerAgent(string name, string endpoint)",
  "function recordSettlement(bytes32 paymentId, address payer, address token, uint256 amount, bytes32 transferTx, bytes32 serviceHash)",
  "function receipts(bytes32) view returns (address payer, address payee, address token, uint256 amount, bytes32 transferTx, bytes32 serviceHash, uint64 recordedAt)",
  "function receiptCount() view returns (uint256)",
];

export interface SellerConfig {
  wallet: ethers.Wallet;           // seller identity + payee (connected to provider)
  provider: ethers.Provider;       // chain the snapshot skill reads
  coordinator: Coordinator;
  domain: HspDomain;
  hspChain: string;                // "hashkey" | "hashkey-testnet" | "local"
  asset: string;
  priceBaseUnits: bigint;
  registry?: string;               // A2AReceiptRegistry address (optional)
  quoteTtlSec?: number;
}

export function createSeller(cfg: SellerConfig) {
  const quotes = new Map<string, HspRequirement>();
  const used = new Set<string>();
  const registry = cfg.registry ? new ethers.Contract(cfg.registry, REGISTRY_ABI, cfg.wallet) : undefined;

  const requirement = (resource: string): HspRequirement => {
    const quoteId = ethers.hexlify(ethers.randomBytes(16));
    const q: HspRequirement = {
      scheme: "hsp-mandate", network: `eip155:${cfg.domain.chainId}`, asset: cfg.asset, payTo: cfg.wallet.address,
      amount: cfg.priceBaseUnits.toString(), resource, quoteId, expiresAt: Math.floor(Date.now() / 1000) + (cfg.quoteTtlSec ?? 600),
      extra: { hspChain: cfg.hspChain, verifyingContract: cfg.domain.verifyingContract, registry: cfg.registry },
    };
    quotes.set(quoteId, q);
    return q;
  };

  async function verifyPayment(proof: PaymentProof): Promise<HspReceipt> {
    const q = quotes.get(proof.quoteId);
    if (!q) throw new Error("unknown or expired quote");
    if (q.expiresAt < Math.floor(Date.now() / 1000)) throw new Error("quote expired");
    if (used.has(proof.paymentId) || used.has(proof.quoteId)) throw new Error("payment already used");
    const b = proof.mandate.body;
    verifyMandate(cfg.domain, proof.mandate);
    if (b.nonce !== nonceForQuote(q.quoteId)) throw new Error("mandate not bound to this quote");
    if (decodeAddress(b.recipient.payload) !== ethers.getAddress(q.payTo)) throw new Error("mandate pays someone else");
    if (ethers.getAddress(b.token) !== ethers.getAddress(q.asset)) throw new Error("wrong token");
    if (BigInt(b.amount) < BigInt(q.amount)) throw new Error("underpaid");
    if (Number(b.chainId) !== cfg.domain.chainId) throw new Error("wrong chain");
    const receipt = await cfg.coordinator.observe(proof.paymentId, proof.txHash);
    if (receipt.status !== "settled") throw new Error("HSP has not settled this payment");
    return receipt;
  }

  async function runSkill() {
    const [block, fee, net] = await Promise.all([cfg.provider.getBlock("latest"), cfg.provider.getFeeData(), cfg.provider.getNetwork()]);
    return { skill: "chain-snapshot", chainId: Number(net.chainId), blockNumber: block?.number, blockTime: block?.timestamp, gasPriceGwei: fee.gasPrice ? ethers.formatUnits(fee.gasPrice, "gwei") : null };
  }

  const card = { name: "Astra Snapshot Seller", provider: "Carl, Astra Trading Co", protocol: "HTTP 402 + HSP mandate", skills: [{ id: "chain-snapshot", price: cfg.priceBaseUnits.toString(), asset: cfg.asset }] };

  const server = http.createServer(async (req, res) => {
    const send = (code: number, body: unknown, headers: Record<string, string> = {}) => { res.writeHead(code, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
    try {
      if (req.method === "GET" && req.url === "/.well-known/agent.json") return send(200, card);
      if (req.method === "POST" && req.url === "/tasks/chain-snapshot") {
        const h = req.headers[PAYMENT_HEADER];
        if (!h) { const pr: PaymentRequired = { x402Version: 2, error: "payment required", accepts: [requirement("/tasks/chain-snapshot")] }; return send(402, pr); }
        const proof = dec<PaymentProof>(String(h));
        let receipt: HspReceipt;
        try { receipt = await verifyPayment(proof); } catch (e) { return send(402, { x402Version: 2, error: (e as Error).message, accepts: [] }); }
        used.add(proof.paymentId); used.add(proof.quoteId); quotes.delete(proof.quoteId);
        const result = await runSkill();
        const serviceHash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(result)));
        let anchorTx: string | undefined;
        if (registry) {
          const tx = await registry.recordSettlement(proof.paymentId, receipt.payer, receipt.token, receipt.amount, ethers.zeroPadValue(receipt.txHash, 32), serviceHash);
          anchorTx = (await tx.wait())?.hash;
        }
        return send(200, { result, serviceHash, receipt, anchorTx }, { [RECEIPT_HEADER]: enc({ ...receipt, anchorTx }) });
      }
      send(404, { error: "not found" });
    } catch (e) { send(500, { error: (e as Error).message }); }
  });
  return { server, verifyPayment, card };
}
