/** HTTP 402 payment requirements (x402 v2 shape) using an HSP mandate as the scheme. */
export interface HspRequirement {
  scheme: "hsp-mandate";
  network: string;        // CAIP-2, e.g. eip155:177
  asset: string;          // USDC token
  payTo: string;          // seller agent address
  amount: string;         // base units
  resource: string;
  quoteId: string;        // nonce of the mandate must be keccak256("astra-a2a:"+quoteId)
  expiresAt: number;
  extra: { hspChain: string; verifyingContract: string; registry?: string };
}
export interface PaymentRequired { x402Version: 2; error: string; accepts: HspRequirement[] }
export interface PaymentProof { quoteId: string; paymentId: string; txHash: string; mandate: import("../hsp/mandate.ts").SignedMandate }
export const PAYMENT_HEADER = "x-hsp-payment";
export const RECEIPT_HEADER = "x-hsp-receipt";
export const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
export const dec = <T>(s: string): T => JSON.parse(Buffer.from(s, "base64").toString("utf8")) as T;
