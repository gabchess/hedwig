# consult

Checks a payment request against the mandatory Floor Conditions and a Policy, then folds the results into one Verdict.

```ts
import { consult } from "./src";

const response = consult(request, policy);
// response.verdict: "ALLOW_UNDER_POLICY" | "DENY" | "UNKNOWN"
// response.results: [{ id, status, evidence }, ...]
// response.floorIds, response.advisory: true
```

Run `yarn consult:typecheck` and `yarn consult:test`.
