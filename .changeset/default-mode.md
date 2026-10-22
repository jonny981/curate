---
"@curatejs/core": minor
"@curatejs/chat": minor
"@curatejs/git": minor
"@curatejs/markdown": minor
---

Use the default mode for agents working from any mix of chat, git and docs. Decide every ranked part and keep references scored 0.0146 or more, with labels and routing off. Git and Markdown sources enable the rare-word round; chat leaves it off. Allow each source's rare-word default to be overridden, or set the round for the whole pick.

Add `conversation-recall` for questions about past conversations. It enables labels using each source's kinds: chat carries seven transcript kinds; git and Markdown carry none. Export `defaultMode` and `conversationRecall` as settings objects for the separate read, pick and curate calls.

Reuse enabled labels from a persistent cache, with separate identities for each built-in decision model. Allow custom kind sets on sources and direct picks, keep their stored labels separate, and record the kind set applied to each source.
