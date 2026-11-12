import { expect } from "chai";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
const alternative = {
  id: "qwen/qwen3-235b-a22b-2507",
  context_length: 262144,
  top_provider: { max_completion_tokens: 117964 },
  pricing: { prompt: "0.00000014", completion: "0.0000008" },
};
const rawHash = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");
function canonical(value: any): any {
  return Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
    ? Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, canonical(value[key])])
      )
    : value;
}
const hash = (value: any) => rawHash(JSON.stringify(canonical(value)));
const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
function save(file: string, value: any) {
  const { integrity: ignored, ...content } = value;
  fs.writeFileSync(
    file,
    JSON.stringify({ ...content, integrity: hash(content) })
  );
}
function request(model: string) {
  return {
    method: "POST",
    body: JSON.stringify({
      model,
      stream: false,
      temperature: 0,
      max_tokens: 2048,
      provider: {
        ...(model === alternative.id ? { sort: "throughput" } : {}),
        require_parameters: true,
        allow_fallbacks: false,
        data_collection: "deny",
        zdr: true,
      },
      messages: [{ role: "user", content: "Public fixture." }],
      response_format: { type: "json_schema", json_schema: {} },
    }),
  };
}
function proposal(file: string) {
  const ledger = read(file),
    entry = ledger.entries.at(-1);
  const evidenceJson = JSON.stringify({
    schemaVersion: 1,
    kind: "operator_quarantine_review",
    entryId: entry.id,
    generationId: entry.generationId,
    completedAt: entry.completedAt,
    reviewedAt: new Date().toISOString(),
    chargeStatus: "unverified",
    operatorReference:
      "disposable fixture: completed HTTP 429, final charge unavailable; retain full reservation",
  });
  return {
    quarantineId: randomUUID(),
    expectedLedgerIntegrity: ledger.integrity,
    expectedEntryId: entry.id,
    expectedGenerationId: entry.generationId,
    expectedReservationNanoUsd: entry.reservedNanoUsd,
    evidenceJson,
    expectedEvidenceSha256: rawHash(evidenceJson),
  };
}

