import { spawn } from "node:child_process";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "chai";

import {
  createRatchet,
  gatherRegistry,
  PINNED_REGISTRY_KEYS,
  REGISTRY_DEADLINE_MS,
} from "../src/readers/registry-asset";
import type { RegistryDeps } from "../src/readers/registry-asset";
import {
  ASSET_CALL,
  BASE,
  EXPIRES_AT_SECONDS,
  MONAD_USDC,
  MONAD_USDC_CODE,
  MONAD_USDC_HASH,
  MONAD_USDC_IMPL,
  MONAD_USDC_IMPL_CODE,
  MONAD_USDC_IMPL_HASH,
  NOW,
  RPC_URL,
  SLOT_BEACON,
  SLOT_EIP1967,
  SLOT_ZEPPELINOS,
  SPARK,
  SPARK_IMPL,
  SPARK_IMPL_CODE,
  SPARK_OTHER_IMPL,
  STEAK,
  STEAK_CODE,
  USDT,
  USDT_CODE,
  VERIFIED_AT,
  ZERO_WORD,
  emptyChain,
  envelope,
  makeKeys,
  makeWorld,
  monadChain,
  monadUsdcRow,
  previewCall,
  rowLog,
  rpcLog,
  sha256OfHex,
  signed,
  sparkChain,
  sparkRow,
  steakChain,
  steakRow,
  usdtRow,
  wordOfAddress,
  wordOfNumber,
} from "./registry-helpers";
import type { ChainState, TestKeys, World } from "./registry-helpers";

const OWNER = "0x00000000000000000000000000000000a11ce001";
const keys = makeKeys();

const MONAD_PATH = "v1/eip155-143/USDC.json";
const USDT_PATH = "v1/eip155-1/USDT.json";
const STEAK_PATH = `v1/vaults/eip155-1/${STEAK}.json`;
const SPARK_PATH = `v1/vaults/eip155-1/${SPARK}.json`;

const PAY_MONAD = {
  action: {
    type: "pay",
    chainId: "eip155:143",
    recipient: OWNER,
    asset: { symbol: "USDC", contractAddress: MONAD_USDC },
    amount: "1000000",
    target: MONAD_USDC,
  },
};

const PAY_USDT = {
  action: {
    type: "pay",
    chainId: "eip155:1",
    recipient: OWNER,
    asset: { symbol: "USDT", contractAddress: USDT },
    amount: "1000000",
    target: USDT,
  },
};

function deposit(
  vault: string,
  amount: string,
  extra: Record<string, unknown> = {}
) {
  return {
    action: {
      type: "deposit",
      chainId: "eip155:1",
      target: vault,
      asset: { symbol: "USDT", contractAddress: USDT },
      amount,
      recipient: OWNER,
      ...extra,
    },
  };
}

