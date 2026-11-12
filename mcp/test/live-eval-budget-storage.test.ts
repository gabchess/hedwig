import { expect } from "chai";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const helper = resolve(__dirname, "live-eval-budget.js");

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
 if(entry?.isDirectory) {
   dirSyncs++; events.push('directory-sync');
   if((scenario==='lock-sync-failure' && dirSyncs===1) || (scenario==='reservation-sync-failure' && dirSyncs===2) ||
      (scenario==='header-sync-failure' && dirSyncs===3) || (scenario==='settlement-sync-failure' && dirSyncs===4))
     throw new Error('injected directory failure');
 } else events.push('file-sync');
 if(!virtual.has(fd)) return original.sync(fd);
};
fs.renameSync = (from,to) => { events.push('rename:'+path.basename(String(to))); return original.rename(from,to); };
fs.writeFileSync = (fd,data,...args) => {
 const text=String(data);
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
 console.log(JSON.stringify({calls,error,duringFetch,events,initializationEvents,injected,lock:fs.existsSync(filename+'.lock'),
   ledger:JSON.parse(fs.readFileSync(filename,'utf8')),platform,nativePlatform}));
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
