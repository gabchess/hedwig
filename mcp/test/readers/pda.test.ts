import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "chai";

import { findProgramAddress, isOnCurve } from "../../src/readers/pda";
import {
  decodeBase58PublicKey,
  encodeBase58PublicKey,
} from "../../src/readers/wire";

interface Oracle {
  programId: string;
  pda: Array<{ role: string; holder: string; address: string; bump: number }>;
  onCurve: Array<{ bytes: string; onCurve: boolean }>;
}

const ORACLE: Oracle = JSON.parse(
  readFileSync(
    join(__dirname, "..", "fixtures", "solana-role", "pda-oracle.json"),
    "utf8"
  )
);

describe("readers/pda: findProgramAddress against 2000 reference vectors", () => {
  it("matches address and bump for every vector", () => {
    const programId = decodeBase58PublicKey(ORACLE.programId)!;
    let checked = 0;

    ORACLE.pda.forEach((vector) => {
      const role = decodeBase58PublicKey(vector.role)!;
      const holder = decodeBase58PublicKey(vector.holder)!;
      const found = findProgramAddress(
        [Buffer.from("member"), role, holder],
        programId
      );

      expect(found, `vector ${checked}`).to.not.equal(undefined);
      expect(found!.bump, `vector ${checked} bump`).to.equal(vector.bump);
      expect(
        encodeBase58PublicKey(found!.address),
        `vector ${checked} address`
      ).to.equal(vector.address);
      checked++;
    });

    expect(checked).to.equal(2000);
  });
});

describe("readers/pda: isOnCurve against 2000 reference vectors", () => {
  it("matches the reference library on every vector, both answers present", () => {
    let onCurveCount = 0;
    let offCurveCount = 0;

    ORACLE.onCurve.forEach((vector, index) => {
      const bytes = Buffer.from(vector.bytes, "base64");
      expect(isOnCurve(bytes), `vector ${index}`).to.equal(vector.onCurve);
      if (vector.onCurve) {
        onCurveCount++;
      } else {
        offCurveCount++;
      }
    });

    expect(ORACLE.onCurve).to.have.length(2000);
    expect(onCurveCount).to.be.greaterThan(0);
    expect(offCurveCount).to.be.greaterThan(0);
  });

  it("rejects a buffer that is not 32 bytes", () => {
    expect(isOnCurve(Buffer.alloc(31))).to.equal(false);
    expect(isOnCurve(Buffer.alloc(33))).to.equal(false);
  });
});
