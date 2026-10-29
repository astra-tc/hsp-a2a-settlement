/** Agent-side spending policy, enforced BEFORE any mandate is signed. */
import { ethers } from "ethers";

export interface GuardPolicy { maxPerPayment: bigint; maxPerDay: bigint; allowedPayees: string[]; allowedTokens: string[]; chainId: number }
export class SpendGuard {
  private spent: { at: number; amount: bigint }[] = [];
  constructor(private p: GuardPolicy, private now = () => Date.now()) {}
  spentToday(): bigint { const cut = this.now() - 86_400_000; return this.spent.filter((s) => s.at > cut).reduce((a, s) => a + s.amount, 0n); }
  check(req: { payTo: string; asset: string; amount: bigint; chainId: number }): void {
    const eq = (a: string, b: string) => ethers.getAddress(a) === ethers.getAddress(b);
    if (req.chainId !== this.p.chainId) throw new Error(`guard: chain ${req.chainId} not allowed`);
    if (!this.p.allowedTokens.some((t) => eq(t, req.asset))) throw new Error("guard: token not allowed");
    if (!this.p.allowedPayees.some((t) => eq(t, req.payTo))) throw new Error("guard: payee not on allowlist");
    if (req.amount <= 0n) throw new Error("guard: amount must be > 0");
    if (req.amount > this.p.maxPerPayment) throw new Error(`guard: ${req.amount} exceeds per-payment cap ${this.p.maxPerPayment}`);
    if (this.spentToday() + req.amount > this.p.maxPerDay) throw new Error("guard: daily cap reached");
  }
  record(amount: bigint) { this.spent.push({ at: this.now(), amount }); }
}
