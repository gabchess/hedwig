export type MonadNativeSwap = Readonly<{
  deadline: string;
  tokenIn: string;
  tokenOut: string;
  fee: number;
  recipient: string;
  amountIn: string;
  amountOutMinimum: string;
  sqrtPriceLimitX96: string;
}>;

// Public ABI widths/offsets and Solidity integer bounds, not policy thresholds.
// https://docs.soliditylang.org/en/latest/abi-spec.html
// Offsets include the outer selector; dynamic element offsets exclude array length.
const ROUTER02_LAYOUT = {
  encodedChars: 1034,
  hexCharsPerByte: 2,
  wordBytes: 32,
  addressPadding: 12,
  addressBytes: 20,
  selectorBytes: 4,
  deadline: 4,
  tokenIn: 200,
  tokenOut: 232,
  fee: 264,
  recipient: 296,
  amountIn: 328,
  minimum: 360,
  priceLimit: 392,
  feeLimit: 1n << 24n,
  inputLimit: 1n << 255n,
  lastRecipientSentinel: 2n,
  headWords: [
    [36, 64n],
    [68, 2n],
    [100, 64n],
    [132, 352n],
    [164, 228n],
    [452, 4n],
  ],
  selectors: [
    [0, "5ae401dc"],
    [196, "04e45aaf"],
    [484, "12210e8a"],
  ],
  zeroRanges: [
    [424, 28],
    [488, 28],
    [200, 12],
    [232, 12],
    [296, 12],
  ],
} as const;
const WMON = "0x3bd359c1119da7da1d913d1c4d2b7c461115433a";

/** Decode one canonical Router02 profile. This does not verify a transaction. */
export function decodeMonadNativeSwap(data: unknown): MonadNativeSwap | null {
  // Fixed ABI layout: deadline + bytes[2], holding exactInputSingle and refundETH.
  // Refuse noncanonical offsets/lengths/padding instead of following pointers.
  const layout = ROUTER02_LAYOUT;
  if (
    typeof data !== "string" ||
    data.length !== layout.encodedChars ||
    !/^0x[\da-fA-F]+$/.test(data)
  )
    return null;
  const hex = data.slice(layout.hexCharsPerByte).toLowerCase();
  const bytes = (start: number, count: number) =>
    hex.slice(
      start * layout.hexCharsPerByte,
      (start + count) * layout.hexCharsPerByte
    );
  const uint = (start: number) => BigInt(`0x${bytes(start, layout.wordBytes)}`);
  if (
    layout.headWords.some(([offset, expected]) => uint(offset) !== expected) ||
    layout.selectors.some(
      ([offset, selector]) => bytes(offset, layout.selectorBytes) !== selector
    ) ||
    layout.zeroRanges.some(
      ([offset, size]) =>
        bytes(offset, size) !== "0".repeat(size * layout.hexCharsPerByte)
    )
  )
    return null;

  const address = (start: number) =>
    `0x${bytes(start + layout.addressPadding, layout.addressBytes)}`;
  const tokenIn = address(layout.tokenIn);
  const deadline = uint(layout.deadline);
  const fee = uint(layout.fee);
  const amountIn = uint(layout.amountIn);
  const minimum = uint(layout.minimum);
  if (
    tokenIn !== WMON ||
    uint(layout.tokenOut) === 0n ||
    uint(layout.recipient) <= layout.lastRecipientSentinel ||
    deadline === 0n ||
    fee >= layout.feeLimit ||
    amountIn === 0n ||
    amountIn >= layout.inputLimit ||
    minimum === 0n ||
    uint(layout.priceLimit) !== 0n
  )
    return null;
  return Object.freeze({
    deadline: deadline.toString(),
    tokenIn,
    tokenOut: address(layout.tokenOut),
    fee: Number(fee),
    recipient: address(layout.recipient),
    amountIn: amountIn.toString(),
    amountOutMinimum: minimum.toString(),
    sqrtPriceLimitX96: "0",
  });
}
