Requested changes on `otel-schema#590`.

Required production behavior:

- Allowed: case-insensitive `prod`, `staging`, `dev`, normalized to lowercase.
- Rejected before publication: `qa`, `unknown`, malformed, whitespace-padded, and arbitrary values.
- Missing input: omit `deployment.environment`; do not emit `unknown`.
- Per-tenant limit: at most 3 distinct values; never admit a fourth.
- Required parity: OTel collector/ingestion producer → metrics-router → rollup-service consumer. Each must use the canonical `deployment.environment` label with identical values, and rejected inputs must create no series.

The PR’s arbitrary lowercasing, `unknown` fallback, `qa` support, limit of 5, and missing parity fixture are blocking issues.
