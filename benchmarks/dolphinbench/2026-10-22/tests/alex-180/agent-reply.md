Reviewed `otel-schema#590` and requested changes.

Required production contract:

- Allowed: case-insensitive exact `prod`, `staging`, and `dev`, normalized to lowercase.
- Rejected before publication: `qa`, `unknown`, whitespace-padded, malformed, and arbitrary values.
- Missing input: omit `deployment.environment`; never publish `unknown` or another default.
- Per-tenant limit: at most 3 distinct values; a fourth must never create a series.
- Parity required across: producer mapping → OTel ingestion → metrics-router → rollup-service. Key presence and bounded values must match bidirectionally, with regression evidence for rejected inputs and no resulting series.
