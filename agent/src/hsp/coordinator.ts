/**
 * HSP Coordinator clients.
 *  - HttpCoordinator: the real HSP Coordinator REST API (Bearer API key).
 *      POST /payments                -> register a signed mandate
 *      POST /payments/:id/observe    -> report the transfer tx; 202 = still confirming
 *      GET  /payments/:id            -> payment + receipt
 *  - LocalCoordinator: an offline test double that runs the same checks the
 *    Coordinator performs (signature, Transfer log matches mandate, confirmations)
 *    against any JSON-RPC node. Used by tests and the local demo only.
 */
import { ethers } from "ethers";
import { decodeAddress, paymentIdOf, verifyMandate, type HspDomain, type SignedMandate } from "./mandate.ts";

export interface HspReceipt { paymentId: string; status: "settled"; txHash: string; payer: string; payee: string; token: string; amount: string; blockNumber: number; source: string }
export interface Coordinator {
  register(chain: string, m: SignedMandate): Promise<string>;
  observe(paymentId: string, txHash: string): Promise<HspReceipt>;
}

const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

export class HttpCoordinator implements Coordinator {
  constructor(private baseUrl: string, private apiKey: string, private opts = { attempts: 12, fetch: globalThis.fetch }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }
  private headers() { return { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` }; }
  async register(chain: string, mandate: SignedMandate): Promise<string> {
    const r = await this.opts.fetch(`${this.baseUrl}/payments`, { method: "POST", headers: this.headers(), body: JSON.stringify({ chain, mandate, attestations: [] }) });
    if (r.status !== 200 && r.status !== 201) throw new Error(`HSP POST /payments -> ${r.status}: ${await r.text()}`);
    const j = (await r.json().catch(() => ({}))) as { paymentId?: string; id?: string };
    return j.paymentId ?? j.id ?? paymentIdOf(mandate.body);
  }
  async observe(paymentId: string, txHash: string): Promise<HspReceipt> {
    for (let i = 1; i <= this.opts.attempts; i++) {
      const r = await this.opts.fetch(`${this.baseUrl}/payments/${paymentId}/observe`, { method: "POST", headers: this.headers(), body: JSON.stringify({ txHash }) });
      if (r.status === 200) {
        const j = (await r.json()) as Record<string, unknown>;
        return { paymentId, status: "settled", txHash, payer: String(j.payer ?? ""), payee: String(j.payee ?? ""), token: String(j.token ?? ""), amount: String(j.amount ?? ""), blockNumber: Number(j.blockNumber ?? 0), source: "hsp-coordinator" };
      }
      if (r.status !== 202) throw new Error(`HSP observe -> ${r.status}: ${await r.text()}`);
      await new Promise((res) => setTimeout(res, Math.min(1500 * i, 8000)));
    }
    throw new Error(`HSP observe for ${paymentId} not settled in time`);
  }
}

export class LocalCoordinator implements Coordinator {
  private payments = new Map<string, SignedMandate>();
  constructor(private provider: ethers.Provider, private domain: HspDomain, private confirmations = 1) {}
  async register(_chain: string, m: SignedMandate): Promise<string> {
    verifyMandate(this.domain, m);
    if (Number(m.body.chainId) !== this.domain.chainId) throw new Error("wrong chain");
    if (m.body.deadline < Math.floor(Date.now() / 1000)) throw new Error("mandate expired");
    const id = paymentIdOf(m.body);
    if (this.payments.has(id)) throw new Error("duplicate mandate");
    this.payments.set(id, m);
    return id;
  }
  async observe(paymentId: string, txHash: string): Promise<HspReceipt> {
    const m = this.payments.get(paymentId);
    if (!m) throw new Error("unknown paymentId");
    const rc = await this.provider.getTransactionReceipt(txHash);
    if (!rc || rc.status !== 1) throw new Error("transfer not confirmed");
    const head = await this.provider.getBlockNumber();
    if (head - rc.blockNumber + 1 < this.confirmations) throw new Error("not enough confirmations");
    const payer = decodeAddress(m.body.signer.payload), payee = decodeAddress(m.body.recipient.payload);
    const ok = rc.logs.some((l) => l.address.toLowerCase() === m.body.token.toLowerCase() && l.topics[0] === TRANSFER_TOPIC &&
      ethers.getAddress("0x" + l.topics[1].slice(26)) === payer && ethers.getAddress("0x" + l.topics[2].slice(26)) === payee &&
      BigInt(l.data) >= BigInt(m.body.amount));
    if (!ok) throw new Error("no Transfer log matching the mandate");
    return { paymentId, status: "settled", txHash, payer, payee, token: m.body.token, amount: m.body.amount, blockNumber: rc.blockNumber, source: "local-verifier" };
  }
}
