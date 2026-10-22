---
"@curatejs/core": patch
---

Preserve cited evidence when log format repair fails. Accept observations
that cite several dates and items with a terminal period. Keep valid lines
and malformed lines naming a supplied item, and record retained malformed
lines and discarded lines under `formatRecovery`. Empty repairs and
unusable condensed replies keep the original cited log.
