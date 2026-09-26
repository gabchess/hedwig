# augment

A skill for an agent calling Hedwig, checked into this repository so it
never drifts from the code it describes.

- [`skills/hedwig/SKILL.md`](skills/hedwig/SKILL.md): the front door. Read
  this first.
- `skills/hedwig/references/`: one file per topic, linked from the front
  door.
- [`examples/walkthrough-deny.md`](examples/walkthrough-deny.md): one full
  DENY response, row by row, with the reason for each non-PASS row.

## Installing this in an agent

Point the agent's skill loader at `skills/hedwig/SKILL.md`. Nothing else in
this folder is meant to load directly; the front door links to the rest as
it needs it.
