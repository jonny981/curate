---
"@curatejs/core": patch
---

Ask the writer once more when it returns an empty reply to a whole write,
with one added line asking it to check the evidence again. A second empty
reply keeps the empty log. Record the extra call as `emptyRetries`.
