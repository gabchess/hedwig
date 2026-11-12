import { expect } from "chai";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const budget = require("./live-eval-budget.js");
const helper = resolve(__dirname, "live-eval-budget.js");
const endpoint = "https://openrouter.ai/api/v1/chat/completions";
const catalog = {
  id: "openai/gpt-4.1-mini",
  context_length: 1047576,
  top_provider: { max_completion_tokens: 32768 },
  pricing: { prompt: "0.0000004", completion: "0.0000016" },
};
const plan = budget.createBudgetPlan(catalog, catalog.id, 1);
const body = {
  model: catalog.id,
  stream: false,
  temperature: 0,
  max_tokens: 2048,
  provider: {
    require_parameters: true,
    allow_fallbacks: false,
    data_collection: "deny",
    zdr: true,
  },
  messages: [{ role: "user", content: "Public fixture question." }],
  response_format: { type: "json_schema", json_schema: {} },
};
const request = { method: "POST", body: JSON.stringify(body) };
const sha256 = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");
function saveLedgerFixture(filename: string, value: any) {
  const canonical = (item: any): any =>
    Array.isArray(item)
      ? item.map(canonical)
      : item && typeof item === "object"
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, canonical(item[key])])
        )
      : item;
  const { integrity: _integrity, ...content } = value;
  writeFileSync(
    filename,
    JSON.stringify({
      ...content,
      integrity: sha256(JSON.stringify(canonical(content))),
    })
  );
}
function expectations(filename: string) {
  const ledger = JSON.parse(readFileSync(filename, "utf8"));
  const lock = readFileSync(`${filename}.lock`, "utf8");
  const owner = lock.trim().startsWith("{")
    ? JSON.parse(lock).pid
    : Number(lock.trim());
  return {
    expectedLedgerIntegrity: ledger.integrity,
    expectedEntryId: ledger.entries[ledger.entries.length - 1].id,
    expectedLockSha256: sha256(lock),
    expectedOwnerPid: owner,
  };
}
function crashAfterReservation(filename: string) {
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `
    const budget = require(process.argv[1]);
    const guarded = budget.installBudgetGuard({
      ledgerPath: process.argv[2], plan: JSON.parse(process.argv[3]),
      fetch: async () => { process.exit(0); }
    });
    guarded(${JSON.stringify(
      endpoint
    )}, JSON.parse(process.argv[4])).catch(() => process.exit(1));
  `,
      helper,
      filename,
      JSON.stringify(plan),
      JSON.stringify(request),
    ],
    { encoding: "utf8" }
  );
  expect(child.status, child.stderr).to.equal(0);
  expect(existsSync(`${filename}.lock`)).to.equal(true);
}
async function settle(filename: string, cost = 0.1, receipt = {}) {
  return budget.installBudgetGuard({
    ledgerPath: filename,
    plan,
    fetch: async () =>
      new Response(JSON.stringify({ usage: { cost }, ...receipt })),
  })(endpoint, request);
}

