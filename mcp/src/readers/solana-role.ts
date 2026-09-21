import {
  buildCheckRoleTransaction,
  decodeBase58PublicKey,
  encodeBase58PublicKey,
} from "./wire";
import { findProgramAddress } from "./pda";

// Reads whether a holder currently holds a named Solana role, by
// simulating the on-chain check_role instruction. Returns a fact for
// consult() to weigh, or undefined when there is nothing to confirm.
// Never throws, never rejects, and always settles within deps.deadlineMs:
// one AbortController and one timer bound the fetch AND the body read
// together, so a stalled response can never hang this function open.

export const SIMULATE_DEADLINE_MS = 800;
const JSON_RPC_ID = 1;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MEMBER_SEED = Buffer.from("member", "utf8");

export type DeployableCluster = "devnet" | "mainnet-beta";

// The program id this reader ever calls: the same id programs/hedwig_sol
// declares (see Anchor.toml and lib.rs's declare_id!). A policy naming any
// other id is a configuration mismatch, not a fact about the subject, so
// it never reaches the network.
const DEPLOYED_PROGRAM_IDS: Readonly<Record<DeployableCluster, string>> =
  Object.freeze({
    devnet: "H4J9wWhraK2Zvn4o9aFheFVmAf7nfaBNPw3d7w77X1eC",
    "mainnet-beta": "H4J9wWhraK2Zvn4o9aFheFVmAf7nfaBNPw3d7w77X1eC",
  });

// Anchor constraint/account error codes: the deployed program rejected the
// shape of the call itself (wrong seeds, wrong owner, a stale IDL), never
// a fact about whether the holder holds the role. Logged once, with no
// caller-controlled content.
const CONFIG_DEFECT_CODES: ReadonlySet<number> = new Set([
  2001, 2006, 3002, 3007, 6000, 6001, 6002, 6003,
]);

export type RoleFactReason =
  | "ok"
  | "RoleDisabled"
  | "MembershipExpired"
  | "MemberMissing";

const CUSTOM_CODE_REASONS: ReadonlyMap<number, RoleFactReason> = new Map([
  [3012, "MemberMissing"],
  [6004, "RoleDisabled"],
  [6005, "MembershipExpired"],
]);

export interface RoleFactSubject {
  cluster: string;
  programId: string;
  role: string;
  holder: string;
}

export interface RoleFact {
  subject: RoleFactSubject;
  valid: boolean;
  reason: RoleFactReason;
  provenance: {
    source: string;
    slot: number;
    commitment: "confirmed";
    observedAt: number;
  };
}

export interface SolanaRoleDeps {
  fetch: typeof globalThis.fetch;
  now: () => number;
  feePayer: string | undefined;
  rpcUrl: string | undefined;
  deadlineMs: number;
}

interface RequiredRoleFields {
  cluster: DeployableCluster;
  programId: string;
  role: string;
  holder: string;
  // The policy's own copy, if it has one. Never trusted on its own: the
  // Reader always derives the address itself and only uses this to catch
  // a stale or mistyped policy (see the mismatch check in gatherSolanaRole).
  member: string | undefined;
}

// The owner's policy is read as unknown, untrusted JSON: every field is
// checked for its own sake before anything is done with it. A policy that
// is missing a field, has the wrong mode, or names an unrecognised
// cluster, program id, or key never earns a network call.
function readRequiredRole(policyRole: unknown): RequiredRoleFields | undefined {
  if (
    policyRole === null ||
    typeof policyRole !== "object" ||
    Array.isArray(policyRole)
  ) {
    return undefined;
  }
  const record = policyRole as Record<string, unknown>;
  if (record.mode !== "required") {
    return undefined;
  }

  const cluster = record.cluster;
  if (cluster !== "devnet" && cluster !== "mainnet-beta") {
    // Covers "testnet" (no configuration exists for it) and any other value.
    return undefined;
  }

  const programId = record.programId;
  const role = record.role;
  const holder = record.holder;
  const member = record.member;
  if (
    typeof programId !== "string" ||
    !decodeBase58PublicKey(programId) ||
    typeof role !== "string" ||
    !decodeBase58PublicKey(role) ||
    typeof holder !== "string" ||
    !decodeBase58PublicKey(holder) ||
    (member !== undefined &&
      (typeof member !== "string" || !decodeBase58PublicKey(member)))
  ) {
    return undefined;
  }
  if (programId !== DEPLOYED_PROGRAM_IDS[cluster]) {
    return undefined;
  }

  return {
    cluster,
    programId,
    role,
    holder,
    member: typeof member === "string" ? member : undefined,
  };
}

