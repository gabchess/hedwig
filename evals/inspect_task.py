"""inspect-ai view of the Hedwig eval suite.

The cases and the scoring rule are the same as `yarn evals`. The solver runs
that TypeScript suite once, then answers each sample with the verdict Hedwig
returned. No model is called: run it with inspect's built-in mock model.

    inspect eval evals/inspect_task.py --model mockllm/model

Prerequisites: the repo's Node install steps (see EVALS.md) and
`pip install inspect-ai`.
"""

import json
import os
import subprocess
import tempfile
from pathlib import Path

from inspect_ai import Task, task
from inspect_ai.dataset import Sample
from inspect_ai.scorer import (
    CORRECT,
    INCORRECT,
    Score,
    Target,
    accuracy,
    grouped,
    scorer,
)
from inspect_ai.solver import Generate, TaskState, solver

EVALS_DIR = Path(__file__).resolve().parent
REPO_DIR = EVALS_DIR.parent
TS_MOCHA = REPO_DIR / "node_modules" / "ts-mocha" / "bin" / "ts-mocha"

_verdicts: dict[str, dict] = {}


def _cases() -> list[dict]:
    with open(EVALS_DIR / "cases.json", encoding="utf-8") as handle:
        return json.load(handle)["cases"]


def _accepted(case: dict) -> list[str]:
    return case.get("anyOf") or [case["expected"]]


def _run_suite() -> dict[str, dict]:
    """Run the TypeScript suite once and return its rows by case id."""
    if _verdicts:
        return _verdicts
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "results.json"
        env = {**os.environ, "HEDWIG_EVALS_RESULTS": str(out)}
        command = [
            "node",
            str(TS_MOCHA),
            "-p",
            str(EVALS_DIR / "tsconfig.json"),
            str(EVALS_DIR / "hedwig.eval.ts"),
        ]
        # A failing case makes mocha exit nonzero but still writes the rows,
        # and the scorer reports that case as incorrect.
        subprocess.run(command, cwd=REPO_DIR, env=env, check=False)
        if not out.exists():
            raise RuntimeError("the TypeScript eval suite wrote no results")
        report = json.loads(out.read_text(encoding="utf-8"))
    _verdicts.update({row["id"]: row for row in report["cases"]})
    return _verdicts


@solver
def hedwig_consult():
    async def solve(state: TaskState, generate: Generate) -> TaskState:
        row = _run_suite().get(str(state.sample_id))
        state.output.completion = row["verdict"] if row else "NO_RESULT"
        state.metadata["proceed"] = bool(row and row["proceed"])
        state.metadata["first_non_pass_code"] = row and row["firstNonPassCode"]
        return state

    return solve


@scorer(metrics=[accuracy(), grouped(accuracy(), "category")])
def verdict_in_label():
    async def score(state: TaskState, target: Target) -> Score:
        verdict = state.output.completion
        return Score(
            value=CORRECT if verdict in target.target else INCORRECT,
            answer=verdict,
            explanation=state.metadata.get("basis", ""),
        )

    return score


@task
def hedwig_evals() -> Task:
    samples = [
        Sample(
            id=case["id"],
            input=case["description"],
            target=_accepted(case),
            metadata={"category": case["category"], "basis": case["basis"]},
        )
        for case in _cases()
    ]
    return Task(dataset=samples, solver=hedwig_consult(), scorer=verdict_in_label())
