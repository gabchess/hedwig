import { expect } from "chai";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const helper = resolve(__dirname, "live-eval-budget.js");
const budget = require("./live-eval-budget.js");

// Child isolation keeps injected filesystem errors out of other tests. On Windows
// a fake directory descriptor exercises POSIX ordering, not power-loss durability.
const worker = `
const fs = require('node:fs'), path = require('node:path');
const budget = require(process.argv[1]);
const filename = path.join(process.argv[2], 'ledger.json');
const scenario = process.argv[3];
const nativePlatform = process.platform;
const platform = scenario === 'windows' ? 'win32' : 'linux';
Object.defineProperty(process, 'platform', { value: platform });
const plan = budget.createBudgetPlan({ id:'openai/gpt-4.1-mini', context_length:1000,
 top_provider:{max_completion_tokens:32768}, pricing:{prompt:'0.0000004',completion:'0.0000016'} });
const original = { open:fs.openSync, close:fs.closeSync, sync:fs.fsyncSync, write:fs.writeFileSync, rename:fs.renameSync };
const descriptors = new Map(), virtual = new Set(), events = [];
let nextFd=1000000, dirSyncs=0, dispatched=false, injected=false, calls=0, duringFetch;
fs.openSync = (name, flags, ...args) => {
 const isDirectory=flags==='r' && fs.statSync(name).isDirectory();
 const fd=isDirectory && nativePlatform==='win32' ? nextFd++ : original.open(name,flags,...args);
 if(isDirectory && nativePlatform==='win32') virtual.add(fd);
 descriptors.set(fd,{name:String(name),isDirectory});
 if(flags==='wx') events.push('create:'+path.basename(String(name)));
 return fd;
};
fs.closeSync = fd => { descriptors.delete(fd); if(virtual.delete(fd)) return; return original.close(fd); };
fs.fsyncSync = fd => {
 const entry=descriptors.get(fd);
 if(dirSyncs>=0 && !injected && scenario==='lock-file-sync-failure' && entry?.name===filename+'.lock') {
   injected=true; throw new Error('injected lock file sync failure');
 }
 if(dirSyncs>=0 && !injected && !dispatched && scenario==='reservation-file-sync-failure' && entry?.name.endsWith('.tmp')) {
   injected=true; throw new Error('injected reservation file sync failure');
 }
 if(entry?.isDirectory) {
   dirSyncs++; events.push('directory-sync');
   if((scenario==='lock-sync-failure' && dirSyncs===1) || (scenario==='reservation-sync-failure' && dirSyncs===2) ||
      (scenario==='header-sync-failure' && dirSyncs===3) || (scenario==='settlement-sync-failure' && dirSyncs===4))
     throw new Error('injected directory failure');
 } else events.push('file-sync');
 if(!virtual.has(fd)) return original.sync(fd);
};
fs.renameSync = (from,to) => {
 events.push('rename:'+path.basename(String(to)));
 if(dirSyncs>=0 && !injected && to===filename && scenario==='reservation-rename-failure') {
   injected=true; throw new Error('injected rename failure');
 }
 const result=original.rename(from,to);
 if(dirSyncs>=0 && !injected && to===filename && scenario==='reservation-published-failure') {
   injected=true; throw new Error('injected error after publication');
 }
 return result;
};
fs.writeFileSync = (fd,data,...args) => {
 const text=String(data);
 const name=descriptors.get(fd)?.name;
 if(dirSyncs>=0 && !injected && name===filename+'.lock' && ['lock-write-failure','lock-replacement-failure'].includes(scenario)) {
   injected=true;
   original.write(fd, text.slice(0,5));
   if(scenario==='lock-replacement-failure') {
     original.rename(name,name+'.retired');
     original.write(name,text,{flag:'wx'});
   }
   throw new Error('injected partial lock write failure');
 }
 if(dirSyncs>=0 && !injected && !dispatched && name?.endsWith('.tmp') && scenario==='reservation-write-failure') {
   injected=true; throw new Error('injected reservation write failure');
 }
 const failWrite=dispatched && !injected && (
   (scenario==='header-write-failure' && text.includes('responseReceivedAt')) ||
   (scenario==='settlement-write-failure' && text.includes('"status": "settled"')) ||
   (scenario==='uncertain-write-failure' && text.includes('"status": "uncertain"')));
 if(failWrite) { injected=true; throw new Error('injected outcome write failure'); }
 return original.write(fd,data,...args);
};
(async()=>{
 // Initialize without failure injection; the tested operation starts afterward.
 const selected=scenario; dirSyncs=-100;
 budget.initializeBudgetLedger(filename,plan);
 const initializationEvents=[...events];
 events.length=0; dirSyncs=0;
 const guarded=budget.installBudgetGuard({ledgerPath:filename,plan,fetch:async()=>{
   calls++; dispatched=true;
   duringFetch={events:[...events],entry:JSON.parse(fs.readFileSync(filename,'utf8')).entries[0]};
   if(selected==='uncertain-write-failure') throw new Error('injected pre-header transport failure');
   return new Response('{"id":"gen-storage","usage":{"cost":0.001}}');
 }});
 let error;
 try { await guarded('https://openrouter.ai/api/v1/chat/completions',{method:'POST',body:JSON.stringify({
   model:plan.model,stream:false,temperature:0,max_tokens:2048,
   provider:{data_collection:'deny',require_parameters:true,allow_fallbacks:false,zdr:true},
   messages:[{role:'user',content:'Disposable storage test.'}],response_format:{type:'json_schema',json_schema:{}}
 })}); } catch(e) { error=e.message; }
 const result={calls,error,duringFetch,events:[...events],initializationEvents,injected,lock:fs.existsSync(filename+'.lock'),
   ledger:JSON.parse(fs.readFileSync(filename,'utf8')),platform,nativePlatform,plan};
 if(['lock-write-failure','lock-file-sync-failure','lock-sync-failure','reservation-write-failure','reservation-file-sync-failure','reservation-rename-failure'].includes(scenario)) {
   try { result.retry=budget.initializeBudgetLedger(filename,plan); } catch(e) { result.retryError=e.message; }
 }
 console.log(JSON.stringify(result));
})().catch(e=>{console.error(e);process.exit(1)});
`;

