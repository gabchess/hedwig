# augment

A knowledge base for an agent calling Hedwig, checked into this repository
so it never drifts from the code it describes.

- `skills/hedwig/SKILL.md`: the front door. Read this first.
- `skills/hedwig/references/`: one file per topic, linked from the front
  door as each is written.
- `data/conditions.json` and `data/known-addresses.json`: the Condition
  catalog and the canonical asset and router tables, generated from
  `@hedwig/consult`'s own `describeCatalog()`. Never hand-edit these; run
  `yarn consult:build` after any catalog change, then `yarn augment:verify`
  to regenerate and check them.
- `evals/`: eight scenarios, each a fixture plus its expected verdict,
  `proceed` flag, and set of non-PASS rows. `yarn augment:verify` runs
  every scenario through `consult()` and fails on any mismatch.
- `examples/walkthrough-deny.md`: one full DENY response, row by row, with
  the reason for each non-PASS row.

## Installing this in an agent

Point the agent's skill loader at `skills/hedwig/SKILL.md`. Nothing else
in this folder is meant to load directly; the front door links to the
rest as it needs it.

## Verifying this folder

```sh
yarn consult:build
node scripts/verify-augment.js
node scripts/verify-augment.js --self-test
```

`augment:verify` regenerates `data/*.json` from the built catalog and
fails if the committed files differ, checks every reference path
`data/conditions.json` names actually exists and is non-empty, and runs
every eval scenario through `consult()` to confirm its verdict, `proceed`,
and non-PASS rows. `--self-test` proves the checker itself catches a
mutated data file, a dropped reference, and a flipped eval verdict, each
on a disposable copy.
