import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ethers } from "ethers";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../contracts/out");
export function artifact(file: string, name: string) {
  const j = JSON.parse(readFileSync(path.join(root, file, `${name}.json`), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object as string };
}

// anvil default dev keys (public, test-only)
export const KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
];

export async function startAnvil(port: number): Promise<{ proc: ChildProcess; provider: ethers.JsonRpcProvider }> {
  const bin = process.env.ANVIL_BIN ?? "anvil";
  const proc = spawn(bin, ["--port", String(port), "--chain-id", "31337", "--silent"], { stdio: "ignore" });
  const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${port}`, 31337, { staticNetwork: true, pollingInterval: 100, cacheTimeout: -1 });
  for (let i = 0; i < 100; i++) { try { await provider.getBlockNumber(); return { proc, provider }; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  proc.kill(); throw new Error("anvil did not start (install Foundry or set ANVIL_BIN)");
}

export async function deploy(signer: ethers.Signer, file: string, name: string) {
  const a = artifact(file, name);
  const c = await new ethers.ContractFactory(a.abi, a.bytecode, signer).deploy();
  await c.waitForDeployment();
  return c as unknown as ethers.Contract;
}
