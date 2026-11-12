import { expect } from "chai";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const worker = `
const fs=require('node:fs'),path=require('node:path');
const root=process.argv[2],scenario=process.argv[3],nativePlatform=process.platform;
Object.defineProperty(process,'platform',{value:scenario==='windows'?'win32':'linux'});
const repo=path.join(root,'repo');fs.mkdirSync(repo);
const original={open:fs.openSync,close:fs.closeSync,sync:fs.fsyncSync};
const descriptors=new Map(),virtual=new Set(),events=[];let nextFd=1000000;
fs.openSync=(name,flags,...args)=>{
 const directory=flags==='r'&&fs.statSync(name).isDirectory();
 const fd=directory&&nativePlatform==='win32'?nextFd++:original.open(name,flags,...args);
 if(directory&&nativePlatform==='win32')virtual.add(fd);
 descriptors.set(fd,{directory});return fd;
};
fs.closeSync=fd=>{descriptors.delete(fd);if(virtual.delete(fd))return;return original.close(fd);};
fs.fsyncSync=fd=>{
 const directory=descriptors.get(fd)?.directory;events.push(directory?'directory-sync':'file-sync');
 if(directory&&scenario==='failure')throw new Error('injected parent sync failure');
 if(!virtual.has(fd))return original.sync(fd);
};
let returned=false,error;
try { const writer=require(process.argv[1]).createReportWriter(path.join(root,'report.jsonl'),repo,{complete:false});
 returned=true;events.push('writer-returned');writer.close(); }catch(e){error=e.message;}
console.log(JSON.stringify({returned,error,events,openDescriptors:descriptors.size}));
`;

describe("initial evaluation receipt durability", () => {
  for (const scenario of ["success", "failure", "windows"]) {
    it(`handles ${scenario} parent synchronization before admitting a run`, () => {
      const directory = mkdtempSync(join(tmpdir(), "hedwig-report-storage-"));
      try {
        const child = spawnSync(
          process.execPath,
          [
            "-e",
            worker,
            resolve(__dirname, "live-eval-report.js"),
            directory,
            scenario,
          ],
          { encoding: "utf8", timeout: 5000 }
        );
        expect(child.status, child.stderr).to.equal(0);
        const result = JSON.parse(child.stdout.trim());
        expect(result.openDescriptors).to.equal(0);
        if (scenario === "failure") {
          expect(result.returned).to.equal(false);
          expect(result.error).to.equal("injected parent sync failure");
          expect(result.events).to.deep.equal(["file-sync", "directory-sync"]);
        } else {
          expect(result.returned).to.equal(true);
          expect(result.events).to.deep.equal(
            scenario === "windows"
              ? ["file-sync", "writer-returned"]
              : ["file-sync", "directory-sync", "writer-returned"]
          );
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});
