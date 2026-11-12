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
    .split(/\b(?:in|within|at|on|and|with|against|versus|vs)\b/i)[0];
  const roleIntroduction = suffix.match(/^(?:as|is)\s+/i)?.[0];
  const afterRole = roleIntroduction
    ? suffix.slice(roleIntroduction.length + (assertedRole?.length ?? 0)).trim()
    : "";
  // Classify the role's head before interpreting protocol names inside it:
  // "AAVE token" is an asset, while "Pool of Compound" asserts a deployment.
  // An asset's use "for Compound" does not identify its contract as Comet.
  const roleHead = assertedRole?.split(/\b(?:of|for)\b/i)[0].trim();
  const assertedAsset =
    roleHead && /\b(?:asset|token|collateral|underlying)\s*$/i.test(roleHead);
  const assertedDeployment =
    roleHead &&
    !assertedAsset &&
    !/^not\b/i.test(roleHead) &&
    /\b(?:pool|comet|market|deployment|aave|compound)\b/i.test(roleHead);
  const roleOwner = assertedRole
    ?.slice(roleHead?.length ?? 0)
    .match(
      /^\s*(?:of|for)\s+(?:the\s+)?(aave(?:\s+v?\s*\d+)?|compound(?:\s+(?:v?\d+|iii|ii|iv))?|comet)\b/i
    )?.[1];
  const namedRole = prefix.match(namesDeployment)?.[0];
  const parenthetical = suffix.match(/^\(\s*([^()]+?)\s*\)/)?.[1];
  const parentheticalRole =
    parenthetical &&
    new RegExp(
      `^${deployment}(?:\\s+(?:ethereum|mainnet|usdc|pool|comet|market|deployment))*$`,
      "i"
    ).test(parenthetical)
      ? parenthetical
      : undefined;
  const roleLabels = [
    namedRole,
    parentheticalRole,
    assertedDeployment ? `${roleHead} ${roleOwner ?? ""}` : undefined,
  ].filter((label): label is string => !!label);
  const assertedDeploymentIds: string[] = [];
  // "Pool" can be a generic description; only a named protocol or the
  // specific Comet component establishes a protocol assertion here.
  if (roleLabels.some((label) => /\baave\b/i.test(label)))
    assertedDeploymentIds.push("aave-v3-ethereum");
  if (roleLabels.some((label) => /\b(?:compound|comet)\b/i.test(label)))
    assertedDeploymentIds.push("compound-iii-ethereum-usdc");
  if (
    namedRole ||
    parentheticalRole ||
    directTarget.test(prefix) ||
    comparedTarget.test(suffix) ||
    comparedTarget.test(afterRole) ||
    assertedDeployment
  )
    return { kind: "deployment", assertedDeploymentIds };
  if (
    /\b(?:(?:roles?|function|purpose)\s+of|asset|token|collateral|underlying)\b[^.;,!?\n]*$/i.test(
      prefix
    ) ||
    assertedAsset
  )
    return { kind: "reference", assertedDeploymentIds };
  return { kind: "ambiguous", assertedDeploymentIds };
}

/** Normalize asset-role nouns only for the temporary chain-conflict check. */
function normalizeBaseAssetRoles(text: string): string {
  return text.replace(
    /\bbase\s+(?:assets?|tokens?)\b/gi,
    (phrase: string, offset: number) => {
      // Explicit identity modifiers still win: "chain Base tokens" and
      // "Base token deployment" must retain the Base chain marker.
      const explicitChainModifier =
        /\b(?:chain|network|rede)\s+(?:the\s+)?$/i.test(
          text.slice(0, offset)
        ) ||
        /^\s+(?:chain|network|deployments?|mainnet)\b/i.test(
          text.slice(offset + phrase.length)
        );
      return explicitChainModifier ? "Base" : "asset";
    }
  );
}

