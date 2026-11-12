import { MAX_LEARNING_QUESTION_CHARS } from "./expert";

const COMPARISON_DEPLOYMENT_COUNT = 2;
const IDENTITY_FIELD_COUNT = 2;
const AAVE_VERSION = "3";

/** Repository deployment identities; these are not live chain observations. */
export type DeploymentSnapshot = {
  id: string;
  name: string;
  chainId: number;
  address: string;
  reviewedAt: string;
  sourceFileUrl: string;
  evidenceKind: "repository_deployment_snapshot";
};

export const SUPPORTED_DEPLOYMENTS: readonly DeploymentSnapshot[] =
  Object.freeze([
    Object.freeze({
      id: "aave-v3-ethereum",
      name: "Aave V3 Ethereum Pool",
      chainId: 1,
      address: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
      reviewedAt: "2026-11-11",
      sourceFileUrl:
        "https://github.com/aave-dao/aave-address-book/blob/b8c801a413c4b934afaf7976d2ddc5fbada6dce6/src/ts/AaveV3Ethereum.ts",
      evidenceKind: "repository_deployment_snapshot" as const,
    }),
    Object.freeze({
      id: "compound-iii-ethereum-usdc",
      name: "Compound III Ethereum USDC Comet",
      chainId: 1,
      address: "0xc3d688B66703497DAA19211EEdff47f25384cdc3",
      reviewedAt: "2026-11-11",
      sourceFileUrl:
        "https://github.com/compound-finance/comet/blob/f766f51583c23acc33b2a7824654ef2029a96804/deployments/mainnet/usdc/roots.json",
      evidenceKind: "repository_deployment_snapshot" as const,
    }),
  ]);

type ReadyRequest =
  | {
      status: "ready";
      mode: "learn";
      question: string;
    }
  | {
      status: "ready";
      mode: "compare";
      question: string;
      deployments: DeploymentSnapshot[];
    };
export type ParsedExpertRequest =
  | ReadyRequest
  | { status: "invalid_question" }
  | {
      status: "needs_clarification";
      clarification: string;
      supportedDeployments: readonly DeploymentSnapshot[];
    };

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function clarify(): ParsedExpertRequest {
  return {
    status: "needs_clarification",
    clarification:
      "Select two distinct supported deployments by exact chainId and address. This comparison covers repository snapshots on Ethereum mainnet only; it does not verify current deployment state.",
    supportedDeployments: SUPPORTED_DEPLOYMENTS.map((entry) => ({ ...entry })),
  };
}