// Lets a caller (handler.ts) learn which cluster's config it needs to
// resolve, using the exact same validation gatherSolanaRole itself applies
// (mode, cluster, and a programId that matches the deployed id). A
// "not-required" policy, or a required one naming the wrong programId or
// an unrecognised cluster, returns undefined here: the caller then never
// reaches config.ts at all, so a mismatched policy never triggers its
// "is not set" startup lines.
export function clusterForRoleRequirement(
  policyRole: unknown
): DeployableCluster | undefined {
  return readRequiredRole(policyRole)?.cluster;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function allDistinct(buffers: Buffer[]): boolean {
  return new Set(buffers.map((b) => b.toString("hex"))).size === buffers.length;
}

// `{ InstructionError: [index, { Custom: code }] }` is the one error shape
// this reader ever trusts as a definite program-level answer: exactly one
// top-level key, a two-element pair, an integer index, and a detail object
// whose only key is Custom holding an integer. Anything else (a bare
// string, an extra sibling key, a non-integer code) is unreadable, never
// guessed at.
function readInstructionErrorCustomCode(
  err: unknown
): { index: number; custom: number } | undefined {
  if (err === null || typeof err !== "object" || Array.isArray(err)) {
    return undefined;
  }
  const record = err as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== "InstructionError") {
    return undefined;
  }
  const pair = record.InstructionError;
  if (!Array.isArray(pair) || pair.length !== 2) {
    return undefined;
  }
  const [index, detail] = pair as [unknown, unknown];
  if (typeof index !== "number" || !Number.isInteger(index)) {
    return undefined;
  }
  if (detail === null || typeof detail !== "object" || Array.isArray(detail)) {
    return undefined;
  }
  const detailRecord = detail as Record<string, unknown>;
  const detailKeys = Object.keys(detailRecord);
  if (detailKeys.length !== 1 || detailKeys[0] !== "Custom") {
    return undefined;
  }
  const custom = detailRecord.Custom;
  if (typeof custom !== "number" || !Number.isInteger(custom)) {
    return undefined;
  }
  return { index, custom };
}

interface ParsedOutcome {
  slot: number;
  configDefect: boolean;
  valid: boolean;
  reason: RoleFactReason;
}

// The exact table this reader answers from. `valid: true` requires the
// program's own success line and no failure line for its own id, a
// matching JSON-RPC id, and a positive slot: a bare `err: null` is never
// enough on its own. Every `valid: false` reason requires the program's
// own invoke line. Every row not covered here means undefined: no fact,
// never a guess.
function readOutcome(
  parsed: unknown,
  programId: string
): ParsedOutcome | undefined {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const body = parsed as Record<string, unknown>;
  if ("error" in body) {
    return undefined;
  }
  if (body.jsonrpc !== "2.0" || body.id !== JSON_RPC_ID) {
    return undefined;
  }

  const result = body.result;
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    return undefined;
  }
  const resultRecord = result as Record<string, unknown>;

  const context = resultRecord.context;
  const slot =
    context !== null && typeof context === "object" && !Array.isArray(context)
      ? (context as Record<string, unknown>).slot
      : undefined;
  if (typeof slot !== "number" || !Number.isSafeInteger(slot) || slot < 0) {
    return undefined;
  }

  const value = resultRecord.value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const valueRecord = value as Record<string, unknown>;
  const err = valueRecord.err;
  const logs = valueRecord.logs;

  const successLine = `Program ${programId} success`;
  const failedLine = `Program ${programId} failed`;
  // A real invoke line carries a call-depth suffix ("Program <id> invoke
  // [1]"), so this is a prefix match; success and failed lines never carry
  // that suffix, so those stay exact.
  const invokeLinePrefix = `Program ${programId} invoke`;

  if (err === null) {
    if (slot <= 0) {
      return undefined;
    }
    if (!isStringArray(logs) || logs.length === 0) {
      return undefined;
    }
    if (!logs.includes(successLine) || logs.includes(failedLine)) {
      return undefined;
    }
    return { slot, configDefect: false, valid: true, reason: "ok" };
  }
  if (typeof err === "string") {
    return undefined;
  }

  const instructionError = readInstructionErrorCustomCode(err);
  if (!instructionError || instructionError.index !== 0) {
    return undefined;
  }
  if (
    !isStringArray(logs) ||
    logs.length === 0 ||
    !logs.some((line) => line.startsWith(invokeLinePrefix))
  ) {
    return undefined;
  }

  if (CONFIG_DEFECT_CODES.has(instructionError.custom)) {
    return { slot, configDefect: true, valid: false, reason: "ok" };
  }
  const reason = CUSTOM_CODE_REASONS.get(instructionError.custom);
  if (!reason) {
    return undefined;
  }
  return { slot, configDefect: false, valid: false, reason };
}