/** Bounded declarations, not a classifier for arbitrary prose about networks. */
function hasExplicitChainDeclarationConflict(text: string): boolean {
  const names: string[] = [];
  // Typed declarations admit unknown names and do not depend on a chain list.
  for (const match of text.matchAll(
    /\b(?:chain|network|rede)\s*(?::|=|\bnamed\b|\bcalled\b)\s*([a-z][\w-]*(?:\s+(?:mainnet|testnet))?)\b/gi
  ))
    names.push(match[1]);
  for (const match of text.matchAll(
    /\b(?:on|em|na)\s+(?:the\s+)?([a-z][\w-]*)\s+(chain|network|mainnet|testnet)\b/gi
  ))
    names.push(
      /^(?:mainnet|testnet)$/i.test(match[2])
        ? `${match[1]} ${match[2]}`
        : match[1]
    );
  // A lowercase noun in "on network security" is topic prose, not a named
  // network. Lowercase identifiers remain explicit in "network: gnosis" or
  // "on gnosis network"; arbitrary untyped lowercase names are not inferred.
  for (const match of text.matchAll(
    /\b(?:on|em|na)\s+(?:the\s+)?(?:chain|network|rede)\s+([a-z][\w-]*(?:\s+(?:mainnet|testnet))?)\b/gi
  ))
    if (/^[A-Z]/.test(match[1])) names.push(match[1]);
  // Untyped "on Name" is recognized only as a proper named scope attached
  // to a comparison/deployment target, not "interest on Aave" or topic prose.
  for (const match of text.matchAll(
    /\b(?:[Oo][Nn]|[Ee][Mm]|[Nn][Aa])\s+(?:the\s+)?([A-Z][A-Za-z0-9-]*)\b/g
  )) {
    const prefix = text.slice(0, match.index);
    const followingRole = text.slice(match.index! + match[0].length);
    // A following economic role makes the name a topic modifier, as in
    // "on USDC supply interest". Typed network declarations above still win.
    if (
      /^\s+(?:assets?|tokens?|collateral|supply|borrow(?:ing)?|interest|yield|balances?|rates?)\b/i.test(
        followingRole
      )
    )
      continue;
    if (
      /\b(?:compare|both|deployments?|protocols?|pools?|markets?|comet|aave(?:\s+v\s*\d+)?|compound(?:\s+(?:iii|v\s*\d+))?)(?:\s+(?:(?:are|is)\s+)?(?:running|deployed))?\s*$/i.test(
        prefix
      )
    )
      names.push(match[1]);
  }
  return names.some(
    (name) => !/^(?:ethereum(?:\s+mainnet)?|mainnet)$/i.test(name)
  );
}

/** An exclusion applies only to the immediately following version mention. */
function isExplicitVersionExclusion(question: string, index: number): boolean {
  const prefix = question.slice(0, index);
  // Only a direct clause can command exclusion; "don't exclude" and quoted
  // or reported commands remain ambiguous without a general prose classifier.
  if (/(?:^|[.;,!?\n])\s*(?:please\s+)?exclude\s+(?:the\s+)?$/i.test(prefix))
    return true;
  const marker = /\b(?:not|excluding|except|exceto)\s+(?:the\s+)?$/i;
  const match = marker.exec(prefix);
  // Doubled/inverted markers such as "not excluding" remain ambiguous.
  return !!match && !marker.test(prefix.slice(0, match.index));
}

/** Detect known contradictions, not arbitrary natural-language identities. */
function hasKnownIdentityConflict(
  question: string,
  deployments: DeploymentSnapshot[]
): boolean {
  const chainNames =
    "base|arbitrum|optimism|polygon|solana|avalanche|sepolia|testnet|bnb(?:\\s+chain)?";
  const chainContext = normalizeBaseAssetRoles(
    question.replace(
      /\b(?:excluding|except|not on|exceto)\s+(?:the\s+)?(?:(?:chain|network|rede)\s+)?[a-z][\w-]*(?:\s+(?:chain|network|mainnet|testnet))?\b/gi,
      ""
    )
  );
  const explicitChain = new RegExp(
    `\\b(?:(?:on|em|na|as|rede|chain|network)\\s+(?:the\\s+)?(?:${chainNames})|(?:${chainNames})\\s+(?:chain|network|deployments?|mainnet))\\b`,
    "i"
  );
  if (
    explicitChain.test(chainContext) ||
    hasExplicitChainDeclarationConflict(chainContext)
  )
    return true;
  const chainIds = [
    ...chainContext.matchAll(
      /\b(?:chain\s*(?:id)?|eip155)\s*[:=]?\s*(\d+)\b/gi
    ),
  ];
  if (chainIds.some((match) => Number(match[1]) !== 1)) return true;
  const aaveVersions = [
    ...question.matchAll(/\baave\s*(?:v(?:ersion)?\s*)?(\d+(?:\.\d+)?)\b/gi),
  ].filter((match) => !isExplicitVersionExclusion(question, match.index!));
  if (aaveVersions.some((match) => match[1] !== AAVE_VERSION)) return true;
  const compoundVersions = [
    ...question.matchAll(
      /\bcompound\s*(?:v(?:ersion)?\s*)?(\d+(?:\.\d+)?|iii|ii|iv)\b/gi
    ),
  ].filter((match) => !isExplicitVersionExclusion(question, match.index!));
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
    if (!/^0x[a-f0-9]{40}$/i.test(address)) return true;
    const previous = addresses[index - 1];
    const before = question.slice(
      previous ? previous.index! + previous[0].length : 0,
      mention.index
    );
    const after = question.slice(
      mention.index! + address.length,
      addresses[index + 1]?.index
    );
    const role = addressRole(before, after);
    const matchedDeployment = deployments.find(
      (entry) => entry.address.toLowerCase() === address.toLowerCase()
    );
    if (matchedDeployment)
      return role.assertedDeploymentIds.some(
        (id) => id !== matchedDeployment.id
      );
    return role.kind !== "reference";
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