/** Recognize explicit local roles; a reference label establishes no asset facts. */
function addressRole(before: string, after: string) {
  // Do not let a role in an earlier clause apply to an unrelated address.
  const prefix = before.split(/[.;,!?\n]/).at(-1) ?? "";
  const suffix = after.replace(/^[\s)\]]+/, "");
  const deployment =
    "(?:pool|comet|market|deployment|aave(?:\\s+v?\\s*\\d+)?|compound(?:\\s+(?:v?\\d+|iii|ii|iv))?)";
  const namesDeployment = new RegExp(
    `\\b${deployment}(?:\\s+(?:ethereum|mainnet|usdc|pool|comet|market|deployment|address|at|is))*\\s*[([:=]?\\s*$`,
    "i"
  );
  const directTarget = /\b(?:compare|against|versus|vs)\s*[([:=]?\s*$/i;
  const comparedTarget = new RegExp(
    `^(?:against|versus|vs|with)\\s+(?:the\\s+)?(?:${deployment}|0x[a-z0-9]+)\\b`,
    "i"
  );
  const assertedRole = suffix
    .match(/^(?:as|is)\s+([^.;,!?\n]+)/i)?.[1]
    .split(/\b(?:in|within|for|of|at|on)\b/i)[0];
  if (
    namesDeployment.test(prefix) ||
    directTarget.test(prefix) ||
    comparedTarget.test(suffix) ||
    (assertedRole &&
      /\b(?:pool|comet|market|deployment|aave|compound)\b/i.test(assertedRole))
  )
    return "deployment";
  if (
    /\b(?:(?:roles?|function|purpose)\s+of|asset|token|collateral|underlying)\b[^.;,!?\n]*$/i.test(
      prefix
    ) ||
    /^(?:as|is)\s+(?:(?:an?|the)\s+)?(?:asset|token|collateral|underlying)\b/i.test(
      suffix
    )
  )
    return "reference";
  return "ambiguous";
}

/** Detect known contradictions, not arbitrary natural-language identities. */
function hasKnownIdentityConflict(
  question: string,
  deployments: DeploymentSnapshot[]
): boolean {
  const chainNames =
    "base|arbitrum|optimism|polygon|solana|avalanche|sepolia|testnet|bnb(?:\\s+chain)?";
  const chainContext = question
    .replace(
      new RegExp(
        `\\b(?:excluding|except|not on|exceto)\\s+(?:the\\s+)?(?:${chainNames})\\b`,
        "gi"
      ),
      ""
    )
    // An asset's role is not a chain name. Remove only that role phrase so
    // a separate "on Base" or "as Base deployments" still conflicts.
    .replace(/\bas\s+(?:the\s+)?base\s+assets?\b/gi, "");
  const explicitChain = new RegExp(
    `\\b(?:(?:on|em|na|as|rede|chain|network)\\s+(?:the\\s+)?(?:${chainNames})|(?:${chainNames})\\s+(?:chain|network|deployments?|mainnet))\\b`,
    "i"
  );
  if (explicitChain.test(chainContext)) return true;
  const chainIds = [
    ...chainContext.matchAll(
      /\b(?:chain\s*(?:id)?|eip155)\s*[:=]?\s*(\d+)\b/gi
    ),
  ];
  if (chainIds.some((match) => Number(match[1]) !== 1)) return true;
  const aaveVersions = [
    ...question.matchAll(/\baave\s*(?:v(?:ersion)?\s*)?(\d+(?:\.\d+)?)\b/gi),
  ];
  if (aaveVersions.some((match) => match[1] !== AAVE_VERSION)) return true;
  const compoundVersions = [
    ...question.matchAll(
      /\bcompound\s*(?:v(?:ersion)?\s*)?(\d+(?:\.\d+)?|iii|ii|iv)\b/gi
    ),
  ];
  if (
    compoundVersions.some(
      (match) => !["3", "iii"].includes(match[1].toLowerCase())
    )
  )
    return true;
  if (
    /\b(?:compound\s*(?:iii|v3)\s+(?:ethereum\s+)?(?:weth|eth|usdt|usds)\s+(?:comet|market)|(?:weth|eth|usdt|usds)\s+comet)\b/i.test(
      question
    )
  )
    return true;
  const addresses = [...question.matchAll(/\b0x[a-z0-9]+\b/gi)];
  return addresses.some((mention, index) => {
    const address = mention[0];
    if (
      deployments.some(
        (entry) => entry.address.toLowerCase() === address.toLowerCase()
      )
    )
      return false;
    if (!/^0x[a-f0-9]{40}$/i.test(address)) return true;
    const previous = addresses[index - 1];
    const before = question.slice(
      previous ? previous.index! + previous[0].length : 0,
      mention.index
    );
    const after = question.slice(mention.index! + address.length);
    return addressRole(before, after) !== "reference";
  });
}

/** Caller fields select an educational task, never a corpus, provider or policy. */
export function parseExpertRequest(value: unknown): ParsedExpertRequest {
  const input = object(value);
  if (
    !input ||
    Object.keys(input).some(
      (key) => !["question", "mode", "deployments"].includes(key)
    ) ||
    typeof input.question !== "string" ||
    !input.question.trim() ||
    input.question.length > MAX_LEARNING_QUESTION_CHARS
  )
    return { status: "invalid_question" };
  const mode = input.mode === undefined ? "learn" : input.mode;
  if (mode !== "learn" && mode !== "compare")
    return { status: "invalid_question" };
  if (mode === "learn") {
    return input.deployments === undefined
      ? { status: "ready", mode, question: input.question }
      : { status: "invalid_question" };
  }
  if (input.deployments === undefined) return clarify();
  if (
    !Array.isArray(input.deployments) ||
    input.deployments.length !== COMPARISON_DEPLOYMENT_COUNT
  )
    return { status: "invalid_question" };
  const resolved: DeploymentSnapshot[] = [];
  for (const candidate of input.deployments) {
    const identity = object(candidate);
    if (
      !identity ||
      Object.keys(identity).length !== IDENTITY_FIELD_COUNT ||
      !Number.isSafeInteger(identity.chainId) ||
      (identity.chainId as number) < 1 ||
      typeof identity.address !== "string" ||
      !/^0x[a-f0-9]{40}$/i.test(identity.address)
    ) {
      return { status: "invalid_question" };
    }
    const match = SUPPORTED_DEPLOYMENTS.find(
      (entry) =>
        entry.chainId === identity.chainId &&
        entry.address.toLowerCase() ===
          (identity.address as string).toLowerCase()
    );
    if (!match || resolved.some((entry) => entry.id === match.id))
      return clarify();
    resolved.push({ ...match });
  }
  if (hasKnownIdentityConflict(input.question, resolved)) return clarify();
  return {
    status: "ready",
    mode,
    question: input.question,
    deployments: resolved,
  };
}
