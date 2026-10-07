import { expect } from "chai";
import { decodeMonadNativeSwap } from "../src/monad-calldata";
import fixture from "./fixtures/monad-router02.json";
const { outputAddress, ...fields } = fixture.expected;
const expected = { ...fields, tokenOut: outputAddress };

// Byte offsets include the outer selector. Only the cast-generated fixture is
// canonical; these helpers create hostile mutations, not an alternate encoder.
const replace = (start: number, bytes: number, hex: string) =>
  fixture.data.slice(0, 2 + start * 2) +
  hex +
  fixture.data.slice(2 + (start + bytes) * 2);
const word = (start: number, value: bigint | number) =>
  replace(start, 32, BigInt(value).toString(16).padStart(64, "0"));

describe("Monad native route calldata (synthetic, no chain reads)", () => {
  it("decodes the independent cast fixture without inventing policy authority", () => {
    const result = decodeMonadNativeSwap(fixture.data);
    expect(result).to.deep.equal(expected);
    expect(Object.isFrozen(result)).to.equal(true);
    expect(result).not.to.have.property("proceed");
  });

  it("preserves a changed output for the separate trusted issuer check", () => {
    const output = "77".repeat(20);
    const result = decodeMonadNativeSwap(replace(244, 20, output));
    expect(result).to.deep.equal({
      ...expected,
      tokenOut: `0x${output}`,
    });
  });

  for (const [name, input] of [
    ["outer selector", replace(0, 4, "ac9650d8")],
    ["array offset", word(36, 96)],
    ["array size", word(68, 3)],
    ["overlapping first element", word(100, 32)],
    ["overlapping second element", word(132, 64)],
    ["first byte length", word(164, 227)],
    ["unknown inner call", replace(196, 4, "deadbeef")],
    ["first call padding", replace(424, 1, "01")],
    ["refund byte length", word(452, 32)],
    ["missing refund selector", replace(484, 4, "00000000")],
    ["refund padding", replace(488, 1, "01")],
    ["dirty token-in padding", replace(200, 1, "01")],
    ["dirty token-out padding", replace(232, 1, "01")],
    ["dirty recipient padding", replace(296, 1, "01")],
    ["different wrapped input", word(200, 7)],
    ["zero output", word(232, 0)],
    ["fee wider than uint24", word(264, 1n << 24n)],
    ["zero recipient", word(296, 0)],
    ["sender sentinel", word(296, 1)],
    ["router sentinel", word(296, 2)],
    ["zero input", word(328, 0)],
    ["signed input overflow", word(328, 1n << 255n)],
    ["zero minimum", word(360, 0)],
    ["nonzero price limit", word(392, 1)],
    ["zero deadline", word(4, 0)],
    ["trailing bytes", fixture.data + "00"],
    ["truncated call", fixture.data.slice(0, -2)],
    ["odd hex", fixture.data.slice(0, -1)],
    ["non-hex", fixture.data.slice(0, -1) + "z"],
    ["oversized", "0x" + "ff".repeat(20_000)],
    ["empty", "0x"],
    ["absent", undefined],
    ["object", { data: fixture.data }],
  ] as const) {
    it(`refuses ${name}`, () => {
      expect(decodeMonadNativeSwap(input)).to.equal(null);
    });
  }

  it("preserves large integers exactly and leaves freshness to the evidence check", () => {
    expect(
      decodeMonadNativeSwap(word(328, (1n << 255n) - 1n))?.amountIn
    ).to.equal(((1n << 255n) - 1n).toString());
    expect(
      decodeMonadNativeSwap(word(360, (1n << 256n) - 1n))?.amountOutMinimum
    ).to.equal(((1n << 256n) - 1n).toString());
    expect(decodeMonadNativeSwap(word(4, 1))?.deadline).to.equal("1");
    expect(
      decodeMonadNativeSwap(fixture.data.toUpperCase().replace("0X", "0x"))
    ).to.deep.equal(expected);
  });
});
