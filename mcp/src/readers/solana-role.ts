import { buildCheckRoleTransaction, decodeBase58PublicKey } from "./wire";

// Reads whether a holder currently holds a named Solana role, by
// simulating the on-chain check_role instruction. Returns a fact for
// consult() to weigh, or undefined when there is nothing safe to report.
// Never throws, never rejects: every exit is a plain return.

export const SIMULATE_DEADLINE_MS = 800;

const MAX_RESPONSE_BYTES = 256 * 1024;

type DeployableCluster = "devnet" | "mainnet-beta";

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
  member: string;
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
    typeof member !== "string" ||
    !decodeBase58PublicKey(member)
  ) {
    return undefined;
  }
  if (programId !== DEPLOYED_PROGRAM_IDS[cluster]) {
    return undefined;
  }

  return { cluster, programId, role, holder, member };
}

function isNonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

// `{ InstructionError: [index, { Custom: code }] }` is the one error shape
// this reader ever trusts as a definite program-level answer. Anything
// else (a bare string, a differently-shaped object, a string or non-integer
// code) is treated as unreadable, never guessed at.
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
  const custom = (detail as Record<string, unknown>).Custom;
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

// The exact table this reader answers from. Every row not covered here
// (a JSON-RPC error, a missing result, an unreadable err shape, an
// instruction index other than 0, an unrecognised Custom code, or a
// program result with no logs) means undefined: no fact, never a guess.
function readOutcome(parsed: unknown): ParsedOutcome | undefined {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const body = parsed as Record<string, unknown>;
  if ("error" in body) {
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

  if (err === null) {
    if (!isNonEmptyArray(logs)) {
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
  if (!isNonEmptyArray(logs)) {
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

// Enforces deps.deadlineMs regardless of whether the supplied fetch honours
// AbortSignal: a fetch that settles after the deadline is dropped, not
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

    const transaction = buildCheckRoleTransaction({
      feePayer: deps.feePayer,
      member: required.member,
      role: required.role,
      holder: required.holder,
      programId: required.programId,
    });
    if (!transaction) {
      return undefined;
    }

    // Taken before the send: age is measured from when the reader asked,
    // never understated by how long the network took to answer.
    const observedAt = deps.now();
    if (!Number.isSafeInteger(observedAt) || observedAt <= 0) {
      return undefined;
    }

    const controller = new AbortController();
    const requestBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
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

    const response = await raceWithDeadline(
      deps.fetch(deps.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestBody,
        redirect: "error",
        signal: controller.signal,
      }),
      deps.deadlineMs,
      controller
    );

    if (response.status !== 200) {
      return undefined;
    }

    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
      return undefined;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return undefined;
    }

    const outcome = readOutcome(parsed);
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
