"use strict";

const fs = require("node:fs");
const path = require("node:path");

/** Own a new external receipt; never overwrite an earlier evaluation. */
function createReportWriter(filename, repoRoot, initialReport) {
  if (typeof filename !== "string" || !path.isAbsolute(filename))
    throw new Error("absolute report path required");
  const parent = fs.realpathSync(path.dirname(filename));
  const target = path.join(parent, path.basename(filename));
  const relative = path.relative(fs.realpathSync(repoRoot), target);
  if (
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  )
    throw new Error("report must be outside the repository");
  const fd = fs.openSync(target, "wx", 0o600);
  const identity = fs.fstatSync(fd);
  let sequence = 0;
  let closed = false;
  let failed = false;
  let committedBytes = 0;
  function assertOwnership() {
    const current = fs.lstatSync(target);
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.ino !== identity.ino ||
      current.dev !== identity.dev
    )
      throw new Error("report ownership changed");
  }
  function write(report) {
    if (closed) throw new Error("report is closed");
    if (failed) throw new Error("report journal failed");
    try {
      assertOwnership();
      // The descriptor always refers to our original file, even if someone
      // replaces its pathname between the check and this append.
      fs.writeFileSync(fd, `${JSON.stringify({ sequence, report })}\n`);
      fs.fsyncSync(fd);
      assertOwnership();
      committedBytes = fs.fstatSync(fd).size;
      sequence++;
    } catch (error) {
      failed = true;
      // Never append after an ambiguous write. Roll back only our own pending
      // record. A continuing storage failure requires independent recovery;
      // the runner remains failed even if this best-effort rollback succeeds.
      try {
        fs.ftruncateSync(fd, committedBytes);
        fs.fsyncSync(fd);
      } catch {
        /* Keep the original failure. */
      }
      throw error;
    }
  }
  write.close = () => {
    if (!closed) {
      closed = true;
      fs.closeSync(fd);
    }
  };
  try {
    write(initialReport);
    // A synced new file can still disappear after power loss unless its parent
    // directory entry is synced before the runner admits provider calls. Node
    // cannot portably sync directory handles on Windows; file sync still applies.
    if (process.platform !== "win32") {
      const directoryFd = fs.openSync(parent, "r");
      try {
        fs.fsyncSync(directoryFd);
      } finally {
        fs.closeSync(directoryFd);
      }
      assertOwnership();
    }
  } catch (error) {
    write.close();
    throw error;
  }
  return write;
}

/** Read complete records, ignoring a crash tail. Parsing alone does not prove a successful sync. */
function readLatestReport(filename) {
  const lines = fs.readFileSync(filename, "utf8").split("\n");
  lines.pop();
  let latest;
  for (const [sequence, line] of lines.entries()) {
    const checkpoint = JSON.parse(line);
    if (
      checkpoint.sequence !== sequence ||
      !checkpoint.report ||
      typeof checkpoint.report !== "object" ||
      Array.isArray(checkpoint.report)
    )
      throw new Error("invalid report journal");
    latest = checkpoint.report;
  }
  if (!latest) throw new Error("no complete report checkpoint");
  return latest;
}

module.exports = { createReportWriter, readLatestReport };
