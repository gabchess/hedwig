import { expect } from "chai";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
const budget = require("./live-eval-budget.js");

describe("live evaluator model-aware MCP timeouts", () => {
  for (const { model, timeout } of [
    { model: "deepseek/deepseek-v4-flash-0731", timeout: 120000 },
    { model: "qwen/qwen3-235b-a22b-2507", timeout: 60000 },
    { model: "openai/gpt-5.2", timeout: 60000 },
  ]) {
    it(`passes ${model}'s tool timeout without changing its input or making a provider request`, () => {
      const directory = mkdtempSync(join(tmpdir(), "hedwig-tool-timeout-"));
      try {
        const catalog = {
          id: model,
          context_length: 1048576,
          top_provider: { max_completion_tokens: 943718 },
          pricing: {
            prompt: "0.0000000434",
            completion: "0.0000003",
            input_cache_read: "0.000000035",
          },
        };
        const plan = budget.createBudgetPlan(catalog, model),
          planPath = join(directory, "plan.json"),
          ledgerPath = join(directory, "ledger.json"),
          capturePath = join(directory, "capture.json"),
          preloadPath = join(directory, "preload.cjs");
        writeFileSync(planPath, JSON.stringify(plan));
        budget.initializeBudgetLedger(ledgerPath, plan);
        const before = readFileSync(ledgerPath);
        const question =
          "Compare my positions before I choose the chain or addresses.";
        writeFileSync(
          preloadPath,
          `
          const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
          const {PassThrough}=require('node:stream');
          require(path.resolve('node_modules/ts-node')).register({project:'mcp/tsconfig.test.json',transpileOnly:true});
          const policy=require(path.resolve('mcp/src/model-policy.ts'));
          const originalRead=fs.readFileSync;
          fs.readFileSync=function(filename,...args){
            if(String(filename).replaceAll('\\\\','/').endsWith('/fixtures/foundations-eval.json')) return JSON.stringify({cases:[{id:'public-gate-fixture',question:${JSON.stringify(
              question
            )},expectedStatus:'needs_clarification',requiredSourceIds:[]}]});
            return originalRead.call(this,filename,...args);
          };
          let transport;
          class Transport {constructor(){this.stderr=new PassThrough();transport=this;}}
          class Client {
            async connect(){}
            async close(){transport.stderr.end();}
            async callTool(request,schema,options){fs.writeFileSync(${JSON.stringify(
              capturePath
            )},JSON.stringify({request,options}),{flag:'wx'});return {structuredContent:{status:'needs_clarification',message:'Deployment identity is required.'}};}
          }
          const originalLoad=Module._load;
          Module._load=function(id,...args){
            if(id==='@modelcontextprotocol/sdk/client/index.js')return {Client};
            if(id==='@modelcontextprotocol/sdk/client/stdio.js')return {StdioClientTransport:Transport,getDefaultEnvironment:()=>({})};
            if(String(id).replaceAll('\\\\','/').endsWith('/mcp/dist/model-policy.js'))return policy;
            if(String(id).replaceAll('\\\\','/').endsWith('/mcp/dist/knowledge.js'))return {retrieveFoundationSources:()=>{throw new Error('Gate must not retrieve.');}};
            if(String(id).replaceAll('\\\\','/').endsWith('/mcp/dist/expert-workflow.js'))return {prepareExpertRequest:()=>({status:'needs_clarification'})};
            return originalLoad.call(this,id,...args);
          };
          globalThis.fetch=async url=>{
            if(url==='https://openrouter.ai/api/v1/models')return new Response(${JSON.stringify(
              JSON.stringify({ data: [catalog] })
            )});
            if(url==='https://openrouter.ai/api/v1/key')return new Response('{"data":{"usage":0}}');
            throw new Error('No provider or other network request is permitted.');
          };
        `
        );
        const child = spawnSync(
          process.execPath,
          [
            "--require",
            preloadPath,
            join(__dirname, "foundations-live-eval.js"),
          ],
          {
            encoding: "utf8",
            timeout: 5000,
            env: {
              ...process.env,
              NODE_OPTIONS: "",
              OPENROUTER_API_KEY: "fixture",
              HEDWIG_OPENROUTER_MODEL: model,
              HEDWIG_EVAL_BUDGET_PLAN: planPath,
              HEDWIG_EVAL_BUDGET_LEDGER: ledgerPath,
              HEDWIG_EVAL_REPORT_PATH: join(directory, "report.jsonl"),
              HEDWIG_EVAL_BUDGET_PRELOAD: "0",
            },
          }
        );
        expect(child.status, child.stderr).to.equal(0);
        expect(JSON.parse(readFileSync(capturePath, "utf8"))).to.deep.equal({
          request: { name: "ask_hedwig", arguments: { question } },
          options: { timeout },
        });
        const report = JSON.parse(child.stdout);
        expect(report.cases[0]).to.include({
          providerRequestsStarted: 0,
          statusMatched: true,
        });
        expect(readFileSync(ledgerPath)).to.deep.equal(before);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});