describe("explicit conservative budget crash recovery", () => {
  let directory: string;
  let ledgerPath: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "hedwig-budget-recovery-"));
    ledgerPath = join(directory, "ledger.json");
    budget.initializeBudgetLedger(ledgerPath, plan);
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("retains the entire unknown charge, preserves original bytes and admits only the remainder", async () => {
    await settle(ledgerPath);
    crashAfterReservation(ledgerPath);
    const before = readFileSync(ledgerPath);
    const lockBefore = readFileSync(`${ledgerPath}.lock`);
    const result = budget.recoverInterruptedReservation(
      ledgerPath,
      plan,
      expectations(ledgerPath)
    );
    expect(
      readFileSync(join(result.auditDirectory, "ledger.before.json"))
    ).to.deep.equal(before);
    expect(
      readFileSync(join(result.auditDirectory, "ledger.lock.before"))
    ).to.deep.equal(lockBefore);
    const after = JSON.parse(readFileSync(ledgerPath, "utf8"));
    const original = JSON.parse(before.toString("utf8"));
    expect(after.planHistory).to.deep.equal(original.planHistory);
    expect(after.entries[0]).to.deep.equal(original.entries[0]);
    expect(after.entries[1]).to.include({
      status: "uncertain",
      reservedNanoUsd: 422307200,
    });
    expect(after.entries[1]).not.to.have.property("costNanoUsd");
    expect(after.entries[1].recovery.disposition).to.equal(
      "full_reservation_accounted"
    );
    expect(result.summary).to.include({
      spentUsd: 0.1,
      reservedUsd: 0.4223072,
      recoveredReservedUsd: 0.4223072,
      remainingUsd: 0.4776928,
      blocked: false,
      requestCount: 2,
    });
    await settle(ledgerPath);
    const summary = budget.readBudgetSummary(ledgerPath, plan);
    expect(summary).to.include({
      spentUsd: 0.2,
      recoveredReservedUsd: 0.4223072,
      remainingUsd: 0.3776928,
      requestCount: 3,
    });
    let calls = 0;
    let error: unknown;
    try {
      await budget.installBudgetGuard({
        ledgerPath,
        plan,
        fetch: async () => {
          calls++;
          return new Response();
        },
      })(endpoint, request);
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).to.contain("cap_exhausted");
    expect(calls).to.equal(0);
    expect(
      budget.initializeBudgetLedger(ledgerPath, plan).remainingUsd
    ).to.equal(0.3776928);
    const recoveredBytes = readFileSync(ledgerPath);
    expect(() =>
      budget.recoverInterruptedReservation(ledgerPath, plan, {
        expectedLedgerIntegrity: original.integrity,
        expectedEntryId: original.entries[1].id,
        expectedLockSha256: sha256(lockBefore),
        expectedOwnerPid: JSON.parse(lockBefore.toString("utf8")).pid,
      })
    ).to.throw();
    expect(readFileSync(ledgerPath)).to.deep.equal(recoveredBytes);
    // Historical helpers continue treating every non-settled entry as blocking.
    expect(
      after.entries.some(
        (entry: { status: string }) => entry.status !== "settled"
      )
    ).to.equal(true);
  });

  it("requires the exact reviewed ledger, reservation, lock and dead owner", () => {
    crashAfterReservation(ledgerPath);
    const expected = expectations(ledgerPath);
    const original = readFileSync(ledgerPath);
    const originalLock = readFileSync(`${ledgerPath}.lock`);
    for (const change of [
      { expectedLedgerIntegrity: "0".repeat(64) },
      { expectedEntryId: "wrong-entry" },
      { expectedLockSha256: "0".repeat(64) },
      { expectedOwnerPid: process.pid },
    ]) {
      expect(() =>
        budget.recoverInterruptedReservation(ledgerPath, plan, {
          ...expected,
          ...change,
        })
      ).to.throw();
      expect(readFileSync(ledgerPath)).to.deep.equal(original);
      expect(readFileSync(`${ledgerPath}.lock`)).to.deep.equal(originalLock);
    }
    writeFileSync(`${ledgerPath}.lock`, String(process.pid));
    expect(() =>
      budget.recoverInterruptedReservation(
        ledgerPath,
        plan,
        expectations(ledgerPath)
      )
    ).to.throw("owner_not_confirmed_dead");
    const originalKill = process.kill;
    try {
      process.kill = (() => {
        const error = new Error("denied") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }) as typeof process.kill;
      expect(() =>
        budget.recoverInterruptedReservation(
          ledgerPath,
          plan,
          expectations(ledgerPath)
        )
      ).to.throw("owner_not_confirmed_dead");
    } finally {
      process.kill = originalKill;
    }
    expect(readFileSync(ledgerPath)).to.deep.equal(original);
  });

  it("recovers legacy PID-only locks without replacing a version-one ledger", () => {
    const legacy = JSON.parse(readFileSync(ledgerPath, "utf8"));
    legacy.schemaVersion = 1;
    delete legacy.planHistory;
    saveLedgerFixture(ledgerPath, legacy);
    crashAfterReservation(ledgerPath);
    const owner = expectations(ledgerPath).expectedOwnerPid;
    writeFileSync(`${ledgerPath}.lock`, String(owner));
    budget.recoverInterruptedReservation(
      ledgerPath,
      plan,
      expectations(ledgerPath)
    );
    const recovered = JSON.parse(readFileSync(ledgerPath, "utf8"));
    expect(recovered.schemaVersion).to.equal(1);
    expect(recovered).not.to.have.property("planHistory");
    expect(recovered.entries[0]).not.to.have.property("planHash");
    expect(recovered.entries[0]).not.to.have.property("costNanoUsd");
    expect(budget.readBudgetSummary(ledgerPath, plan).reservedUsd).to.equal(
      0.4223072
    );
    const amended = budget.createBudgetPlan(
      { ...catalog, id: "openai/gpt-4.1" },
      "openai/gpt-4.1",
      1
    );
    expect(budget.amendBudgetPlan(ledgerPath, plan, amended)).to.include({
      reservedUsd: 0.4223072,
      recoveredReservedUsd: 0.4223072,
      remainingUsd: 0.5776928,
    });
    const upgraded = JSON.parse(readFileSync(ledgerPath, "utf8"));
    expect(upgraded.entries[0].recovery).to.deep.equal(
      recovered.entries[0].recovery
    );
    expect(upgraded.entries[0].planHash).to.equal(plan.planHash);
  });

  it("blocks competing recovery and normal writers while the recovery gate is held", async () => {
    crashAfterReservation(ledgerPath);
    const original = readFileSync(ledgerPath);
    writeFileSync(`${ledgerPath}.recovery.lock`, "competing-recovery", {
      flag: "wx",
    });
    expect(() =>
      budget.recoverInterruptedReservation(
        ledgerPath,
        plan,
        expectations(ledgerPath)
      )
    ).to.throw("ledger_busy");
    expect(() => budget.initializeBudgetLedger(ledgerPath, plan)).to.throw(
      "ledger_busy"
    );
    expect(readFileSync(ledgerPath)).to.deep.equal(original);
  });

  it("serializes a second process's recovery before either can move the stale lock", () => {
    crashAfterReservation(ledgerPath);
    const expected = expectations(ledgerPath);
    const fsModule = require("node:fs");
    const rename = fsModule.renameSync;
    let competitorStatus: number | null = null;
    try {
      fsModule.renameSync = (from: string, to: string) => {
        if (from === `${ledgerPath}.lock`) {
          const competitor = spawnSync(
            process.execPath,
            [
              "-e",
              `
            try { require(process.argv[1]).recoverInterruptedReservation(process.argv[2], JSON.parse(process.argv[3]), JSON.parse(process.argv[4])); process.exit(2); }
            catch (error) { process.exit(error.message.includes('ledger_busy') ? 0 : 3); }
          `,
              helper,
              ledgerPath,
              JSON.stringify(plan),
              JSON.stringify(expected),
            ],
            { encoding: "utf8" }
          );
          competitorStatus = competitor.status;
        }
        return rename(from, to);
      };
      const result = budget.recoverInterruptedReservation(
        ledgerPath,
        plan,
        expected
      );
      expect(result.summary.recoveredReservedUsd).to.equal(0.4223072);
    } finally {
      fsModule.renameSync = rename;
    }
    expect(competitorStatus).to.equal(0);
  });

  it("never removes a competing writer's lock if it loses the takeover gap", () => {
    crashAfterReservation(ledgerPath);
    const expected = expectations(ledgerPath);
    const before = readFileSync(ledgerPath);
    const competingLock = JSON.stringify({
      pid: process.pid,
      nonce: "competing-owner",
    });
    const fsModule = require("node:fs");
    const rename = fsModule.renameSync;
    try {
      fsModule.renameSync = (from: string, to: string) => {
        rename(from, to);
        if (from === `${ledgerPath}.lock`)
          writeFileSync(from, competingLock, { flag: "wx" });
      };
      expect(() =>
        budget.recoverInterruptedReservation(ledgerPath, plan, expected)
      ).to.throw("ledger_busy");
    } finally {
      fsModule.renameSync = rename;
    }
    expect(readFileSync(`${ledgerPath}.lock`, "utf8")).to.equal(competingLock);
    expect(readFileSync(ledgerPath)).to.deep.equal(before);
  });

  for (const stage of ["lock-renamed", "ledger-committed"]) {
    it(`fails closed if recovery itself stops after ${stage}`, async () => {
      crashAfterReservation(ledgerPath);
      const child = spawnSync(
        process.execPath,
        [
          "-e",
          `
        const fs = require('node:fs'); const rename = fs.renameSync;
        fs.renameSync = (from,to) => {
          rename(from,to);
          if ((process.argv[5] === 'lock-renamed' && from === process.argv[2] + '.lock') ||
              (process.argv[5] === 'ledger-committed' && to === process.argv[2])) process.exit(0);
        };
        require(process.argv[1]).recoverInterruptedReservation(process.argv[2], JSON.parse(process.argv[3]), JSON.parse(process.argv[4]));
        process.exit(2);
      `,
          helper,
          ledgerPath,
          JSON.stringify(plan),
          JSON.stringify(expectations(ledgerPath)),
          stage,
        ],
        { encoding: "utf8" }
      );
      expect(child.status, child.stderr).to.equal(0);
      const summary = budget.readBudgetSummary(ledgerPath, plan);
      expect(summary.reservedUsd).to.equal(0.4223072);
      expect(summary.remainingUsd).to.equal(0.5776928);
      let calls = 0;
      let error: unknown;
      try {
        await budget.installBudgetGuard({
          ledgerPath,
          plan,
          fetch: async () => {
            calls++;
            return new Response();
          },
        })(endpoint, request);
      } catch (caught) {
        error = caught;
      }
      expect(String(error)).to.contain("ledger_busy");
      expect(calls).to.equal(0);
    });
  }

  it("rejects malformed recovery accounting even with a recomputed checksum", () => {
    crashAfterReservation(ledgerPath);
    budget.recoverInterruptedReservation(
      ledgerPath,
      plan,
      expectations(ledgerPath)
    );
    const good = JSON.parse(readFileSync(ledgerPath, "utf8"));
    for (const change of [
      { entryId: "different-entry" },
      { reservedNanoUsd: 0 },
      { recoveredAt: "invalid-date" },
      { ownerPid: 0 },
      { disposition: "cost_verified" },
      { recoveryId: [good.entries[0].recovery.recoveryId] },
    ]) {
      const corrupted = JSON.parse(JSON.stringify(good));
      Object.assign(corrupted.entries[0].recovery, change);
      saveLedgerFixture(ledgerPath, corrupted);
      expect(() => budget.readBudgetSummary(ledgerPath, plan)).to.throw(
        "invalid_ledger"
      );
    }
  });

  it("retains bounded generation metadata prospectively without provider content", async () => {
    await settle(ledgerPath, 0.1, {
      id: "gen-fixture_123",
      created: 1800000000,
      private: "PRIVATE_PROVIDER_BODY",
    });
    const entry = JSON.parse(readFileSync(ledgerPath, "utf8")).entries[0];
    expect(entry.generationId).to.equal("gen-fixture_123");
    expect(entry.providerCreatedAt).to.equal("2027-01-15T08:00:00.000Z");
    for (const key of ["requestedAt", "responseReceivedAt", "completedAt"])
      expect(new Date(entry[key]).toISOString()).to.equal(entry[key]);
    expect(readFileSync(ledgerPath, "utf8")).not.to.contain(
      "PRIVATE_PROVIDER_BODY"
    );
    await settle(ledgerPath, 0, {
      id: "PRIVATE\nPROVIDER_ID",
      created: "1800000000",
    });
    const invalid = JSON.parse(readFileSync(ledgerPath, "utf8")).entries[1];
    expect(invalid).not.to.have.property("generationId");
    expect(invalid).not.to.have.property("providerCreatedAt");
  });

  it("retains a generation reference when cost is absent without inventing a settlement", async () => {
    await budget.installBudgetGuard({
      ledgerPath,
      plan,
      fetch: async () =>
        new Response(JSON.stringify({ id: "gen-unverified", usage: {} })),
    })(endpoint, request);
    const entry = JSON.parse(readFileSync(ledgerPath, "utf8")).entries[0];
    expect(entry).to.include({
      status: "uncertain",
      generationId: "gen-unverified",
    });
    expect(entry).not.to.have.property("costNanoUsd");
    expect(entry).not.to.have.property("recovery");
    expect(budget.readBudgetSummary(ledgerPath, plan)).to.include({
      blocked: true,
      reservedUsd: 0.4223072,
      recoveredReservedUsd: 0,
    });
  });

  it("never unlinks a replacement lock during ordinary guard cleanup", async () => {
    const replacement = JSON.stringify({
      pid: process.pid,
      nonce: "replacement-owner",
    });
    let error: unknown;
    try {
      await budget.installBudgetGuard({
        ledgerPath,
        plan,
        fetch: async () => {
          writeFileSync(`${ledgerPath}.lock`, replacement);
          return new Response(JSON.stringify({ usage: { cost: 0.01 } }));
        },
      })(endpoint, request);
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).to.contain("lock_identity_changed");
    expect(readFileSync(`${ledgerPath}.lock`, "utf8")).to.equal(replacement);
    expect(budget.readBudgetSummary(ledgerPath, plan).spentUsd).to.equal(0.01);
  });
});