describe("evaluation ledger persistence ordering", () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "hedwig-budget-storage-"));
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));
  function probe(scenario: string) {
    const child = spawnSync(
      process.execPath,
      ["-e", worker, helper, directory, scenario],
      { encoding: "utf8", timeout: 5000 }
    );
    expect(child.status, child.stderr).to.equal(0);
    return JSON.parse(child.stdout.trim());
  }

  it("syncs lock creation and reservation directory entries before dispatch on POSIX", () => {
    const result = probe("success");
    expect(result.error).to.equal(undefined);
    expect(result.calls).to.equal(1);
    const events: string[] = result.duringFetch.events;
    expect(events.filter((event) => event === "directory-sync")).to.have.length(
      2
    );
    expect(events.indexOf("directory-sync")).to.be.lessThan(
      events.indexOf("rename:ledger.json")
    );
    expect(events.at(-1)).to.equal("directory-sync");
    expect(
      result.initializationEvents.filter(
        (event: string) => event === "directory-sync"
      )
    ).to.have.length(3);
    expect(result.duringFetch.entry.status).to.equal("reserved");
    expect(result.ledger.entries[0].status).to.equal("settled");
    expect(result.lock).to.equal(false);
  });

  for (const scenario of ["lock-sync-failure", "reservation-sync-failure"]) {
    it(`does not dispatch after ${scenario}`, () => {
      const result = probe(scenario);
      expect(result.error).to.be.a("string");
      expect(result.calls).to.equal(0);
    });
  }

  for (const scenario of [
    "lock-write-failure",
    "lock-file-sync-failure",
    "lock-sync-failure",
    "reservation-write-failure",
    "reservation-file-sync-failure",
    "reservation-rename-failure",
  ]) {
    it(`admits a subsequent writer after ${scenario} proves no reservation was published`, () => {
      const result = probe(scenario);
      expect(result.error).to.be.a("string");
      expect(result.calls).to.equal(0);
      expect(result.lock).to.equal(false);
      expect(result.ledger.entries).to.have.length(0);
      expect(result.retryError).to.equal(undefined);
      expect(result.retry.requestCount).to.equal(0);
    });
  }

  it("does not remove a replacement inode after partial lock creation fails", () => {
    const result = probe("lock-replacement-failure");
    expect(result.calls).to.equal(0);
    expect(result.lock).to.equal(true);
    const lock = JSON.parse(
      readFileSync(join(directory, "ledger.json.lock"), "utf8")
    );
    expect(lock.nonce).to.be.a("string");
    expect(
      readFileSync(join(directory, "ledger.json.lock.retired"), "utf8")
    ).to.equal('{"pid');
  });

  for (const scenario of [
    "reservation-sync-failure",
    "reservation-published-failure",
  ]) {
    it(`retains recoverable full accounting after ${scenario} with zero dispatch`, () => {
      const result = probe(scenario);
      expect(result.calls).to.equal(0);
      expect(result.lock).to.equal(true);
      expect(result.ledger.entries).to.have.length(1);
      const filename = join(directory, "ledger.json");
      const lock = readFileSync(`${filename}.lock`);
      const entry = result.ledger.entries[0];
      const recovered = budget.recoverInterruptedReservation(
        filename,
        result.plan,
        {
          expectedLedgerIntegrity: result.ledger.integrity,
          expectedEntryId: entry.id,
          expectedLockSha256: createHash("sha256").update(lock).digest("hex"),
          expectedOwnerPid: JSON.parse(lock.toString("utf8")).pid,
        }
      );
      expect(recovered.summary.reservedUsd).to.equal(
        entry.reservedNanoUsd / 1e9
      );
      expect(recovered.summary.recoveredReservedUsd).to.equal(
        entry.reservedNanoUsd / 1e9
      );
      expect(recovered.summary.spentUsd).to.equal(0);
      expect(recovered.summary.requestCount).to.equal(1);
      expect(recovered.summary.blocked).to.equal(false);
    });
  }

  it("keeps Windows file synchronization without claiming unavailable directory synchronization", () => {
    const result = probe("windows");
    expect(result.error).to.equal(undefined);
    expect(result.events).not.to.include("directory-sync");
    expect(result.events).to.include("file-sync");
    expect(result.calls).to.equal(1);
  });

  for (const scenario of [
    "header-write-failure",
    "settlement-write-failure",
    "uncertain-write-failure",
  ]) {
    it(`retains exclusion evidence after post-dispatch ${scenario}`, () => {
      const result = probe(scenario);
      expect(result.error).to.contain("ledger_failure");
      expect(result.calls).to.equal(1);
      expect(result.injected).to.equal(true);
      expect(result.lock).to.equal(true);
      expect(result.ledger.entries).to.have.length(1);
      expect(result.ledger.entries[0].status).to.equal("reserved");
    });
  }

  for (const scenario of ["header-sync-failure", "settlement-sync-failure"]) {
    it(`retains the lock when the post-dispatch ${scenario} leaves commit durability uncertain`, () => {
      const result = probe(scenario);
      expect(result.error).to.contain("ledger_failure");
      expect(result.calls).to.equal(1);
      expect(result.lock).to.equal(true);
      expect(result.ledger.entries[0].status).to.equal(
        scenario === "settlement-sync-failure" ? "settled" : "reserved"
      );
    });
  }
});