// Reads a Fetch API response body bounded by maxBytes, streaming and
// counting when a stream is available so an endless or oversized body is
// cut off the moment the cap is passed, never buffered whole first. A
// response object with no readable stream (an injected test double) falls
// back to a single bounded read.
async function readBoundedBody(
  response: Response,
  maxBytes: number,
  controller: AbortController
): Promise<string | undefined> {
  const body = (response as { body?: unknown }).body;
  const stream =
    body && typeof (body as { getReader?: unknown }).getReader === "function"
      ? (body as ReadableStream<Uint8Array>)
      : undefined;

  if (stream) {
    const reader = stream.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (value) {
          total += value.byteLength;
          if (total > maxBytes) {
            controller.abort();
            try {
              await reader.cancel();
            } catch {
              // Already aborting; nothing more to release.
            }
            return undefined;
          }
          chunks.push(Buffer.from(value));
        }
      }
    } catch {
      return undefined;
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    return undefined;
  }
  return text;
}

// Fetches and reads the whole response body under one shared
// AbortController: a caller races this whole function against the
// deadline, not just the fetch call, so a stall anywhere in the exchange
// is bounded the same way.
async function fetchAndReadBody(
  rpcUrl: string,
  requestBody: string,
  fetchFn: typeof globalThis.fetch,
  controller: AbortController
): Promise<string | undefined> {
  const response = await fetchFn(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: requestBody,
    redirect: "error",
    signal: controller.signal,
  });

  if (response.status !== 200 || response.redirected === true) {
    return undefined;
  }

  return readBoundedBody(response, MAX_RESPONSE_BYTES, controller);
}

// Races promise against deadlineMs, aborting controller on expiry so a
// well-behaved fetch or stream stops too. A promise that settles after the
// deadline is dropped: its result, whatever it turns out to be, is never
// awaited further.
function raceWithDeadline<T>(
  promise: Promise<T>,
  deadlineMs: number,
  controller: AbortController
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error("solana-role: deadline exceeded"));
    }, deadlineMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export async function gatherSolanaRole(
  policyRole: unknown,
  deps: SolanaRoleDeps
): Promise<RoleFact | undefined> {
  try {
    const required = readRequiredRole(policyRole);
    if (!required) {
      return undefined;
    }
    if (
      !deps.rpcUrl ||
      !deps.feePayer ||
      !decodeBase58PublicKey(deps.feePayer)
    ) {
      return undefined;
    }

    const feePayerBytes = decodeBase58PublicKey(deps.feePayer) as Buffer;
    const roleBytes = decodeBase58PublicKey(required.role) as Buffer;
    const holderBytes = decodeBase58PublicKey(required.holder) as Buffer;
    const programIdBytes = decodeBase58PublicKey(required.programId) as Buffer;

    // The member PDA is derived here, never trusted from the policy: a
    // stale or mistyped policy.role.member would otherwise turn a real
    // holder into a false MemberMissing deny.
    const derived = findProgramAddress(
      [MEMBER_SEED, roleBytes, holderBytes],
      programIdBytes
    );
    if (!derived) {
      return undefined;
    }
    const memberBase58 = encodeBase58PublicKey(derived.address);
    if (required.member !== undefined && required.member !== memberBase58) {
      console.error(
        "hedwig-mcp: the Solana role policy names a member address that does not match the derived one"
      );
      return undefined;
    }

    if (
      !allDistinct([
        feePayerBytes,
        derived.address,
        roleBytes,
        holderBytes,
        programIdBytes,
      ])
    ) {
      console.error(
        "hedwig-mcp: the Solana role policy names accounts that are not all distinct"
      );
      return undefined;
    }

    const transaction = buildCheckRoleTransaction({
      feePayer: deps.feePayer,
      member: memberBase58,
      role: required.role,
      holder: required.holder,
      programId: required.programId,
    });
    if (!transaction) {
      return undefined;
    }

    // Taken before the send: age is measured from when the Reader asked,
    // never understated by how long the network took to answer.
    const observedAt = deps.now();
    if (!Number.isSafeInteger(observedAt) || observedAt <= 0) {
      return undefined;
    }

    const requestBody = JSON.stringify({
      jsonrpc: "2.0",
      id: JSON_RPC_ID,
      method: "simulateTransaction",
      params: [
        transaction.toString("base64"),
        {
          sigVerify: false,
          replaceRecentBlockhash: true,
          commitment: "confirmed",
          encoding: "base64",
        },
      ],
    });

    const controller = new AbortController();
    const text = await raceWithDeadline(
      fetchAndReadBody(deps.rpcUrl, requestBody, deps.fetch, controller),
      deps.deadlineMs,
      controller
    );
    if (text === undefined) {
      return undefined;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return undefined;
    }

    const outcome = readOutcome(parsed, required.programId);
    if (!outcome) {
      return undefined;
    }
    if (outcome.configDefect) {
      console.error(
        "hedwig-mcp: the Solana role check reached a program configuration error"
      );
      return undefined;
    }

    return {
      subject: {
        cluster: required.cluster,
        programId: required.programId,
        role: required.role,
        holder: required.holder,
      },
      valid: outcome.valid,
      reason: outcome.reason,
      provenance: {
        source: new URL(deps.rpcUrl).host,
        slot: outcome.slot,
        commitment: "confirmed",
        observedAt,
      },
    };
  } catch {
    return undefined;
  }
}