describe("registry Reader", function () {
  this.timeout(10000);

  let dir: string;
  let ratchetFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hedwig-registry-reader-"));
    ratchetFile = join(dir, "ratchet.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function depsFor(
    world: World,
    over: Partial<RegistryDeps> & { signing?: TestKeys } = {}
  ): RegistryDeps {
    const ratchet = createRatchet(ratchetFile);
    const { signing, ...rest } = over;
    return {
      fetch: world.fetch,
      now: () => NOW,
      deadlineMs: REGISTRY_DEADLINE_MS,
      keys: (signing ?? keys).pub,
      registry: () => ({ baseUrl: BASE, ratchet }),
      rpcUrlFor: () => RPC_URL,
      ...rest,
    };
  }

  // Removes the answers with these ids from every chain batch, as a provider
  // that drops entries would.
  const dropAnswers = (world: World, ids: number[]) => {
    const real = world.fetch;
    world.fetch = (async (input: unknown, init?: RequestInit) => {
      const response = await real(input as string, init);
      if (String(input) !== RPC_URL) {
        return response;
      }
      const entries = JSON.parse(await response.text()) as Array<{
        id: number;
      }>;
      return new Response(
        JSON.stringify(entries.filter((e) => !ids.includes(e.id))),
        { status: 200 }
      );
    }) as typeof fetch;
  };

  // The vault's own chain batch: the one that also asks for the block number
  // (the token half sends its own, separate batch for the token's code).
  const vaultBatches = (world: World) =>
    rpcLog(world).filter((entry) => entry.body?.includes("eth_blockNumber"));

  const files = (entries: Array<[string, unknown]>, k: TestKeys = keys) =>
    Object.fromEntries(entries.map(([path, row]) => [path, signed(row, k)]));

  describe("the token half", () => {
    it("returns a Fact for a valid two-signature row inside 800 ms", async () => {
      const world = makeWorld(
        files([[MONAD_PATH, monadUsdcRow()]]),
        monadChain()
      );
      const started = Date.now();
      const facts = await gatherRegistry(PAY_MONAD, depsFor(world));
      expect(Date.now() - started).to.be.lessThan(REGISTRY_DEADLINE_MS);
      expect(facts).to.deep.equal({
        registryAsset: {
          chainId: "eip155:143",
          symbol: "USDC",
          contractAddress: MONAD_USDC,
          expiresAt: EXPIRES_AT_SECONDS,
          liveRead: "confirmed",
          liveReadAt: NOW,
        },
      });
    });

    it("the real Monad USDC proxy fixture reads confirmed from recorded code", () => {
      // The recorded bytes are the real deployed code: their hashes are the
      // ones the registry row publishes, so the next test is a real match.
      expect(sha256OfHex(MONAD_USDC_CODE)).to.equal(MONAD_USDC_HASH);
      expect(sha256OfHex(MONAD_USDC_IMPL_CODE)).to.equal(MONAD_USDC_IMPL_HASH);
    });

    it("reads the row's own slot (ZeppelinOS) and hashes both codes in one batch", async () => {
      const world = makeWorld(
        files([[MONAD_PATH, monadUsdcRow()]]),
        monadChain()
      );
      await gatherRegistry(PAY_MONAD, depsFor(world));
      const rpc = rpcLog(world);
      expect(rpc).to.have.length(1);
      const calls = JSON.parse(rpc[0].body as string);
      expect(calls.map((c: { method: string }) => c.method)).to.deep.equal([
        "eth_getCode",
        "eth_getStorageAt",
        "eth_getCode",
      ]);
      expect(calls[1].params).to.deep.equal([
        MONAD_USDC,
        SLOT_ZEPPELINOS,
        "latest",
      ]);
      expect(calls[2].params).to.deep.equal([MONAD_USDC_IMPL, "latest"]);
    });

    it("matches batch answers by id, not by position", async () => {
      const world = makeWorld(
        files([[MONAD_PATH, monadUsdcRow()]]),
        monadChain()
      );
      world.rpcMode = "reversed";
      const facts = await gatherRegistry(PAY_MONAD, depsFor(world));
      expect(facts.registryAsset?.liveRead).to.equal("confirmed");
    });

    it("reads mismatch when the proxy's code changed", async () => {
      const chain = monadChain();
      chain.code[MONAD_USDC] = MONAD_USDC_CODE.slice(0, -2) + "00";
      const world = makeWorld(files([[MONAD_PATH, monadUsdcRow()]]), chain);
      const facts = await gatherRegistry(PAY_MONAD, depsFor(world));
      expect(facts.registryAsset?.liveRead).to.equal("mismatch");
    });

    it("reads mismatch when the implementation slot holds another address", async () => {
      const chain = monadChain();
      chain.storage[`${MONAD_USDC}:${SLOT_ZEPPELINOS}`] =
        wordOfAddress(SPARK_OTHER_IMPL);
      const world = makeWorld(files([[MONAD_PATH, monadUsdcRow()]]), chain);
      const facts = await gatherRegistry(PAY_MONAD, depsFor(world));
      expect(facts.registryAsset?.liveRead).to.equal("mismatch");
    });

    it("reads mismatch when the implementation's code changed", async () => {
      const chain = monadChain();
      chain.code[MONAD_USDC_IMPL] = MONAD_USDC_IMPL_CODE.slice(0, -2) + "00";
      const world = makeWorld(files([[MONAD_PATH, monadUsdcRow()]]), chain);
      const facts = await gatherRegistry(PAY_MONAD, depsFor(world));
      expect(facts.registryAsset?.liveRead).to.equal("mismatch");
    });

    it("a mismatch is not hidden by another unread entry", async () => {
      const chain = monadChain();
      chain.code[MONAD_USDC] = "0x00";
      const world = makeWorld(files([[MONAD_PATH, monadUsdcRow()]]), chain);
      dropAnswers(world, [3]);
      const facts = await gatherRegistry(PAY_MONAD, depsFor(world));
      expect(facts.registryAsset?.liveRead).to.equal("mismatch");
    });

    it("an unanswered read with no mismatch is unconfirmed", async () => {
      const world = makeWorld(
        files([[MONAD_PATH, monadUsdcRow()]]),
        monadChain()
      );
      dropAnswers(world, [3]);
      const facts = await gatherRegistry(PAY_MONAD, depsFor(world));
      expect(facts.registryAsset?.liveRead).to.equal("unconfirmed");
    });

    for (const mode of ["reject", "http500", "garbage"] as const) {
      it(`reads unconfirmed, not mismatch and not confirmed, when the RPC fails (${mode})`, async () => {
        const world = makeWorld(
          files([[MONAD_PATH, monadUsdcRow()]]),
          monadChain()
        );
        world.rpcMode = mode;
        const facts = await gatherRegistry(PAY_MONAD, depsFor(world));
        expect(facts.registryAsset?.liveRead).to.equal("unconfirmed");
      });
    }

    it("reads unconfirmed when the RPC answers an error for one read", async () => {
      const chain = monadChain();
      const world = makeWorld(files([[MONAD_PATH, monadUsdcRow()]]), chain);
      const real = world.fetch;
      world.fetch = (async (input: unknown, init?: RequestInit) => {
        const response = await real(input as string, init);
        if (String(input) !== RPC_URL) {
          return response;
        }
        const entries = JSON.parse(await response.text());
        entries[1] = {
          jsonrpc: "2.0",
          id: 2,
          error: { code: -32000, message: "x" },
        };
        return new Response(JSON.stringify(entries), { status: 200 });
      }) as typeof fetch;
      const facts = await gatherRegistry(PAY_MONAD, depsFor(world));
      expect(facts.registryAsset?.liveRead).to.equal("unconfirmed");
    });

    it("a missing RPC key answers unconfirmed with no RPC call, never confirmed", async () => {
      const world = makeWorld(
        files([[MONAD_PATH, monadUsdcRow()]]),
        monadChain()
      );
      const facts = await gatherRegistry(
        PAY_MONAD,
        depsFor(world, { rpcUrlFor: () => undefined })
      );
      expect(facts.registryAsset?.liveRead).to.equal("unconfirmed");
      expect(rpcLog(world)).to.have.length(0);
    });

    it("a non-upgradeable row reads one code hash", async () => {
      const chain = emptyChain();
      chain.code[USDT] = USDT_CODE;
      const world = makeWorld(files([[USDT_PATH, usdtRow()]]), chain);
      const facts = await gatherRegistry(PAY_USDT, depsFor(world));
      expect(facts.registryAsset?.liveRead).to.equal("confirmed");
      expect(JSON.parse(rpcLog(world)[0].body as string)).to.have.length(1);
      chain.code[USDT] = USDT_CODE + "00";
      const changed = await gatherRegistry(PAY_USDT, depsFor(world));
      expect(changed.registryAsset?.liveRead).to.equal("mismatch");
    });

    it("an answer past the deadline for the chain batch gives unconfirmed inside the limit", async () => {
      const world = makeWorld(
        files([[MONAD_PATH, monadUsdcRow()]]),
        monadChain()
      );
      const real = world.fetch;
      world.fetch = ((input: unknown, init?: RequestInit) =>
        String(input) === RPC_URL
          ? new Promise<Response>(() => undefined)
          : real(input as string, init)) as typeof fetch;
      const started = Date.now();
      const facts = await gatherRegistry(
        PAY_MONAD,
        depsFor(world, { deadlineMs: 150 })
      );
      expect(Date.now() - started).to.be.lessThan(1000);
      expect(facts.registryAsset?.liveRead).to.equal("unconfirmed");
    });
  });

  describe("a row that cannot be trusted gives no Fact", () => {
    const run = async (text: string | undefined, over = {}) => {
      const world = makeWorld(
        text === undefined ? {} : { [MONAD_PATH]: text },
        monadChain()
      );
      return gatherRegistry(PAY_MONAD, depsFor(world, over));
    };

    it("one signature", async () => {
      const row = Buffer.from(JSON.stringify(monadUsdcRow()));
      expect(await run(envelope(row, { a: keys.a }))).to.deep.equal({});
      expect(await run(envelope(row, { b: keys.b }))).to.deep.equal({});
    });

    it("a signature array of the wrong length", async () => {
      const text = JSON.parse(signed(monadUsdcRow(), keys));
      text.signatures = [text.signatures[0]];
      expect(await run(JSON.stringify(text))).to.deep.equal({});
      text.signatures = [
        ...text.signatures,
        text.signatures[0],
        text.signatures[0],
      ];
      expect(await run(JSON.stringify(text))).to.deep.equal({});
    });

    it("a bad signature", async () => {
      const other = makeKeys();
      const row = Buffer.from(JSON.stringify(monadUsdcRow()));
      expect(await run(envelope(row, { a: keys.a, b: other.b }))).to.deep.equal(
        {}
      );
      expect(await run(envelope(row, { a: other.a, b: keys.b }))).to.deep.equal(
        {}
      );
      // The two signatures in swapped slots.
      const good = JSON.parse(signed(monadUsdcRow(), keys));
      good.signatures.reverse();
      expect(await run(JSON.stringify(good))).to.deep.equal({});
    });

    it("a payload changed after signing", async () => {
      const good = JSON.parse(signed(monadUsdcRow(), keys));
      const edited = Buffer.from(good.payload, "base64").toString("utf8");
      good.payload = Buffer.from(edited.replace('"USDC"', '"USDX"')).toString(
        "base64"
      );
      expect(await run(JSON.stringify(good))).to.deep.equal({});
    });

    it("expired, and not yet valid", async () => {
      expect(
        await run(
          signed(monadUsdcRow({ expiresAt: "2026-10-09T00:00:00Z" }), keys)
        )
      ).to.deep.equal({});
      expect(
        await run(
          signed(monadUsdcRow({ verifiedAt: "2026-10-11T00:00:00Z" }), keys)
        )
      ).to.deep.equal({});
    });

    it("unreachable", async () => {
      const world = makeWorld({}, monadChain());
      world.fetch = (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch;
      expect(await gatherRegistry(PAY_MONAD, depsFor(world))).to.deep.equal({});
    });

    it("a host that never answers, inside the limit", async () => {
      const world = makeWorld({}, monadChain());
      world.fetch = (() =>
        new Promise<Response>(() => undefined)) as typeof fetch;
      const started = Date.now();
      const facts = await gatherRegistry(
        PAY_MONAD,
        depsFor(world, { deadlineMs: 100 })
      );
      expect(facts).to.deep.equal({});
      expect(Date.now() - started).to.be.lessThan(1000);
    });

    it("404, a server error and a redirect", async () => {
      expect(await run(undefined)).to.deep.equal({});
      const world = makeWorld({}, monadChain());
      world.fetch = (async () =>
        new Response("boom", { status: 500 })) as unknown as typeof fetch;
      expect(await gatherRegistry(PAY_MONAD, depsFor(world))).to.deep.equal({});
      const seen: Array<RequestInit | undefined> = [];
      world.fetch = (async (_url: unknown, init?: RequestInit) => {
        seen.push(init);
        throw new TypeError("redirect mode is error");
      }) as unknown as typeof fetch;
      await gatherRegistry(PAY_MONAD, depsFor(world));
      expect(seen[0]?.redirect).to.equal("error");
    });

    it("an oversized body", async () => {
      const world = makeWorld({}, monadChain());
      world.fetch = (async () =>
        new Response("x".repeat(300 * 1024), {
          status: 200,
        })) as unknown as typeof fetch;
      expect(await gatherRegistry(PAY_MONAD, depsFor(world))).to.deep.equal({});
    });

    const malformed: Array<[string, Record<string, unknown>]> = [
      ["schemaVersion 2", { schemaVersion: 2 }],
      ["a string chainId", { chainId: "143" }],
      [
        "an uppercase address",
        { contractAddress: MONAD_USDC.toUpperCase().replace("0X", "0x") },
      ],
      ["a short code hash", { codeSha256: "abcd" }],
      ["sequence 0", { sequence: 0 }],
      ["a non-ISO date", { verifiedAt: "yesterday" }],
      ["expiresAt before verifiedAt", { expiresAt: "2026-10-01T00:00:00Z" }],
      ["no upgradeable", { upgradeable: undefined }],
      ["upgradeable true", { upgradeable: true }],
      ["a lowercase symbol", { symbol: "usdc" }],
      [
        "a slot that is not the kind's",
        {
          upgradeable: {
            kind: "zeppelinos",
            slot: SLOT_EIP1967,
            implementation: MONAD_USDC_IMPL,
            implementationCodeSha256: MONAD_USDC_IMPL_HASH,
          },
        },
      ],
      [
        "a proxy with no pinned hash",
        {
          upgradeable: {
            kind: "zeppelinos",
            slot: SLOT_ZEPPELINOS,
            implementation: MONAD_USDC_IMPL,
          },
        },
      ],
      ["type vault on a token path", { type: "vault" }],
    ];
    for (const [name, patch] of malformed) {
      it(`malformed: ${name}`, async () => {
        expect(await run(signed(monadUsdcRow({ patch }), keys))).to.deep.equal(
          {}
        );
      });
    }

    it("malformed: a payload that is not JSON, or not an object", async () => {
      expect(await run(envelope(Buffer.from("not json"), keys))).to.deep.equal(
        {}
      );
      expect(await run(envelope(Buffer.from("[1]"), keys))).to.deep.equal({});
      expect(await run(envelope(Buffer.from("null"), keys))).to.deep.equal({});
    });

    it("malformed: an envelope that is not an envelope", async () => {
      expect(await run("not json")).to.deep.equal({});
      expect(await run("[]")).to.deep.equal({});
      expect(
        await run('{"v":2,"payload":"AA==","signatures":[null,null]}')
      ).to.deep.equal({});
      const extra = JSON.parse(signed(monadUsdcRow(), keys));
      extra.note = "x";
      expect(await run(JSON.stringify(extra))).to.deep.equal({});
    });

    it("a row served at another symbol's path", async () => {
      const world = makeWorld(
        { [MONAD_PATH]: signed(monadUsdcRow({ symbol: "USDT" }), keys) },
        monadChain()
      );
      expect(await gatherRegistry(PAY_MONAD, depsFor(world))).to.deep.equal({});
    });

    it("a row for another chain served at this chain's path", async () => {
      const world = makeWorld(
        { [MONAD_PATH]: signed(monadUsdcRow({ chainId: 1 }), keys) },
        monadChain()
      );
      expect(await gatherRegistry(PAY_MONAD, depsFor(world))).to.deep.equal({});
    });
  });

  describe("the keys", () => {
    it("the shipped constants are empty and reject every row", async () => {
      expect(PINNED_REGISTRY_KEYS).to.deep.equal({ a: "", b: "" });
      const world = makeWorld(
        files([[MONAD_PATH, monadUsdcRow()]]),
        monadChain()
      );
      const facts = await gatherRegistry(
        PAY_MONAD,
        depsFor(world, { keys: PINNED_REGISTRY_KEYS })
      );
      expect(facts).to.deep.equal({});
      expect(world.log).to.have.length(0);
    });

    it("reads no registry config when the keys are unusable", async () => {
      // An unusable key set must not make the Reader ask for the host
      // setting, which logs a line naming an unset variable.
      let asked = 0;
      const world = makeWorld(
        files([[MONAD_PATH, monadUsdcRow()]]),
        monadChain()
      );
      const facts = await gatherRegistry(
        PAY_MONAD,
        depsFor(world, {
          keys: PINNED_REGISTRY_KEYS,
          registry: () => {
            asked += 1;
            return undefined;
          },
        })
      );
      expect(facts).to.deep.equal({});
      expect(asked).to.equal(0);
    });

    it("rejects every row for an empty, equal, short or non-base64 key", async () => {
      const world = makeWorld(
        files([[MONAD_PATH, monadUsdcRow()]]),
        monadChain()
      );
      const bad: Array<{ a: string; b: string }> = [
        { a: "", b: keys.pub.b },
        { a: keys.pub.a, b: "" },
        { a: keys.pub.a, b: keys.pub.a },
        { a: keys.pub.a, b: "AAAA" },
        { a: "!!!", b: keys.pub.b },
      ];
      for (const pair of bad) {
        expect(
          await gatherRegistry(PAY_MONAD, depsFor(world, { keys: pair }))
        ).to.deep.equal({});
      }
      expect(world.log).to.have.length(0);
    });

    it("keys in the request or the policy never replace the pinned keys", async () => {
      const attacker = makeKeys();
      const world = makeWorld(
        files([[MONAD_PATH, monadUsdcRow()]], attacker),
        monadChain()
      );
      const request = {
        ...PAY_MONAD,
        keys: attacker.pub,
        registryKeys: attacker.pub,
        action: { ...PAY_MONAD.action, keys: attacker.pub },
      };
      expect(await gatherRegistry(request, depsFor(world))).to.deep.equal({});
    });
  });

  describe("zero network calls", () => {
    const quiet = async (request: unknown) => {
      const world = makeWorld(
        files([[MONAD_PATH, monadUsdcRow()]]),
        monadChain()
      );
      const facts = await gatherRegistry(request, depsFor(world));
      expect(world.log, JSON.stringify(request)).to.have.length(0);
      expect(facts).to.deep.equal({});
    };
    const pay = (chainId: string, symbol: string, extra = {}) => ({
      action: {
        type: "pay",
        chainId,
        recipient: OWNER,
        asset: { symbol, contractAddress: MONAD_USDC },
        amount: "1",
        target: MONAD_USDC,
        ...extra,
      },
    });

    it("Ethereum USDC and Base USDC, which the code table lists", async () => {
      await quiet(pay("eip155:1", "USDC"));
      await quiet(pay("eip155:8453", "USDC"));
      await quiet(pay("eip155:1", "WETH"));
    });

    it("an invalid symbol", async () => {
      for (const symbol of [
        "",
        "usdc",
        "USD C",
        "USDC/../../x",
        "USDC%2F",
        "USDC.json",
        "ÜSDC",
        "USDС", // Cyrillic С
        "A".repeat(21),
        "USDC\n",
        "constructor",
        "__proto__",
      ]) {
        await quiet(pay("eip155:143", symbol));
      }
      await quiet({
        action: { type: "pay", chainId: "eip155:143", asset: { symbol: 5 } },
      });
      await quiet({ action: { type: "pay", chainId: "eip155:143" } });
    });

    it("a non-EVM chain and a malformed chain id", async () => {
      await quiet(pay("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "USDC"));
      for (const chainId of [
        "eip155:",
        "eip155:0",
        "eip155:01",
        "eip155:1/../../x",
        "eip155:1?x=1",
        "eip155:1 ",
        "eip155:1\n",
        "eip155:1234567890123456",
        "EIP155:1",
        "1",
        "",
      ]) {
        await quiet(pay(chainId, "USDC"));
      }
    });

    it("an action type with no registry question, and a malformed request", async () => {
      await quiet(pay("eip155:143", "USDC", { type: "approve" }));
      await quiet({});
      await quiet(null);
      await quiet("pay");
      await quiet({ action: null });
      await quiet({ action: [] });
    });

    it("a deposit whose target is not an address", async () => {
      for (const target of [
        undefined,
        STEAK + "?x=1",
        STEAK + "/../x",
        "0x1234",
        "0x" + "g".repeat(40),
      ]) {
        const request = deposit(target as string, "1000000");
        request.action.asset = { symbol: "USDC", contractAddress: USDT };
        request.action.chainId = "eip155:1";
        await quiet(request);
      }
    });
  });

  describe("only a chain number, a symbol and an address reach a URL", () => {
    const ALLOWED_ROW_URL = new RegExp(
      `^${BASE.replace(
        /\./g,
        "\\."
      )}/v1/(eip155-[1-9][0-9]{0,14}/[A-Z0-9]{1,20}|vaults/eip155-[1-9][0-9]{0,14}/0x[0-9a-f]{40})\\.json$`
    );

    it("every request URL is the configured base plus a fixed path, or the configured RPC", async () => {
      const world = makeWorld(
        files([
          [MONAD_PATH, monadUsdcRow()],
          [USDT_PATH, usdtRow()],
          [STEAK_PATH, steakRow()],
        ]),
        {
          ...steakChain(),
          code: { ...monadChain().code, ...steakChain().code },
          storage: { ...monadChain().storage },
        }
      );
      const stuffed = {
        registryUrl: "https://evil.test",
        baseUrl: "https://evil.test",
        rpcUrl: "https://evil.test/rpc",
        rpc: ["https://evil.test/rpc"],
        host: "evil.test",
        keys: keys.pub,
      };
      const requests = [
        {
          ...PAY_MONAD,
          ...stuffed,
          action: { ...PAY_MONAD.action, ...stuffed },
        },
        { ...PAY_USDT, ...stuffed, action: { ...PAY_USDT.action, ...stuffed } },
        {
          ...deposit(
            STEAK.toUpperCase().replace("0X", "0x"),
            "1000000",
            stuffed
          ),
          ...stuffed,
        },
      ];
      for (const request of requests) {
        await gatherRegistry(request, depsFor(world));
      }
      expect(world.log.length).to.be.greaterThan(0);
      for (const entry of world.log) {
        if (entry.url === RPC_URL) {
          expect(entry.method).to.equal("POST");
        } else {
          expect(entry.method).to.equal("GET");
          expect(entry.url).to.match(ALLOWED_ROW_URL);
        }
        expect(entry.url).to.not.include("evil.test");
        expect(entry.body ?? "").to.not.include("evil.test");
      }
    });

    it("hostile fields never become a request at all", async () => {
      const world = makeWorld({}, emptyChain());
      const hostile = [
        "USDC/../../etc",
        "USDC?x=1",
        "USDC#x",
        "USDC@evil.test",
        "USDC:80",
        "USDC\r\nHost: evil.test",
      ];
      for (const symbol of hostile) {
        await gatherRegistry(
          { action: { ...PAY_MONAD.action, asset: { symbol } } },
          depsFor(world)
        );
      }
      for (const chainId of [
        "eip155:143/../1",
        "eip155:143?x",
        "eip155:143@evil.test",
      ]) {
        await gatherRegistry(
          { action: { ...PAY_MONAD.action, chainId } },
          depsFor(world)
        );
      }
      expect(world.log).to.have.length(0);
    });

    it("a base URL that carries a query, a fragment or credentials is never used", async () => {
      const world = makeWorld(
        files([[MONAD_PATH, monadUsdcRow()]]),
        monadChain()
      );
      for (const baseUrl of [
        `${BASE}?x=1`,
        `${BASE}#x`,
        `https://user:pass@registry.test`,
      ]) {
        const ratchet = createRatchet(ratchetFile);
        const facts = await gatherRegistry(
          PAY_MONAD,
          depsFor(world, { registry: () => ({ baseUrl, ratchet }) })
        );
        expect(facts).to.deep.equal({});
      }
      expect(world.log).to.have.length(0);
    });
  });

  describe("the sequence ratchet", () => {
    it("refuses a lower sequence and accepts an equal or higher one", async () => {
      const at = async (sequence: number) => {
        const world = makeWorld(
          files([[MONAD_PATH, monadUsdcRow({ sequence })]]),
          monadChain()
        );
        return gatherRegistry(PAY_MONAD, depsFor(world));
      };
      expect((await at(5)).registryAsset).to.not.equal(undefined);
      expect(await at(3)).to.deep.equal({});
      expect((await at(5)).registryAsset).to.not.equal(undefined);
      expect((await at(6)).registryAsset).to.not.equal(undefined);
      expect(await at(5)).to.deep.equal({});
    });

    it("a row that fails verification never moves the ratchet", async () => {
      const at = async (text: string) => {
        const world = makeWorld({ [MONAD_PATH]: text }, monadChain());
        return gatherRegistry(PAY_MONAD, depsFor(world));
      };
      const other = makeKeys();
      expect(
        await at(signed(monadUsdcRow({ sequence: 9 }), other))
      ).to.deep.equal({});
      expect(
        await at(
          signed(
            monadUsdcRow({ sequence: 9, expiresAt: "2026-10-09T00:00:00Z" }),
            keys
          )
        )
      ).to.deep.equal({});
      expect(
        (await at(signed(monadUsdcRow({ sequence: 2 }), keys))).registryAsset
      ).to.not.equal(undefined);
    });

    const lines = (file: string) =>
      readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line));

    it("appends one line per raised sequence, and a fresh process reads it back", () => {
      const first = createRatchet(ratchetFile);
      expect(first.admit("token:143:USDC", 4)).to.equal(true);
      expect(lines(ratchetFile)).to.deep.equal([
        { key: "token:143:USDC", sequence: 4 },
      ]);
      const second = createRatchet(ratchetFile);
      expect(second.admit("token:143:USDC", 3)).to.equal(false);
      expect(second.admit("token:143:USDC", 4)).to.equal(true);
      expect(second.admit("token:143:USDC", 7)).to.equal(true);
      expect(second.admit("vault:1:x", 1)).to.equal(true);
      expect(lines(ratchetFile)).to.deep.equal([
        { key: "token:143:USDC", sequence: 4 },
        { key: "token:143:USDC", sequence: 7 },
        { key: "vault:1:x", sequence: 1 },
      ]);
      expect(createRatchet(ratchetFile).admit("token:143:USDC", 6)).to.equal(
        false
      );
    });

    function runWorker(
      prefix: string,
      count: number,
      retryMs: number,
      onStderr?: (output: string) => void
    ): Promise<{ code: number | null; stderr: string }> {
      return new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            "-r",
            "ts-node/register/transpile-only",
            join(__dirname, "ratchet-worker.ts"),
            ratchetFile,
            prefix,
            String(count),
            "0",
            String(retryMs),
          ],
          {
            env: {
              ...process.env,
              TS_NODE_PROJECT: join(__dirname, "..", "tsconfig.test.json"),
            },
            stdio: ["ignore", "ignore", "pipe"],
            timeout: 8000,
          }
        );
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
          onStderr?.(stderr);
        });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stderr }));
      });
    }

    it("the worker retries the same key after an incomplete line is finished", async () => {
      writeFileSync(ratchetFile, '{"key":"seed","sequence":5');
      let completed = false;
      const result = await runWorker("retry", 2, 1000, (output) => {
        if (!completed && output.includes("not a list of sequences")) {
          // The child has already rejected its first key. Finish the writer's
          // line only after that rejection, without relying on a timed sleep.
          completed = true;
          appendFileSync(ratchetFile, "}\n");
        }
      });
      expect(completed).to.equal(true);
      expect(result.code, result.stderr).to.equal(0);
      expect(lines(ratchetFile)).to.deep.equal([
        { key: "seed", sequence: 5 },
        { key: "token:retry:0", sequence: 5 },
        { key: "token:retry:1", sequence: 5 },
      ]);
    });

    it("the worker exits unsuccessfully when rejection does not clear", async () => {
      const corrupt = "not a sequence\n";
      writeFileSync(ratchetFile, corrupt);
      const result = await runWorker("blocked", 1, 50);
      expect(result.code, result.stderr).to.equal(1);
      expect(result.stderr).to.include("timed out admitting token:blocked:0");
      expect(readFileSync(ratchetFile, "utf8")).to.equal(corrupt);
    });

    it("loses no entry when several server processes write one file", async function () {
      this.timeout(60000);
      const workers = 4;
      const perWorker = 200;
      const startAt = Date.now() + 4000;
      const env = {
        ...process.env,
        TS_NODE_PROJECT: join(__dirname, "..", "tsconfig.test.json"),
      };
      await Promise.all(
        Array.from(
          { length: workers },
          (_, w) =>
            new Promise<void>((resolve, reject) => {
              const child = spawn(
                process.execPath,
                [
                  "-r",
                  "ts-node/register/transpile-only",
                  join(__dirname, "ratchet-worker.ts"),
                  ratchetFile,
                  String(w),
                  String(perWorker),
                  String(startAt),
                ],
                { env, stdio: "inherit" }
              );
              child.on("error", reject);
              child.on("close", (code) =>
                code === 0
                  ? resolve()
                  : reject(new Error(`worker ${w} exited ${code}`))
              );
            })
        )
      );
      const persisted = readFileSync(ratchetFile, "utf8");
      expect(persisted.endsWith("\n")).to.equal(true);
      expect(lines(ratchetFile)).to.have.length(workers * perWorker);
      const fresh = createRatchet(ratchetFile);
      for (let w = 0; w < workers; w += 1) {
        for (let i = 0; i < perWorker; i += 1) {
          expect(fresh.admit(`token:${w}:${i}`, 5)).to.equal(true);
        }
      }
      expect(readFileSync(ratchetFile, "utf8")).to.equal(persisted);
      let lost = 0;
      for (let w = 0; w < workers; w += 1) {
        for (let i = 0; i < perWorker; i += 1) {
          if (fresh.admit(`token:${w}:${i}`, 4)) {
            lost += 1;
          }
        }
      }
      expect(lost).to.equal(0);
      expect(lines(ratchetFile)).to.have.length(workers * perWorker);
    });

    it("creates the file with mode 600 and its folders with mode 700", () => {
      const nested = join(dir, "a", "b", "ratchet.json");
      expect(createRatchet(nested).admit("k", 1)).to.equal(true);
      expect(statSync(nested).mode & 0o777).to.equal(0o600);
      expect(statSync(join(dir, "a", "b")).mode & 0o777).to.equal(0o700);
      expect(statSync(join(dir, "a")).mode & 0o777).to.equal(0o700);
    });

    it("falls back to memory when the file cannot be written", () => {
      // A path under a regular file: neither the read nor the write works.
      writeFileSync(join(dir, "plain"), "x");
      const blocked = join(dir, "plain", "sub", "ratchet.json");
      const warnings: string[] = [];
      const realError = console.error;
      console.error = (line: unknown) => warnings.push(String(line));
      try {
        const ratchet = createRatchet(blocked);
        expect(ratchet.admit("k", 5)).to.equal(true);
        expect(ratchet.admit("k", 3)).to.equal(false);
        expect(ratchet.admit("k", 5)).to.equal(true);
        expect(ratchet.admit("k", 6)).to.equal(true);
        expect(ratchet.admit("k", 5)).to.equal(false);
      } finally {
        console.error = realError;
      }
      expect(warnings.some((w) => w.includes("memory only"))).to.equal(true);
      expect(warnings.join("\n")).to.not.include(dir);
    });

    it("keeps its table in memory when the directory cannot be created, and never throws", () => {
      writeFileSync(join(dir, "plain"), "x");
      const ratchet = createRatchet(join(dir, "plain", "ratchet.json"));
      const realError = console.error;
      console.error = () => undefined;
      try {
        expect(() => ratchet.admit("k", 1)).to.not.throw();
      } finally {
        console.error = realError;
      }
    });

    it("a file that is not a table of sequences fails closed and is left alone", () => {
      const realError = console.error;
      console.error = () => undefined;
      try {
        for (const content of [
          "not json\n",
          "[]\n",
          "null\n",
          '{"key":"k","sequence":0}\n',
          '{"key":"k","sequence":"1"}\n',
          '{"key":"k","sequence":1.5}\n',
          '{"key":1,"sequence":1}\n',
          '{"key":"k"}\n',
          '{"key":"k","sequence":2}\nnot json\n',
          '{"key":"k","sequence":2}\n{"key":"k","sequence":3',
          '{"key":"k","sequence":2}',
        ]) {
          writeFileSync(ratchetFile, content);
          const ratchet = createRatchet(ratchetFile);
          expect(ratchet.admit("k", 3), content).to.equal(false);
          expect(readFileSync(ratchetFile, "utf8")).to.equal(content);
        }
      } finally {
        console.error = realError;
      }
    });

    it("a corrupt file gives no Fact through the Reader", async () => {
      writeFileSync(ratchetFile, "garbage");
      const realError = console.error;
      console.error = () => undefined;
      try {
        const world = makeWorld(
          files([[MONAD_PATH, monadUsdcRow()]]),
          monadChain()
        );
        expect(await gatherRegistry(PAY_MONAD, depsFor(world))).to.deep.equal(
          {}
        );
      } finally {
        console.error = realError;
      }
    });

    it("keys the token row and the vault row apart", async () => {
      const chain = { ...steakChain(), code: { ...steakChain().code } };
      const world = makeWorld(
        files([
          [USDT_PATH, usdtRow({ sequence: 4 })],
          [STEAK_PATH, steakRow({ sequence: 1 })],
        ]),
        chain
      );
      const facts = await gatherRegistry(
        deposit(STEAK, "1000000"),
        depsFor(world)
      );
      expect(facts.registryAsset).to.not.equal(undefined);
      expect(facts.registryVault).to.not.equal(undefined);
      expect(lines(ratchetFile)).to.deep.equal([
        { key: "token:1:USDT", sequence: 4 },
        { key: `vault:1:${STEAK}`, sequence: 1 },
      ]);
    });
  });

  describe("never throws", () => {
    it("survives hostile requests, deps and responses", async () => {
      const world = makeWorld(
        files([[MONAD_PATH, monadUsdcRow()]]),
        monadChain()
      );
      const trap = new Proxy(
        {},
        {
          get() {
            throw new Error("read");
          },
          has() {
            throw new Error("has");
          },
          ownKeys() {
            throw new Error("keys");
          },
        }
      );
      const requests = [
        trap,
        { action: trap },
        { action: { type: "pay", chainId: "eip155:143", asset: trap } },
        {
          get action(): never {
            throw new Error("getter");
          },
        },
      ];
      for (const request of requests) {
        expect(await gatherRegistry(request, depsFor(world))).to.deep.equal({});
      }
      const throwingNow = depsFor(world, {
        now: () => {
          throw new Error("clock");
        },
      });
      expect(await gatherRegistry(PAY_MONAD, throwingNow)).to.deep.equal({});
      const throwingRegistry = depsFor(world, {
        registry: () => {
          throw new Error("config");
        },
      });
      expect(await gatherRegistry(PAY_MONAD, throwingRegistry)).to.deep.equal(
        {}
      );
      const throwingRpc = depsFor(world, {
        rpcUrlFor: () => {
          throw new Error("rpc");
        },
      });
      expect(await gatherRegistry(PAY_MONAD, throwingRpc)).to.deep.equal({});
      const throwingFetch = depsFor(world, {
        fetch: (() => {
          throw new Error("sync");
        }) as unknown as typeof fetch,
      });
      expect(await gatherRegistry(PAY_MONAD, throwingFetch)).to.deep.equal({});
    });
  });

  describe("the vault half", () => {
    const registryFiles = (
      vaultPath: string,
      vault: unknown,
      token: unknown = usdtRow()
    ) =>
      files([
        [USDT_PATH, token],
        [vaultPath, vault],
      ]);

    const steakWorld = (over: Partial<ChainState> = {}) =>
      makeWorld(registryFiles(STEAK_PATH, steakRow()), {
        ...steakChain(),
        ...over,
      });

    it("returns a Fact for a valid two-signature vault row inside 800 ms (steakUSDT)", async () => {
      const world = steakWorld();
      const started = Date.now();
      const facts = await gatherRegistry(
        deposit(STEAK, "1000000"),
        depsFor(world)
      );
      expect(Date.now() - started).to.be.lessThan(REGISTRY_DEADLINE_MS);
      expect(facts.registryVault).to.deep.equal({
        chainId: "eip155:1",
        contractAddress: STEAK,
        asset: USDT,
        upgradeable: "none",
        expiresAt: EXPIRES_AT_SECONDS,
        vaultCodeHash: "match",
        implementationSlot: ZERO_WORD,
        assetRead: USDT,
        preview: { shares: "882612176477205266" },
        blockNumber: 26110209,
        liveReadAt: NOW,
      });
      expect(facts.registryAsset?.symbol).to.equal("USDT");
    });

    it("steakUSDT keeps its chain reads at 300 ms per network hop", async () => {
      // USDT is not in the code table, so the vault waits for the token row.
      // It must wait for that row only, not for the token's own chain read:
      // row fetches, then the token batch beside the vault batch, is two
      // hops after the rows, not three.
      const world = steakWorld();
      const real = world.fetch;
      world.fetch = (async (input: unknown, init?: RequestInit) => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return real(input as string, init);
      }) as typeof fetch;
      const started = Date.now();
      const facts = await gatherRegistry(
        deposit(STEAK, "1000000"),
        depsFor(world)
      );
      expect(Date.now() - started).to.be.lessThan(REGISTRY_DEADLINE_MS);
      expect(facts.registryVault?.vaultCodeHash).to.equal("match");
      expect(facts.registryVault?.implementationSlot).to.equal(ZERO_WORD);
      expect(facts.registryVault?.assetRead).to.equal(USDT);
      expect(facts.registryVault?.preview).to.deep.equal({
        shares: "882612176477205266",
      });
      expect(facts.registryAsset?.liveRead).to.equal("confirmed");
    });

    it("steakUSDT reads slot zero and canonical USDT from asset()", async () => {
      const facts = await gatherRegistry(
        deposit(STEAK, "1000000"),
        depsFor(steakWorld())
      );
      expect(facts.registryVault?.implementationSlot).to.equal(ZERO_WORD);
      expect(facts.registryVault?.assetRead).to.equal(USDT);
      expect(facts.registryVault?.implementationCodeHash).to.equal(undefined);
      expect(facts.registryVault?.implementation).to.equal(undefined);
    });

    it("accepts a checksummed vault address and fetches the lowercase path", async () => {
      const world = steakWorld();
      const checksummed = "0xbEef047a543E45807105E51A8BBEFCc5950fcfBa";
      const facts = await gatherRegistry(
        deposit(checksummed, "1000000"),
        depsFor(world)
      );
      expect(facts.registryVault?.contractAddress).to.equal(STEAK);
      expect(rowLog(world).map((e) => e.url)).to.include(
        `${BASE}/${STEAK_PATH}`
      );
    });

    it("reads everything in one batch on the request's chain, with the vault and the amount only", async () => {
      const world = steakWorld();
      const request = deposit(STEAK, "1000000", {
        transaction: {
          from: "0x00000000000000000000000000000000dead0001",
          to: STEAK,
          data: "0xdeadbeefcafe",
          value: "0",
        },
      });
      await gatherRegistry(request, depsFor(world));
      const rpc = vaultBatches(world);
      expect(rpc).to.have.length(1);
      const body = rpc[0].body as string;
      const calls = JSON.parse(body) as Array<{
        method: string;
        params: unknown[];
      }>;
      expect(calls.map((c) => c.method).sort()).to.deep.equal(
        [
          "eth_blockNumber",
          "eth_call",
          "eth_call",
          "eth_getCode",
          "eth_getStorageAt",
        ].sort()
      );
      expect(body).to.include(STEAK);
      expect(body).to.include(previewCall(STEAK, 1000000n).split(":")[1]);
      expect(body.toLowerCase()).to.not.include(OWNER.slice(2));
      expect(body.toLowerCase()).to.not.include("dead0001");
      expect(body).to.not.include("deadbeefcafe");
      expect(body).to.not.include(SLOT_BEACON);
      expect(body).to.not.include(SLOT_ZEPPELINOS);
      expect(body).to.include(SLOT_EIP1967);
    });

    it("sends previewDeposit of the stated amount", async () => {
      const chain = steakChain(1n);
      chain.calls[previewCall(STEAK, 1n)] = wordOfNumber(88261217n);
      const world = steakWorld(chain);
      const facts = await gatherRegistry(deposit(STEAK, "1"), depsFor(world));
      expect(facts.registryVault?.preview).to.deep.equal({
        shares: "88261217",
      });
      expect(vaultBatches(world)[0].body).to.include(
        "0xef8b30f7" + "0".repeat(63) + "1"
      );
    });

    it("a preview of 0 is a share count of 0, not a failure", async () => {
      const chain = steakChain();
      chain.calls[previewCall(STEAK, 1000000n)] = wordOfNumber(0n);
      const facts = await gatherRegistry(
        deposit(STEAK, "1000000"),
        depsFor(steakWorld(chain))
      );
      expect(facts.registryVault?.preview).to.deep.equal({ shares: "0" });
    });

    it("a reverting preview returns the failure flag, never a 0", async () => {
      const chain = steakChain();
      chain.calls[previewCall(STEAK, 1000000n)] = "revert";
      const facts = await gatherRegistry(
        deposit(STEAK, "1000000"),
        depsFor(steakWorld(chain))
      );
      expect(facts.registryVault?.preview).to.deep.equal({ failed: true });
      expect(facts.registryVault?.vaultCodeHash).to.equal("match");
    });

    it("a missing, malformed or oversized amount sends no preview and flags failure", async () => {
      for (const amount of [
        undefined,
        "-1",
        "1.5",
        "0x10",
        "",
        "9".repeat(80),
        "9".repeat(78),
      ]) {
        const world = steakWorld();
        const request = deposit(STEAK, amount as string);
        const facts = await gatherRegistry(request, depsFor(world));
        expect(facts.registryVault?.preview, String(amount)).to.deep.equal({
          failed: true,
        });
        expect(vaultBatches(world)[0].body).to.not.include("0xef8b30f7");
      }
    });

    it("a code hash that does not match is a Fact that carries mismatch", async () => {
      const world = steakWorld({
        code: { [USDT]: USDT_CODE, [STEAK]: STEAK_CODE + "00" },
      });
      const facts = await gatherRegistry(
        deposit(STEAK, "1000000"),
        depsFor(world)
      );
      expect(facts.registryVault?.vaultCodeHash).to.equal("mismatch");
      expect(facts.registryVault?.assetRead).to.equal(USDT);
    });

    it("an asset() other than the canonical token is reported, not judged", async () => {
      const chain = steakChain();
      chain.calls[`${STEAK}:${ASSET_CALL}`] = wordOfAddress(SPARK_OTHER_IMPL);
      const facts = await gatherRegistry(
        deposit(STEAK, "1000000"),
        depsFor(steakWorld(chain))
      );
      expect(facts.registryVault?.assetRead).to.equal(SPARK_OTHER_IMPL);
    });

    it("an asset() word that is not an address reads unread", async () => {
      const chain = steakChain();
      chain.calls[`${STEAK}:${ASSET_CALL}`] = "0x" + "1".repeat(64);
      const facts = await gatherRegistry(
        deposit(STEAK, "1000000"),
        depsFor(steakWorld(chain))
      );
      expect(facts.registryVault?.assetRead).to.equal("unread");
    });

    for (const mode of ["reject", "http500", "garbage"] as const) {
      it(`an RPC failure keeps the row's Fact with every read unread (${mode})`, async () => {
        const world = steakWorld();
        world.rpcMode = mode;
        const facts = await gatherRegistry(
          deposit(STEAK, "1000000"),
          depsFor(world)
        );
        expect(facts.registryVault).to.deep.equal({
          chainId: "eip155:1",
          contractAddress: STEAK,
          asset: USDT,
          upgradeable: "none",
          expiresAt: EXPIRES_AT_SECONDS,
          vaultCodeHash: "unread",
          implementationSlot: "unread",
          assetRead: "unread",
          preview: { failed: true },
          liveReadAt: NOW,
        });
      });
    }

    it("a missing RPC URL keeps the row's Fact with every read unread and makes no RPC call", async () => {
      const world = steakWorld();
      const facts = await gatherRegistry(
        deposit(STEAK, "1000000"),
        depsFor(world, { rpcUrlFor: () => undefined })
      );
      expect(facts.registryVault?.vaultCodeHash).to.equal("unread");
      expect(rpcLog(world)).to.have.length(0);
    });

    it("an unanswered chain batch still settles inside the limit with a Fact", async () => {
      const world = steakWorld();
      const real = world.fetch;
      world.fetch = ((input: unknown, init?: RequestInit) =>
        String(input) === RPC_URL
          ? new Promise<Response>(() => undefined)
          : real(input as string, init)) as typeof fetch;
      const started = Date.now();
      const facts = await gatherRegistry(
        deposit(STEAK, "1000000"),
        depsFor(world, { deadlineMs: 150 })
      );
      expect(Date.now() - started).to.be.lessThan(1000);
      expect(facts.registryVault?.vaultCodeHash).to.equal("unread");
    });

    it("matches batch answers by id", async () => {
      const world = steakWorld();
      world.rpcMode = "reversed";
      const facts = await gatherRegistry(
        deposit(STEAK, "1000000"),
        depsFor(world)
      );
      expect(facts.registryVault?.vaultCodeHash).to.equal("match");
      expect(facts.registryVault?.preview).to.deep.equal({
        shares: "882612176477205266",
      });
    });

    describe("a Spark-style proxy", () => {
      const sparkWorld = (chain: ChainState, row = sparkRow()) =>
        makeWorld(registryFiles(SPARK_PATH, row), chain);
      const read = async (world: World) =>
        (await gatherRegistry(deposit(SPARK, "1000000"), depsFor(world)))
          .registryVault;

      it("base case: the pin matches the slot and the implementation's code", async () => {
        const world = sparkWorld(sparkChain());
        const vault = await read(world);
        expect(vault).to.deep.equal({
          chainId: "eip155:1",
          contractAddress: SPARK,
          asset: USDT,
          upgradeable: "eip1967",
          implementation: {
            address: SPARK_IMPL,
            codeSha256: sha256OfHex(SPARK_IMPL_CODE),
          },
          expiresAt: EXPIRES_AT_SECONDS,
          vaultCodeHash: "match",
          implementationSlot: wordOfAddress(SPARK_IMPL),
          implementationCodeHash: "match",
          assetRead: USDT,
          preview: { shares: "1000000" },
          blockNumber: 26110209,
          liveReadAt: NOW,
        });
      });

      it("reads the implementation's code at the pinned address in the same batch as the slot", async () => {
        const world = sparkWorld(sparkChain());
        await read(world);
        const rpc = vaultBatches(world);
        expect(rpc).to.have.length(1);
        const calls = JSON.parse(rpc[0].body as string) as Array<{
          method: string;
          params: unknown[];
        }>;
        const codes = calls.filter((c) => c.method === "eth_getCode");
        expect(codes.map((c) => c.params[0])).to.have.members([
          SPARK,
          SPARK_IMPL,
        ]);
        expect(
          calls.filter((c) => c.method === "eth_getStorageAt")
        ).to.have.length(1);
      });

      it("upgraded: the proxy's own hash matches and the slot holds another address", async () => {
        const chain = sparkChain();
        chain.storage[`${SPARK}:${SLOT_EIP1967}`] =
          wordOfAddress(SPARK_OTHER_IMPL);
        const vault = await read(sparkWorld(chain));
        expect(vault?.vaultCodeHash).to.equal("match");
        expect(vault?.implementationSlot).to.equal(
          wordOfAddress(SPARK_OTHER_IMPL)
        );
        expect(vault?.implementation?.address).to.equal(SPARK_IMPL);
      });

      it("code swapped: the slot equals the pin and the implementation's hash mismatches", async () => {
        const chain = sparkChain();
        chain.code[SPARK_IMPL] = SPARK_IMPL_CODE + "00";
        const vault = await read(sparkWorld(chain));
        expect(vault?.implementationSlot).to.equal(wordOfAddress(SPARK_IMPL));
        expect(vault?.implementationCodeHash).to.equal("mismatch");
      });

      it("unpinned: a none row whose slot reads an implementation", async () => {
        const chain = sparkChain();
        const row = sparkRow({
          upgradeable: "none",
          implementation: undefined,
        });
        const vault = await read(sparkWorld(chain, row));
        expect(vault?.upgradeable).to.equal("none");
        expect(vault?.implementationSlot).to.equal(wordOfAddress(SPARK_IMPL));
        expect(vault?.implementationCodeHash).to.equal(undefined);
      });

      it("dirty word: the high bytes are reported as read", async () => {
        const chain = sparkChain();
        const dirty = "0x01" + wordOfAddress(SPARK_IMPL).slice(4);
        chain.storage[`${SPARK}:${SLOT_EIP1967}`] = dirty;
        const vault = await read(sparkWorld(chain));
        expect(vault?.implementationSlot).to.equal(dirty);
      });

      it("an implementation with no code is a mismatch, and an unanswered read is unread", async () => {
        const chain = sparkChain();
        delete chain.code[SPARK_IMPL];
        const vault = await read(sparkWorld(chain));
        expect(vault?.implementationCodeHash).to.equal("mismatch");
        const world = sparkWorld(sparkChain());
        const real = world.fetch;
        world.fetch = (async (input: unknown, init?: RequestInit) => {
          const response = await real(input as string, init);
          if (String(input) !== RPC_URL) {
            return response;
          }
          const entries = (
            JSON.parse(await response.text()) as Array<{ id: number }>
          ).filter((e) => e.id !== 2 && e.id !== 6);
          return new Response(JSON.stringify(entries), { status: 200 });
        }) as typeof fetch;
        const partial = await read(world);
        expect(partial?.implementationSlot).to.equal("unread");
        expect(partial?.implementationCodeHash).to.equal("unread");
        expect(partial?.vaultCodeHash).to.equal("match");
      });
    });

    describe("no Fact when the row itself is invalid", () => {
      const run = async (vaultFile: string | undefined, over = {}) => {
        const world = makeWorld(
          {
            ...files([[USDT_PATH, usdtRow()]]),
            ...(vaultFile === undefined ? {} : { [STEAK_PATH]: vaultFile }),
          },
          steakChain()
        );
        return (
          await gatherRegistry(deposit(STEAK, "1000000"), depsFor(world, over))
        ).registryVault;
      };

      it("one signature, a bad signature, an unsigned slot", async () => {
        const row = Buffer.from(JSON.stringify(steakRow()));
        expect(await run(envelope(row, { a: keys.a }))).to.equal(undefined);
        expect(await run(envelope(row, { b: keys.b }))).to.equal(undefined);
        expect(
          await run(envelope(row, { a: keys.a, b: makeKeys().b }))
        ).to.equal(undefined);
      });

      it("expired", async () => {
        expect(
          await run(
            signed(steakRow({ expiresAt: "2026-10-09T00:00:00Z" }), keys)
          )
        ).to.equal(undefined);
      });

      it("lower sequence", async () => {
        const ratchet = createRatchet(ratchetFile);
        const withRatchet = { registry: () => ({ baseUrl: BASE, ratchet }) };
        expect(
          await run(signed(steakRow({ sequence: 4 }), keys), withRatchet)
        ).to.not.equal(undefined);
        expect(
          await run(signed(steakRow({ sequence: 2 }), keys), withRatchet)
        ).to.equal(undefined);
      });

      it("unreachable, 404 and a host that never answers", async () => {
        expect(await run(undefined)).to.equal(undefined);
        const world = makeWorld({}, steakChain());
        world.fetch = (async () => {
          throw new TypeError("fetch failed");
        }) as unknown as typeof fetch;
        const facts = await gatherRegistry(
          deposit(STEAK, "1000000"),
          depsFor(world)
        );
        expect(facts).to.deep.equal({});
      });

      const malformed: Array<
        [string, Partial<Parameters<typeof steakRow>[0]>]
      > = [
        ["an eip1967 row with no implementation", { upgradeable: "eip1967" }],
        [
          "an eip1967 row with no pinned hash",
          {
            upgradeable: "eip1967",
            implementation: { address: SPARK_IMPL } as never,
          },
        ],
        [
          "an eip1967 row with no pinned address",
          {
            upgradeable: "eip1967",
            implementation: {
              codeSha256: sha256OfHex(SPARK_IMPL_CODE),
            } as never,
          },
        ],
        [
          "an eip1967 row whose pin is malformed",
          {
            upgradeable: "eip1967",
            implementation: { address: "0x12", codeSha256: "ab" },
          },
        ],
        [
          "a none row that carries an implementation",
          {
            implementation: {
              address: SPARK_IMPL,
              codeSha256: sha256OfHex(SPARK_IMPL_CODE),
            },
          },
        ],
        ["an asset that is not an address", { asset: "usdt" }],
        ["no asset", { patch: { asset: undefined } }],
        ["a zero sequence", { sequence: 0 }],
        ["a string chainId", { patch: { chainId: "1" } }],
      ];
      for (const [name, extra] of malformed) {
        it(`malformed: ${name}`, async () => {
          expect(await run(signed(steakRow(extra), keys))).to.equal(undefined);
        });
      }

      it("a row whose upgradeable is not none or eip1967 is refused", async () => {
        for (const upgradeable of [
          "zeppelinos",
          "beacon",
          "transparent",
          "uups",
          false,
          true,
          null,
          { kind: "eip1967" },
          7,
        ]) {
          expect(
            await run(signed(steakRow({ patch: { upgradeable } }), keys)),
            String(upgradeable)
          ).to.equal(undefined);
        }
      });

      it("an asset that is not the canonical token", async () => {
        expect(
          await run(signed(steakRow({ asset: SPARK_OTHER_IMPL }), keys))
        ).to.equal(undefined);
      });

      it("an asset that is not canonical because the token has no row either", async () => {
        const world = makeWorld(
          files([[STEAK_PATH, steakRow()]]),
          steakChain()
        );
        const facts = await gatherRegistry(
          deposit(STEAK, "1000000"),
          depsFor(world)
        );
        expect(facts.registryVault).to.equal(undefined);
      });

      it("a deposit that names no asset has no canonical token to compare against", async () => {
        const world = steakWorld();
        const request = deposit(STEAK, "1000000");
        delete (request.action as Record<string, unknown>).asset;
        const facts = await gatherRegistry(request, depsFor(world));
        expect(facts.registryVault).to.equal(undefined);
      });

      it("a listed vault address requested on another chain", async () => {
        const world = steakWorld();
        const request = deposit(STEAK, "1000000");
        request.action.chainId = "eip155:8453";
        const facts = await gatherRegistry(request, depsFor(world));
        expect(facts).to.deep.equal({});
        expect(rowLog(world).map((e) => e.url)).to.include(
          `${BASE}/v1/vaults/eip155-8453/${STEAK}.json`
        );
      });

      it("a row for chain 1 served at another chain's path", async () => {
        const world = makeWorld(
          {
            ...files([[USDT_PATH, usdtRow()]]),
            [`v1/vaults/eip155-8453/${STEAK}.json`]: signed(steakRow(), keys),
          },
          steakChain()
        );
        const request = deposit(STEAK, "1000000");
        request.action.chainId = "eip155:8453";
        expect(
          (await gatherRegistry(request, depsFor(world))).registryVault
        ).to.equal(undefined);
      });

      it("a row for another chain served at this chain's path, over a code-table token", async () => {
        // Base USDC is in the code table, so only the row's own chain id can
        // stop a chain 1 row served at the Base path.
        const baseUsdc = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
        const world = makeWorld(
          {
            [`v1/vaults/eip155-8453/${STEAK}.json`]: signed(
              steakRow({ asset: baseUsdc }),
              keys
            ),
          },
          steakChain()
        );
        const request = deposit(STEAK, "1000000");
        request.action.chainId = "eip155:8453";
        request.action.asset = {
          symbol: "USDC",
          contractAddress: baseUsdc,
        } as never;
        expect(
          (await gatherRegistry(request, depsFor(world))).registryVault
        ).to.equal(undefined);
        const right = makeWorld(
          {
            [`v1/vaults/eip155-8453/${STEAK}.json`]: signed(
              steakRow({ asset: baseUsdc, chainId: 8453 }),
              keys
            ),
          },
          steakChain()
        );
        expect(
          (await gatherRegistry(request, depsFor(right))).registryVault?.chainId
        ).to.equal("eip155:8453");
      });

      it("a vault row served at another vault's path", async () => {
        const world = makeWorld(
          {
            ...files([[USDT_PATH, usdtRow()]]),
            [`v1/vaults/eip155-1/${SPARK}.json`]: signed(steakRow(), keys),
          },
          sparkChain()
        );
        const facts = await gatherRegistry(
          deposit(SPARK, "1000000"),
          depsFor(world)
        );
        expect(facts.registryVault).to.equal(undefined);
      });
    });

    it("the canonical token for a code-table symbol needs no token row", async () => {
      // USDC on Ethereum is in the code table, so the vault's asset is
      // compared against it with zero token network calls.
      const usdcMainnet = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
      const vault = steakRow({ asset: usdcMainnet });
      const world = makeWorld(files([[STEAK_PATH, vault]]), steakChain());
      const request = deposit(STEAK, "1000000");
      request.action.asset = {
        symbol: "USDC",
        contractAddress: usdcMainnet,
      } as never;
      const facts = await gatherRegistry(request, depsFor(world));
      expect(facts.registryAsset).to.equal(undefined);
      expect(facts.registryVault?.asset).to.equal(usdcMainnet);
      expect(rowLog(world).map((e) => e.url)).to.deep.equal([
        `${BASE}/${STEAK_PATH}`,
      ]);
    });
  });

  describe("a swap", () => {
    const issuerUrl =
      "https://developers.circle.com/stablecoins/usdc-contract-addresses";
    const issuerEvidence = (patch: Record<string, unknown> = {}) => [
      {
        origin: "circle.com",
        url: issuerUrl,
        retrievedAt: VERIFIED_AT,
        ...patch,
      },
    ];
    const nativeSwap = (
      tokenIn: unknown = { kind: "native", symbol: "MON" }
    ) => ({
      action: {
        type: "swap",
        chainId: "eip155:143",
        tokenIn,
        tokenOut: { symbol: "USDC", contractAddress: MONAD_USDC },
      },
    });
    const nativeWorld = (evidence: unknown = issuerEvidence()) =>
      makeWorld(
        files([[MONAD_PATH, monadUsdcRow({ patch: { evidence } })]]),
        monadChain()
      );

    it("native MON selects the USDC output and retains its signed issuer source", async () => {
      const world = nativeWorld();
      const facts = await gatherRegistry(nativeSwap(), depsFor(world));
      expect(facts.registryAsset?.symbol).to.equal("USDC");
      expect(facts.registryAsset).to.include({ liveRead: "confirmed" });
      expect(facts.registryAsset)
        .to.have.property("issuerSource")
        .that.deep.equals({
          origin: "circle.com",
          url: issuerUrl,
          retrievedAt: Date.parse(VERIFIED_AT) / 1000,
        });
      expect(rowLog(world).map((entry) => entry.url)).to.deep.equal([
        `${BASE}/${MONAD_PATH}`,
      ]);
    });

    it("an ERC20 called MON does not take the native shortcut", async () => {
      const world = nativeWorld();
      const facts = await gatherRegistry(
        nativeSwap({ symbol: "MON", contractAddress: USDT }),
        depsFor(world)
      );
      expect(facts).to.deep.equal({});
      expect(rowLog(world).map((entry) => entry.url)).to.deep.equal([
        `${BASE}/v1/eip155-143/MON.json`,
      ]);
    });

    it("a hybrid native/contract input does not take the native shortcut", async () => {
      const world = nativeWorld();
      expect(
        await gatherRegistry(
          nativeSwap({ kind: "native", symbol: "MON", contractAddress: USDT }),
          depsFor(world)
        )
      ).to.deep.equal({});
      expect(rowLog(world).map((entry) => entry.url)).to.not.include(
        `${BASE}/${MONAD_PATH}`
      );
    });

    it("native input on another network does not use the Monad shortcut", async () => {
      const world = nativeWorld();
      const request = nativeSwap();
      request.action.chainId = "eip155:10143";
      expect(await gatherRegistry(request, depsFor(world))).to.deep.equal({});
      expect(rowLog(world).map((entry) => entry.url)).to.not.include(
        `${BASE}/${MONAD_PATH}`
      );
    });

    for (const [name, evidence] of [
      ["missing", []],
      ["wrong issuer", issuerEvidence({ origin: "attacker.test" })],
      ["hostile URL", issuerEvidence({ url: "javascript:alert(1)" })],
      [
        "lookalike host",
        issuerEvidence({
          url: issuerUrl.replace("circle.com", "circle.com.attacker.test"),
        }),
      ],
      [
        "future retrieval",
        issuerEvidence({ retrievedAt: "2026-10-11T00:00:00Z" }),
      ],
      [
        "retrieval after row verification",
        issuerEvidence({ retrievedAt: "2026-10-04T00:00:00Z" }),
      ],
      ["ambiguous issuer", [...issuerEvidence(), ...issuerEvidence()]],
    ] as const) {
      it(`native output with ${name} evidence has no trusted fact`, async () => {
        const world = nativeWorld(evidence);
        expect(
          await gatherRegistry(nativeSwap(), depsFor(world))
        ).to.deep.equal({});
        expect(rpcLog(world)).to.have.length(0);
      });
    }

    it("native output confirmation checks the RPC network in the same batch", async () => {
      const world = nativeWorld();
      await gatherRegistry(nativeSwap(), depsFor(world));
      const calls = JSON.parse(rpcLog(world)[0]?.body ?? "[]");
      expect(calls).to.deep.include({
        jsonrpc: "2.0",
        id: 4,
        method: "eth_chainId",
        params: [],
      });
    });

    it("an RPC on another network never confirms native output identity", async () => {
      const world = nativeWorld();
      const realFetch = world.fetch;
      world.fetch = (async (input: unknown, init?: RequestInit) => {
        const response = await realFetch(input as string, init);
        if (String(input) !== RPC_URL) return response;
        const replies = JSON.parse(await response.text());
        return new Response(
          JSON.stringify(
            replies.map((reply: { id: number }) =>
              reply.id === 4 ? { jsonrpc: "2.0", id: 4, result: "0x1" } : reply
            )
          )
        );
      }) as typeof fetch;
      const facts = await gatherRegistry(nativeSwap(), depsFor(world));
      expect(facts.registryAsset?.liveRead).to.equal("unconfirmed");
    });

    it("looks up the first symbol the code table does not list", async () => {
      const world = makeWorld(
        files([[MONAD_PATH, monadUsdcRow()]]),
        monadChain()
      );
      const request = {
        action: {
          type: "swap",
          chainId: "eip155:143",
          target: MONAD_USDC,
          tokenIn: { symbol: "USDC", contractAddress: MONAD_USDC },
          tokenOut: { symbol: "usdc", contractAddress: MONAD_USDC },
        },
      };
      const facts = await gatherRegistry(request, depsFor(world));
      expect(facts.registryAsset?.symbol).to.equal("USDC");
      const onEthereum = await gatherRegistry(
        { action: { ...request.action, chainId: "eip155:1" } },
        depsFor(makeWorld({}, emptyChain()))
      );
      expect(onEthereum).to.deep.equal({});
    });
  });

  describe("the fact feeds consult's own lookup", () => {
    it("canonicalAddressFor accepts the Fact the Reader returns", async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { canonicalAddressFor } = require("@hedwig/consult/canonical");
      const world = makeWorld(
        files([[MONAD_PATH, monadUsdcRow()]]),
        monadChain()
      );
      const facts = await gatherRegistry(PAY_MONAD, depsFor(world));
      expect(
        canonicalAddressFor("eip155:143", "USDC", { now: NOW, ...facts })
      ).to.deep.equal({
        source: "registry",
        address: MONAD_USDC,
        liveRead: "confirmed",
      });
    });
  });
});
