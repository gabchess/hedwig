import { createHash } from "node:crypto";
import type {
  ConsultAction,
  ConsultRequest,
  EvmCallProposal,
  Policy,
} from "./catalog";
import { decodeMonadNativeSwap } from "./monad-calldata";

/** A call proposal only: nonce, fees, replay protection and execution are outside this receipt. */
export interface CheckedEvmCall {
  readonly action: ConsultAction;
  readonly chainId: string;
  readonly transaction: Readonly<EvmCallProposal>;
  readonly callDigest: string;
}

type CallBinding =
  | { readonly status: "unsupported" | "mismatch" }
  | { readonly status: "bound"; readonly callDigest: string };

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^(0|[1-9]\d{0,77})$/;
// Public ABI widths and character offsets, independent of policy thresholds.
const TRANSFER_LAYOUT = {
  uintLimit: 1n << 256n,
  recipientStart: 34,
  amountStart: 74,
} as const;
const address = (value: unknown): value is string =>
  typeof value === "string" && ADDRESS.test(value) && BigInt(value) > 0n;
const uint = (value: unknown): value is string =>
  typeof value === "string" &&
  UINT.test(value) &&
  BigInt(value) < TRANSFER_LAYOUT.uintLimit;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Pure, bounded binding of supported calldata to the caller's declared action. */
export function bindEvmCall(
  request: ConsultRequest,
  policy?: Policy
): CallBinding {
  const action = request.action;
  const tx = request.transaction;
  if (
    !action ||
    typeof action.chainId !== "string" ||
    !/^eip155:[1-9]\d{0,31}$/.test(action.chainId) ||
    !tx ||
    typeof tx !== "object" ||
    Array.isArray(tx) ||
    Object.keys(tx).sort().join() !== "data,from,to,value" ||
    !address(tx.from) ||
    !address(tx.to) ||
    !uint(tx.value) ||
    typeof tx.data !== "string" ||
    !/^0x(?:[0-9a-fA-F]{2})*$/.test(tx.data)
  )
    return { status: "unsupported" };

  if (action.type === "pay") {
    // transfer(address,uint256): two static ABI words, canonical address padding.
    if (
      !/^0xa9059cbb0{24}[0-9a-f]{40}[0-9a-f]{64}$/i.test(tx.data) ||
      !address(action.target) ||
      !address(action.asset?.contractAddress) ||
      !address(action.recipient) ||
      !uint(action.amount) ||
      policy?.authorizationWindow?.mode === "required"
    )
      return { status: "unsupported" };
    const recipient = `0x${tx.data.slice(
      TRANSFER_LAYOUT.recipientStart,
      TRANSFER_LAYOUT.amountStart
    )}`;
    const amount = BigInt(
      `0x${tx.data.slice(TRANSFER_LAYOUT.amountStart)}`
    ).toString();
    if (
      !same(tx.to, action.target) ||
      !same(tx.to, action.asset.contractAddress) ||
      !same(recipient, action.recipient) ||
      amount !== action.amount ||
      tx.value !== "0"
    )
      return { status: "mismatch" };
  } else if (
    action.type === "swap" &&
    action.chainId === "eip155:143" &&
    action.tokenIn &&
    typeof action.tokenIn === "object" &&
    !Array.isArray(action.tokenIn) &&
    "kind" in action.tokenIn &&
    action.tokenIn.kind === "native"
  ) {
    const decoded = decodeMonadNativeSwap(tx.data);
    if (
      Object.keys(action.tokenIn).sort().join() !== "kind,symbol" ||
      action.tokenIn.symbol !== "MON" ||
      !decoded ||
      !address(action.target) ||
      !address(action.recipient) ||
      !address(action.tokenOut?.contractAddress) ||
      !uint(action.amountIn) ||
      !uint(action.minOut) ||
      !uint(action.approvalAmount) ||
      !Number.isSafeInteger(action.deadline) ||
      (action.deadline as number) <= 0
    )
      return { status: "unsupported" };
    if (
      tx.value !== decoded.amountIn ||
      action.amountIn !== decoded.amountIn ||
      !same(tx.to, "0xfe31f71c1b106eac32f1a19239c9a9a72ddfb900") ||
      !same(tx.to, action.target) ||
      !same(tx.from, decoded.recipient) ||
      !same(action.recipient, decoded.recipient) ||
      !same(action.tokenOut.contractAddress, decoded.tokenOut) ||
      action.minOut !== decoded.amountOutMinimum ||
      String(action.deadline) !== decoded.deadline ||
      action.approvalAmount !== "0"
    )
      return { status: "mismatch" };
  } else {
    return { status: "unsupported" };
  }

  const encoded = JSON.stringify([
    "hedwig:evm-call:v1",
    action.chainId,
    tx.from.toLowerCase(),
    tx.to.toLowerCase(),
    tx.value,
    tx.data.toLowerCase(),
  ]);
  return {
    status: "bound",
    callDigest: `sha256:${createHash("sha256").update(encoded).digest("hex")}`,
  };
}
