import { consult } from "@hedwig/consult";
import type { ConsultResponse } from "@hedwig/consult";

import { readPolicyFile } from "./policy";
import { getSolanaClusterConfig } from "./readers/config";
import {
  clusterForRoleRequirement,
  gatherSolanaRole,
  SIMULATE_DEADLINE_MS,
} from "./readers/solana-role";

// The wire's one edge guard: a small request must never buy a policy read
// or a consult() run. Measured in bytes, so a multi-byte character cannot pass a
// cap meant to bound what it costs to hold the value. This runs before the policy file is
// read or consult() is called; it cannot bound the SDK's own parse of the
// incoming JSON-RPC line, which has already happened by the time this
// function receives its arguments (see server.ts's transport-level cap for
// that).
const MAX_ARGUMENT_BYTES = 64 * 1024;

const ADAPTER_REFERENCE = "consult/references/core.md";

// A stop signal every failure below shares: an agent that catches a thrown
// error might retry or proceed past it, but an UNKNOWN verdict is a normal
// tool result and gets the same handling as any other verdict. A DENY
// consult() itself returns is an answer, not a failure, and this function's
// caller returns it unchanged. Carries the same fields consult() itself
// returns, so a caller never needs a second code path for an adapter
// failure versus a genuine UNKNOWN verdict.
export function unknownAdapterResponse(
  code: string,
  evidence: string
): ConsultResponse {
  return {
    question:
      "Should this agent proceed with this action under the owner's policy?",
    proceed: false,
    verdict: "UNKNOWN",
    support: 0,
    band: "red",
    results: [
      {
        id: "adapter",
        question: "Did the adapter reach a policy and a well-formed request?",
        status: "UNVERIFIED",
        code,
        evidence: evidence.startsWith("cannot confirm")
          ? evidence
          : `cannot confirm: ${evidence}`,
        evidenceClass: "not-verifiable",
        reference: ADAPTER_REFERENCE,
      },
    ],
    floorIds: [],
    advisory: true,
  };
}

// The policy file's own "role" field, read the same defensive way
// readPolicyFile reads the rest of it: as unknown JSON, never assumed to
// have any particular shape. consult() re-validates this on its own later;
// this reading exists only so the reader knows which cluster's config to
// use, never to decide anything about the verdict.
function readPolicyRole(policy: unknown): unknown {
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
    return undefined;
  }
  return (policy as Record<string, unknown>).role;
}

// The plain handler behind the one MCP tool. Takes the raw tool call
// arguments exactly as the transport delivered them and the policy file
// path (never taken from the arguments), and returns exactly what
// consult(request, policy, facts) returns. Imports nothing from the MCP
// SDK, so it can be tested directly without a live protocol handshake.
export async function handleConsult(
  rawArgs: unknown,
  policyPath: string
): Promise<ConsultResponse> {
  let serialized: string;
  try {
    serialized = JSON.stringify(rawArgs) ?? "";
  } catch {
    return unknownAdapterResponse(
      "ADAPTER_FAILED",
      "tool arguments could not be measured"
    );
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_ARGUMENT_BYTES) {
    return unknownAdapterResponse(
      "ADAPTER_INPUT_TOO_LARGE",
      "tool arguments exceed the size limit"
    );
  }

  const policyResult = readPolicyFile(policyPath);
  if (!policyResult.ok) {
    return unknownAdapterResponse(
      "ADAPTER_POLICY_UNREADABLE",
      policyResult.reason
    );
  }

  // Every key but "request" is ignored: the caller cannot choose the
  // policy, and this is the only extraction this function performs. The
  // request itself is handed to consult() exactly as received, with no
  // shape validation of its own.
  const request =
    rawArgs !== null && typeof rawArgs === "object"
      ? (rawArgs as Record<string, unknown>).request
      : undefined;

  // The Solana role Reader reads only the owner's policy file (read above)
  // and its own env-configured cluster settings: the request is never
  // consulted here, so nothing a caller sends can steer which cluster is
  // read, the outbound call, or the resulting fact (pinned by a test: a
  // request stuffing its own "cluster" field changes nothing).
  // clusterForRoleRequirement applies the same mode/cluster/programId
  // checks gatherSolanaRole itself uses, so a "not-required" policy, or a
  // required one naming an unrecognised cluster or the wrong programId,
  // never reaches config.ts and never triggers its startup lines.
  // gatherSolanaRole itself never throws or rejects, so a config defect or
  // a network failure surfaces as an absent fact, not as an adapter
  // failure.
  const policyRole = readPolicyRole(policyResult.policy);
  const cluster = clusterForRoleRequirement(policyRole);
  const clusterConfig = cluster ? getSolanaClusterConfig(cluster) : undefined;
  const solanaRole = await gatherSolanaRole(policyRole, {
    fetch: globalThis.fetch,
    // observedAt: read inside the Reader, right before it sends.
    now: () => Math.floor(Date.now() / 1000),
    feePayer: clusterConfig?.feePayer,
    rpcUrl: clusterConfig?.rpcUrl,
    deadlineMs: SIMULATE_DEADLINE_MS,
  });
  // consult()'s own clock: read only after the Reader has returned, so the
  // gap between it and the fact's observedAt reflects how long the actual
  // round trip took, and a stale fact can be detected at all.
  const now = Math.floor(Date.now() / 1000);

  try {
    // The adapter is the only clock and the only Solana reader consult()
    // ever sees: it supplies `now` and `solanaRole` as data on every call.
    // Only `rawArgs.request` is read above and these facts are built here,
    // so nothing a caller sends can become a fact.
    return consult(request as never, policyResult.policy as never, {
      now,
      ...(solanaRole !== undefined ? { solanaRole } : {}),
    });
  } catch {
    return unknownAdapterResponse(
      "ADAPTER_FAILED",
      "consult raised an unexpected error"
    );
  }
}
