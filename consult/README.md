# consult

Checks a payment request against a Policy's mandatory Floor Conditions and folds the results into one Verdict.

```ts
import { consult, PAY_CATALOG } from "./src";

const response = consult(request, PAY_CATALOG, policy);
// response.verdict: "ALLOW_UNDER_POLICY" | "DENY" | "UNKNOWN"
// response.results: [{ id, status, evidence }, ...]
// response.floorIds, response.advisory: true
```

Run `yarn consult:typecheck` and `yarn consult:test`.
