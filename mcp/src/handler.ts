import { consult } from "@hedwig/consult";
import type { ConsultResponse } from "@hedwig/consult";

import { readPolicyFile } from "./policy";

// The wire's one edge guard: a small request must never buy unbounded
// processing. Measured the same way consult()'s own size cap is measured -
// on the serialised value, before anything else runs.
const MAX_ARGUMENT_CHARS = 64 * 1024;

// Every adapter-level failure resolves to this shape, never an MCP error and
// never DENY: an agent that receives a thrown error may proceed; UNKNOWN
// tells it to stop. A DENY consult() itself returns is a real answer and is
// returned unchanged by the caller of this function.
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
  if (serialized.length > MAX_ARGUMENT_CHARS) {
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
