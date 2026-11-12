import { expect } from "chai";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { createReportWriter, readLatestReport } = require("./live-eval-report");
const fileSystem = require("node:fs");

describe("durable evaluation receipts", () => {
  let directory: string;
  let repo: string;
  let receipt: string;
  let writers: Array<{ close: () => void }>;
  function writer(initial: unknown) {
    const write = createReportWriter(receipt, repo, initial);
    writers.push(write);
    return write;
  }
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "hedwig-receipt-"));
    repo = join(directory, "repo");
    mkdirSync(repo);
    receipt = join(directory, "receipt.jsonl");
    writers = [];
  });
  afterEach(() => {
    writers.forEach((write) => write.close());
    rmSync(directory, { recursive: true, force: true });
  });

  it("retains completed cases and the active case before process finalization", () => {
    const write = writer({
      complete: false,
      cases: [],
    });
    write({ complete: false, activeCase: "first", cases: [] });
    expect(readLatestReport(receipt)).to.deep.equal({
      complete: false,
      activeCase: "first",
      cases: [],
    });
    write({
      complete: false,
      activeCase: null,
      cases: [{ id: "first", answer: "Public evidence." }],
    });
    expect(readLatestReport(receipt).cases).to.deep.equal([
      { id: "first", answer: "Public evidence." },
    ]);
  });

  it("refuses to overwrite an earlier run or use an in-repository path", () => {
    writeFileSync(receipt, "earlier receipt");
    expect(() => createReportWriter(receipt, repo, {})).to.throw();
    expect(readFileSync(receipt, "utf8")).to.equal("earlier receipt");
    expect(() =>
      createReportWriter(join(repo, "receipt.json"), repo, {})
    ).to.throw();
    expect(() => createReportWriter("relative.json", repo, {})).to.throw();
  });

  it("refuses to replace a receipt that another actor replaced", () => {
    const write = writer({ old: true });
    renameSync(receipt, join(directory, "preserved.json"));
    writeFileSync(receipt, "replacement");
    expect(() => write({ new: true })).to.throw("ownership changed");
    expect(readFileSync(receipt, "utf8")).to.equal("replacement");
    expect(readLatestReport(join(directory, "preserved.json"))).to.deep.equal({
      old: true,
    });
  });

  it("does not overwrite a replacement installed during a checkpoint write", () => {
    const write = writer({ old: true });
    const originalSync = fileSystem.fsyncSync;
    let replaced = false;
    fileSystem.fsyncSync = (fd: number) => {
      if (!replaced) {
        replaced = true;
        renameSync(receipt, join(directory, "preserved.jsonl"));
        writeFileSync(receipt, "replacement");
      }
      originalSync(fd);
    };
    try {
      expect(() => write({ complete: false, cases: ["saved"] })).to.throw(
        "ownership changed"
      );
    } finally {
      fileSystem.fsyncSync = originalSync;
    }
    expect(readFileSync(receipt, "utf8")).to.equal("replacement");
    expect(readLatestReport(join(directory, "preserved.jsonl"))).to.deep.equal({
      old: true,
    });
  });

  it("ignores a truncated crash tail but rejects a corrupt complete record", () => {
    const write = writer({ complete: false, cases: [] });
    write({ complete: false, cases: ["saved"] });
    write.close();
    fileSystem.appendFileSync(
      receipt,
      '{"sequence":2,"report":{"complete":tru'
    );
    expect(readLatestReport(receipt)).to.deep.equal({
      complete: false,
      cases: ["saved"],
    });
    fileSystem.appendFileSync(receipt, "\n");
    expect(() => readLatestReport(receipt)).to.throw();
  });

  it("poisons after failed synchronization and cannot append a final success", () => {
    const write = writer({ complete: false, cases: ["saved"] });
    const originalSync = fileSystem.fsyncSync;
    fileSystem.fsyncSync = () => {
      throw new Error("injected sync failure");
    };
    try {
      expect(() => write({ complete: true })).to.throw("injected sync failure");
    } finally {
      fileSystem.fsyncSync = originalSync;
    }
    expect(() => write({ complete: true })).to.throw("journal failed");
    expect(readLatestReport(receipt)).to.deep.equal({
      complete: false,
      cases: ["saved"],
    });
  });

  it("poisons after a partial write and retains the prior checkpoint", () => {
    const write = writer({ complete: false, cases: ["saved"] });
    const originalWrite = fileSystem.writeFileSync;
    fileSystem.writeFileSync = (fd: number) => {
      originalWrite(fd, '{"sequence":1');
      throw new Error("partial write");
    };
    try {
      expect(() => write({ complete: true })).to.throw("partial write");
    } finally {
      fileSystem.writeFileSync = originalWrite;
    }
    expect(() => write({ complete: true })).to.throw("journal failed");
    expect(readLatestReport(receipt)).to.deep.equal({
      complete: false,
      cases: ["saved"],
    });
  });

  it("stays failed when both synchronization and rollback fail", () => {
    const write = writer({ complete: false, cases: ["saved"] });
    const originalSync = fileSystem.fsyncSync;
    const originalTruncate = fileSystem.ftruncateSync;
    fileSystem.fsyncSync = () => {
      throw new Error("persistent storage failure");
    };
    fileSystem.ftruncateSync = () => {
      throw new Error("rollback failure");
    };
    try {
      expect(() => write({ complete: true })).to.throw(
        "persistent storage failure"
      );
    } finally {
      fileSystem.fsyncSync = originalSync;
      fileSystem.ftruncateSync = originalTruncate;
    }
    expect(() => write({ complete: true })).to.throw("journal failed");
    // Complete bytes may be readable despite a failed sync. The runner's
    // receipt_unavailable result requires recovery, never qualification.
    expect(readLatestReport(receipt).complete).to.equal(true);
  });
});
