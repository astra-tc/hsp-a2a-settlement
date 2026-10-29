/**
 * HSP v1 Mandate: build, EIP-712 sign, hash and verify.
 *
 * Wire format follows the public HSP v1 Mandate used by the HashKey Settlement
 * Protocol Coordinator: domain {name:"HSP", version:"1", chainId, verifyingContract},
 * an EOA signer profile "eip712-eoa.v1", ABI-encoded address payloads and a
 * requiredCapabilities hash (zero for a public payment).
 */
import { ethers } from "ethers";

export const ZERO_BYTES32 = ethers.ZeroHash;
export const EOA_SIGNER_PROFILE = "eip712-eoa.v1";
export const DEFAULT_VERIFYING_CONTRACT = "0x0000000000000000000000000000000000000001";

export const MANDATE_TYPES: Record<string, ethers.TypedDataField[]> = {
  Mandate: [
    { name: "nonce", type: "bytes32" },
    { name: "signer", type: "Signer" },
    { name: "grantRef", type: "bytes32" },
    { name: "requirementRef", type: "bytes32" },
    { name: "recipient", type: "Recipient" },
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "chainId", type: "uint256" },
    { name: "deadline", type: "uint64" },
    { name: "settlementBinding", type: "bytes32" },
    { name: "requiredCapabilitiesHash", type: "bytes32" },
  ],
  Signer: [
    { name: "profileId", type: "bytes32" },
    { name: "payload", type: "bytes" },
  ],
  Recipient: [
    { name: "kind", type: "uint8" },
    { name: "payload", type: "bytes" },
  ],
};

export interface HspDomain { name: "HSP"; version: "1"; chainId: number; verifyingContract: string }
export interface MandateBody {
  nonce: string;
  signer: { profileId: string; payload: string };
  grantRef: string;
  requirementRef: string;
  recipient: { kind: number; payload: string };
  token: string;
  amount: string;
  chainId: number;
  deadline: number;
  settlementBinding: string;
  requiredCapabilitiesHash: string;
}
export interface SignedMandate { body: MandateBody; signerProof: string; requiredCapabilities: string[] }

const coder = ethers.AbiCoder.defaultAbiCoder();
export const encodeAddress = (a: string) => coder.encode(["address"], [ethers.getAddress(a)]);
export const decodeAddress = (p: string) => ethers.getAddress(coder.decode(["address"], p)[0] as string);
export const profileIdHash = (p = EOA_SIGNER_PROFILE) => ethers.keccak256(ethers.toUtf8Bytes(p));

export function hspDomain(chainId: number, verifyingContract = DEFAULT_VERIFYING_CONTRACT): HspDomain {
  return { name: "HSP", version: "1", chainId, verifyingContract: ethers.getAddress(verifyingContract) };
}

/** A quote id binds a mandate to exactly one seller quote: nonce = keccak256(quoteId). */
export const nonceForQuote = (quoteId: string) => ethers.keccak256(ethers.toUtf8Bytes(`astra-a2a:${quoteId}`));

export function buildMandate(p: {
  signer: string; recipient: string; token: string; amount: bigint; chainId: number; deadline: number; nonce?: string;
}): MandateBody {
  if (p.amount <= 0n) throw new Error("amount must be > 0");
  return {
    nonce: p.nonce ?? ethers.hexlify(ethers.randomBytes(32)),
    signer: { profileId: profileIdHash(), payload: encodeAddress(p.signer) },
    grantRef: ZERO_BYTES32,
    requirementRef: ZERO_BYTES32,
    recipient: { kind: 0, payload: encodeAddress(p.recipient) },
    token: ethers.getAddress(p.token),
    amount: p.amount.toString(),
    chainId: p.chainId,
    deadline: p.deadline,
    settlementBinding: ZERO_BYTES32,
    requiredCapabilitiesHash: ZERO_BYTES32,
  };
}

export async function signMandate(wallet: ethers.Signer, domain: HspDomain, body: MandateBody): Promise<SignedMandate> {
  const signerProof = await wallet.signTypedData(domain, MANDATE_TYPES, body);
  return { body, signerProof, requiredCapabilities: [] };
}

/** paymentId = EIP-712 struct hash of the Mandate (the Coordinator's idempotency key). */
export const paymentIdOf = (body: MandateBody) => ethers.TypedDataEncoder.hashStruct("Mandate", MANDATE_TYPES, body);
export const digestOf = (domain: HspDomain, body: MandateBody) => ethers.TypedDataEncoder.hash(domain, MANDATE_TYPES, body);

/** Recover the signer and check it matches signer.payload. Returns the signer address. */
export function verifyMandate(domain: HspDomain, m: SignedMandate): string {
  const recovered = ethers.verifyTypedData(domain, MANDATE_TYPES, m.body, m.signerProof);
  const claimed = decodeAddress(m.body.signer.payload);
  if (recovered !== claimed) throw new Error(`mandate signer mismatch: recovered ${recovered}, claimed ${claimed}`);
  if (m.body.signer.profileId !== profileIdHash()) throw new Error("unsupported signer profile");
  return recovered;
}
