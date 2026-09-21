# consult

Checks a payment request against the mandatory Floor Conditions and a Policy, then folds the results into one Verdict.

```ts
import { consult } from "@hedwig/consult";

const response = consult(request, policy);
// response.proceed: boolean, response.band: "green" | "amber" | "red"
// response.verdict: "ALLOW_UNDER_POLICY" | "DENY" | "UNKNOWN"
// response.support: 0..1
// response.results: [{ id, question, status, code, evidence, evidenceClass, reference }, ...]
// response.floorIds, response.advisory: true
```

`support` shows how much of the owner's checklist was proven and how strong the proof behind it was; it never decides `verdict`. Callers act on `proceed`.

Run `yarn consult:typecheck` and `yarn consult:test`.
