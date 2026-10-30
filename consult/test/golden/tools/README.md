# Golden case builder

`build-golden.ts` rebuilds the 14 golden cases that have a `label_source` object in `../golden-cases.json`. It runs each case through `consult` to fill `expected` and `policySha256`. It reads only the local JSON inputs in this folder and makes no network call.

## Rerun

Run from the repository root:

```sh
node_modules/.bin/ts-node -P consult/tsconfig.test.json consult/test/golden/tools/build-golden.ts
git diff --exit-code consult/test/golden/golden-cases.json
```

The second command exits 0 when the committed file is reproduced. The builder keeps `reviewed` and `review` from the file it rewrites, because a verifier model sets them and the builder does not. It stops with an error if a reviewed case's input or expected output changed, because the verifier agreed the old values. It sets `known_gap` and `reviewed: false` on the cases in `KNOWN_GAPS`, whose expected output pins current behavior that a careful payer would not want. Each `known_gap.desired` names the verdict and FAIL check ids a careful payer wants, and the golden test fails once `expected` reaches them, so a fixed gap cannot go unnoticed. The builder sets `review.record` on each reviewed case to `verifier-2026-10-30.md`, the verifier's written record in this folder.

## Inputs

- `incidents.json` holds the on-chain reads for the DeFiHackLabs approval incidents. `fetch-incidents.mjs` writes it.
- `transfer.json` holds the USDC transfer behind `pay-clean-direct-transfer-allows`. `get-transfer.mjs <tx hash>` writes it.

## Fetch scripts

These scripts read public RPC endpoints and need no API key. Their results can change only if an endpoint returns different data for a historical block.

- `node fetch-incidents.mjs` reads every incident again. A comma-separated list of slugs limits the run to those incidents and merges their rows into `incidents.json`, keeping the other rows. A failed read is stored as a row with an `error` field, and the builder refuses to run while any such row exists or an incident it needs is missing.
- `node find-transfer.mjs` finds a direct USDC transfer from an externally owned account in block 26298232.
- `node get-transfer.mjs 0x866d3669be9d135eaa47099bbddcc60a9ebcab66a9ec925bad594c25de1723bb` writes `transfer.json`.
- `node find-poison.mjs` and `node find-poison2.mjs` list the victim's transfers around the 3 May 2024 WBTC address poisoning. The builder holds their results as constants.