describe("operator quarantine of completed requests with unverified charges", () => {
  let directory: string, ledgerPath: string, plan: any;
  beforeEach(async () => {
    directory = fs.mkdtempSync(join(tmpdir(), "hedwig-completed-quarantine-"));
    ledgerPath = join(directory, "ledger.json");
    const initial = budget.createBudgetPlan(catalog, catalog.id, 1);
    budget.initializeBudgetLedger(ledgerPath, initial);
    const ledger = read(ledgerPath);
    ledger.entries.push({
      id: "historical-unknown",
      planHash: initial.planHash,
      maxTokens: 2048,
      reservedNanoUsd: 422307200,
      status: "uncertain",
      recovery: {
        disposition: "full_reservation_accounted",
        recoveryId: randomUUID(),
        entryId: "historical-unknown",
        previousStatus: "reserved",
        previousLedgerIntegrity: "a".repeat(64),
        lockSha256: "b".repeat(64),
        ownerPid: 12345,
        reservedNanoUsd: 422307200,
        recoveredAt: "2026-11-12T18:00:00.000Z",
      },
    });
    save(ledgerPath, ledger);
    const extended = budget.extendBudgetCap(ledgerPath, initial, {
      authorizationId: randomUUID(),
      approvedAt: "2026-11-12T19:00:00.000Z",
      approvalReference: "fixture cap",
      expectedLedgerIntegrity: read(ledgerPath).integrity,
      approvedTotalNanoUsd: 6e9,
    }).plan;
    plan = budget.applyBudgetModelAmendment(ledgerPath, extended, alternative, {
      amendmentId: randomUUID(),
      amendedAt: "2026-11-12T20:00:00.000Z",
      approvalReference: "fixture model",
      expectedLedgerIntegrity: read(ledgerPath).integrity,
      model: alternative.id,
    }).plan;
    await budget.installBudgetGuard({
      ledgerPath,
      plan,
      fetch: async () =>
        new Response(
          JSON.stringify({
            id: "gen-fixture-completed-429",
            error: { message: "fixture rate limit" },
          }),
          { status: 429 }
        ),
    })(endpoint, request(plan.model));
  });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  it("preserves every financial and historical field, retaining unknown cost while allowing only the remainder", async () => {
    const beforeBytes = fs.readFileSync(ledgerPath),
      before = read(ledgerPath);
    const priorSummary = budget.readBudgetSummary(ledgerPath, plan),
      operation = proposal(ledgerPath);
    expect(priorSummary.blocked).to.equal(true);
    expect(fs.existsSync(`${ledgerPath}.lock`)).to.equal(false);
    const result = budget.quarantineCompletedReservation(
      ledgerPath,
      plan,
      operation
    );
    const after = read(ledgerPath),
      { recovery, ...originalEntry } = after.entries.at(-1);
    expect(originalEntry).to.deep.equal(before.entries.at(-1));
    expect(after.entries.slice(0, -1)).to.deep.equal(
      before.entries.slice(0, -1)
    );
    for (const key of [
      "schemaVersion",
      "capNanoUsd",
      "planHash",
      "planHistory",
      "capAuthorizations",
      "modelAmendments",
    ])
      expect(after[key]).to.deep.equal(before[key]);
    expect(result.summary).to.deep.equal({
      ...priorSummary,
      blocked: false,
      recoveredReservedUsd: priorSummary.reservedUsd,
    });
    expect(recovery).to.include({
      kind: "completed_uncertain",
      disposition: "full_reservation_accounted",
      previousStatus: "uncertain",
      originalEntrySha256: hash(originalEntry),
    });
    expect(recovery).not.to.have.property("ownerPid");
    expect(recovery).not.to.have.property("lockSha256");
    expect(
      fs.readFileSync(join(result.auditDirectory, "ledger.before.json"))
    ).to.deep.equal(beforeBytes);
    expect(
      fs.readFileSync(
        join(result.auditDirectory, "operator-evidence.json"),
        "utf8"
      )
    ).to.equal(operation.evidenceJson);
    expect(
      read(join(result.auditDirectory, "quarantine.applied.json")).summary
    ).to.deep.equal(result.summary);
    const child = spawnSync(
      process.execPath,
      [
        "-e",
        "const b=require(process.argv[1]); process.stdout.write(JSON.stringify(b.readBudgetSummary(process.argv[2],JSON.parse(process.argv[3]))));",
        helper,
        ledgerPath,
        JSON.stringify(plan),
      ],
      { encoding: "utf8" }
    );
    expect(child.status, child.stderr).to.equal(0);
    expect(JSON.parse(child.stdout)).to.deep.equal(result.summary);
    const preserved = fs.readFileSync(ledgerPath);
    expect(() =>
      budget.quarantineCompletedReservation(ledgerPath, plan, operation)
    ).to.throw("quarantine_state_changed");
    expect(fs.readFileSync(ledgerPath)).to.deep.equal(preserved);
    await budget.installBudgetGuard({
      ledgerPath,
      plan,
      fetch: async () =>
        new Response(JSON.stringify({ usage: { cost: 0.001 } })),
    })(endpoint, request(plan.model));
    expect(read(ledgerPath).entries.slice(0, -1)).to.deep.equal(after.entries);
    expect(budget.readBudgetSummary(ledgerPath, plan).reservedUsd).to.equal(
      priorSummary.reservedUsd
    );
  });

  it("requires exact reviewed state, full reservation and genuine local completion", () => {
    const bytes = fs.readFileSync(ledgerPath),
      base = proposal(ledgerPath);
    for (const change of [
      { expectedLedgerIntegrity: "0".repeat(64) },
      { expectedEntryId: "wrong" },
      { expectedGenerationId: "gen-other" },
      { expectedReservationNanoUsd: 1 },
      { expectedEvidenceSha256: "0".repeat(64) },
      { quarantineId: "not-a-uuid" },
      { evidenceJson: JSON.stringify({ chargeStatus: "verified_zero" }) },
    ]) {
      expect(() =>
        budget.quarantineCompletedReservation(ledgerPath, plan, {
          ...base,
          ...change,
        })
      ).to.throw();
      expect(fs.readFileSync(ledgerPath)).to.deep.equal(bytes);
      expect(fs.existsSync(`${ledgerPath}.lock`)).to.equal(false);
    }
    for (const mutate of [
      (e: any) => {
        e.status = "reserved";
      },
      (e: any) => {
        delete e.completedAt;
      },
      (e: any) => {
        delete e.generationId;
      },
      (e: any) => {
        e.completedAt = "2000-01-01T00:00:00.000Z";
      },
      (e: any) => {
        e.status = "settled";
        e.costNanoUsd = 0;
      },
    ]) {
      const modified = JSON.parse(bytes.toString());
      mutate(modified.entries.at(-1));
      save(ledgerPath, modified);
      const attempted = fs.readFileSync(ledgerPath);
      expect(() =>
        budget.quarantineCompletedReservation(
          ledgerPath,
          plan,
          proposal(ledgerPath)
        )
      ).to.throw();
      expect(fs.readFileSync(ledgerPath)).to.deep.equal(attempted);
    }
  });

  it("rejects another unsettled request and an active writer without replacing its lock", () => {
    const bytes = fs.readFileSync(ledgerPath),
      operation = proposal(ledgerPath);
    fs.writeFileSync(
      `${ledgerPath}.lock`,
      JSON.stringify({ pid: process.pid, nonce: "real-test-owner" })
    );
    const lock = fs.readFileSync(`${ledgerPath}.lock`);
    expect(() =>
      budget.quarantineCompletedReservation(ledgerPath, plan, operation)
    ).to.throw("ledger_busy");
    expect(fs.readFileSync(`${ledgerPath}.lock`)).to.deep.equal(lock);
    expect(fs.readFileSync(ledgerPath)).to.deep.equal(bytes);
    fs.unlinkSync(`${ledgerPath}.lock`);
    const ledger = read(ledgerPath),
      other = {
        ...ledger.entries.at(-1),
        id: "other-unsettled",
        generationId: "gen-other",
      };
    ledger.entries.splice(ledger.entries.length - 1, 0, other);
    save(ledgerPath, ledger);
    const attempted = fs.readFileSync(ledgerPath);
    expect(() =>
      budget.quarantineCompletedReservation(
        ledgerPath,
        plan,
        proposal(ledgerPath)
      )
    ).to.throw("ineligible_quarantine");
    expect(fs.readFileSync(ledgerPath)).to.deep.equal(attempted);
  });

  it("rejects tampered operator provenance on fresh reads even with a recomputed outer integrity", () => {
    budget.quarantineCompletedReservation(
      ledgerPath,
      plan,
      proposal(ledgerPath)
    );
    const base = read(ledgerPath);
    for (const mutate of [
      (r: any) => {
        r.kind = "stale_owner";
      },
      (r: any) => {
        r.originalEntrySha256 = "0".repeat(64);
      },
      (r: any) => {
        r.operatorEvidenceSha256 = "0".repeat(64);
      },
      (r: any) => {
        r.reservedNanoUsd--;
      },
      (r: any) => {
        r.ownerPid = process.pid;
      },
      (r: any) => {
        const e = JSON.parse(r.operatorEvidenceJson);
        e.chargeStatus = "verified_zero";
        r.operatorEvidenceJson = JSON.stringify(e);
        r.operatorEvidenceSha256 = rawHash(r.operatorEvidenceJson);
      },
    ]) {
      const ledger = structuredClone(base);
      mutate(ledger.entries.at(-1).recovery);
      save(ledgerPath, ledger);
      expect(() => budget.readBudgetSummary(ledgerPath, plan)).to.throw(
        "invalid_ledger"
      );
    }
  });

  it("does not re-quarantine accounted charges or alter an immutable model-history prefix", () => {
    budget.quarantineCompletedReservation(
      ledgerPath,
      plan,
      proposal(ledgerPath)
    );
    const before = fs.readFileSync(ledgerPath);
    expect(() =>
      budget.quarantineCompletedReservation(
        ledgerPath,
        plan,
        proposal(ledgerPath)
      )
    ).to.throw("ineligible_quarantine");
    expect(fs.readFileSync(ledgerPath)).to.deep.equal(before);
    const changed = budget.applyBudgetModelAmendment(
      ledgerPath,
      plan,
      catalog,
      {
        amendmentId: randomUUID(),
        amendedAt: new Date().toISOString(),
        approvalReference: "fixture return model",
        expectedLedgerIntegrity: read(ledgerPath).integrity,
        model: catalog.id,
      }
    );
    expect(read(ledgerPath).entries).to.deep.equal(
      JSON.parse(before.toString()).entries
    );
    expect(changed.summary.reservedUsd).to.equal(
      budget.readBudgetSummary(ledgerPath, changed.plan).reservedUsd
    );
    const modified = read(ledgerPath);
    delete modified.entries.at(-1).recovery;
    save(ledgerPath, modified);
    expect(() =>
      budget.quarantineCompletedReservation(
        ledgerPath,
        changed.plan,
        proposal(ledgerPath)
      )
    ).to.throw();
  });

  it("uses a real dead-owner recovery after interrupted publication without inventing stale-lock provenance", () => {
    const operation = proposal(ledgerPath),
      before = budget.readBudgetSummary(ledgerPath, plan);
    const child = spawnSync(
      process.execPath,
      [
        "-e",
        `
      const fs=require('node:fs'), budget=require(process.argv[1]);
      const open=fs.openSync, write=fs.writeFileSync, paths=new Map();
      fs.openSync=(file,...args)=>{const fd=open(file,...args);paths.set(fd,String(file));return fd;};
      fs.writeFileSync=(target,...args)=>{if(paths.get(target)?.endsWith('quarantine.applied.json'))throw new Error('fixture-audit-failure');return write(target,...args);};
      try{budget.quarantineCompletedReservation(process.argv[2],JSON.parse(process.argv[3]),JSON.parse(process.argv[4]));process.exit(2);}catch(error){if(error.message==='fixture-audit-failure')process.exit(0);throw error;}
    `,
        helper,
        ledgerPath,
        JSON.stringify(plan),
        JSON.stringify(operation),
      ],
      { encoding: "utf8" }
    );
    expect(child.status, child.stderr).to.equal(0);
    const afterFailure = read(ledgerPath),
      recovery = afterFailure.entries.at(-1).recovery;
    const lockBytes = fs.readFileSync(`${ledgerPath}.lock`),
      owner = JSON.parse(lockBytes.toString()).pid;
    expect(owner).not.to.equal(process.pid);
    const result = budget.recoverInterruptedReservation(ledgerPath, plan, {
      expectedLedgerIntegrity: afterFailure.integrity,
      expectedEntryId: operation.expectedEntryId,
      expectedLockSha256: rawHash(lockBytes),
      expectedOwnerPid: owner,
    });
    expect(read(ledgerPath).entries.at(-1).recovery).to.deep.equal(recovery);
    expect(result.summary).to.deep.equal({
      ...before,
      blocked: false,
      recoveredReservedUsd: before.reservedUsd,
    });
    expect(fs.existsSync(`${ledgerPath}.lock`)).to.equal(false);
  });

  for (const stage of [
    "before",
    "evidence",
    "intent",
    "ledger-fsync",
    "rename",
    "applied",
    "applied-fsync",
  ])
    it(`fails closed when ${stage} storage publication fails`, () => {
      const bytes = fs.readFileSync(ledgerPath),
        operation = proposal(ledgerPath),
        beforeSummary = budget.readBudgetSummary(ledgerPath, plan);
      const actualFs = require("node:fs"),
        write = actualFs.writeFileSync,
        rename = actualFs.renameSync,
        fsync = actualFs.fsyncSync;
      let auditFiles: Record<number, string> = {};
      const open = actualFs.openSync;
      actualFs.openSync = (file: any, ...args: any[]) => {
        const fd = open(file, ...args);
        auditFiles[fd] = String(file);
        return fd;
      };
      actualFs.writeFileSync = (target: any, ...args: any[]) => {
        const file =
          typeof target === "number" ? auditFiles[target] : String(target);
        if (
          (stage === "before" && file?.endsWith("ledger.before.json")) ||
          (stage === "evidence" && file?.endsWith("operator-evidence.json")) ||
          (stage === "intent" && file?.endsWith("quarantine.intent.json")) ||
          (stage === "applied" && file?.endsWith("quarantine.applied.json"))
        )
          throw new Error("fixture-storage-failure");
        return write(target, ...args);
      };
      actualFs.fsyncSync = (fd: number) => {
        if (
          (stage === "ledger-fsync" && auditFiles[fd]?.endsWith(".tmp")) ||
          (stage === "applied-fsync" &&
            auditFiles[fd]?.endsWith("quarantine.applied.json"))
        )
          throw new Error("fixture-storage-failure");
        return fsync(fd);
      };
      actualFs.renameSync = (from: any, to: any) => {
        if (stage === "rename" && String(to) === ledgerPath)
          throw new Error("fixture-storage-failure");
        return rename(from, to);
      };
      try {
        expect(() =>
          budget.quarantineCompletedReservation(ledgerPath, plan, operation)
        ).to.throw("fixture-storage-failure");
      } finally {
        actualFs.openSync = open;
        actualFs.writeFileSync = write;
        actualFs.renameSync = rename;
        actualFs.fsyncSync = fsync;
      }
      expect(fs.existsSync(`${ledgerPath}.lock`)).to.equal(
        ["ledger-fsync", "rename", "applied", "applied-fsync"].includes(stage)
      );
      if (!["applied", "applied-fsync"].includes(stage))
        expect(fs.readFileSync(ledgerPath)).to.deep.equal(bytes);
      const current = budget.readBudgetSummary(ledgerPath, plan);
      expect(current.reservedUsd).to.equal(beforeSummary.reservedUsd);
      if (["applied", "applied-fsync"].includes(stage))
        expect(read(ledgerPath).entries.at(-1).recovery.kind).to.equal(
          "completed_uncertain"
        );
    });
});
