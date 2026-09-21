import { consult } from "@hedwig/consult";
import type { ConsultResponse } from "@hedwig/consult";

import { readPolicyFile } from "./policy";

// The wire's one edge guard: a small request must never buy a policy read
// or a consult() run. Measured in bytes, the same unit consult()'s own size
// cap uses, so a multi-byte character cannot pass a cap meant to bound what
// it costs to hold and hash the value. This runs before the policy file is
// read or consult() is called; it cannot bound the SDK's own parse of the
// incoming JSON-RPC line, which has already happened by the time this
// function receives its arguments (see server.ts's transport-level cap for
// that).
const MAX_ARGUMENT_BYTES = 64 * 1024;

// A stop signal every failure below shares: an agent that catches a thrown
// error might retry or proceed past it, but an UNKNOWN verdict is a normal
// tool result and gets the same handling as any other verdict. A DENY
// consult() itself returns is an answer, not a failure, and this function's
// caller returns it unchanged.
export function unknownAdapterResponse(evidence: string): ConsultResponse {
  return {
    verdict: "UNKNOWN",
    results: [{ id: "adapter", status: "UNVERIFIED", evidence }],
    floorIds: [],
    advisory: true,
  };
}

// The plain handler behind the one MCP tool. Takes the raw tool call
// arguments exactly as the transport delivered them and the policy file
// path (never taken from the arguments), and returns exactly what
// consult(request, policy) returns. Imports nothing from the MCP SDK, so it
// can be tested directly without a live protocol handshake.
export function handleConsult(
  rawArgs: unknown,
  policyPath: string
): ConsultResponse {
  let serialized: string;
  try {
    serialized = JSON.stringify(rawArgs) ?? "";
  } catch {
    return unknownAdapterResponse("tool arguments could not be measured");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_ARGUMENT_BYTES) {
    return unknownAdapterResponse("tool arguments exceed the size limit");
  }

  const policyResult = readPolicyFile(policyPath);
  if (!policyResult.ok) {
    return unknownAdapterResponse(policyResult.reason);
  }

  // Every key but "request" is ignored: the caller cannot choose the
  // policy, and this is the only extraction this function performs. The
  // request itself is handed to consult() exactly as received, with no
  // shape validation of its own.
  const request =
    rawArgs !== null && typeof rawArgs === "object"
      ? (rawArgs as Record<string, unknown>).request
      : undefined;

  try {
    return consult(request as never, policyResult.policy as never);
  } catch {
    return unknownAdapterResponse("consult raised an unexpected error");
  }
}
