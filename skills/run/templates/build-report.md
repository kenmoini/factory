# Build Report — {{task_id}} {{task_title}}
<!-- factoryDoc: build-report -->

**Workstream:** {{slug}} · **Branch:** `{{branch}}` · **Worktree:** `{{worktree}}` · **Base:** {{base_sha}}
**Commands:** lint `{{lint_cmd}}` · test `{{test_cmd}}` · build `{{build_cmd}}`

The builder appends one section per round (round 0 = initial build, then `Round <n>` per fix round,
`Merge conflict <k>` after a conflict), in this shape:

<!--
## Round <n> — <DONE|DONE_WITH_CONCERNS|NEEDS_CONTEXT|BLOCKED>
### Commits
- <short sha> <subject>
### Tests
`<test command>` → <summary, e.g. 48 pass, 0 fail>
### Lint
`<lint command>` → <summary>
### What changed
- <file>: <change>
### Findings addressed
- <finding id>: <how> (fix rounds only)
### Concerns
- <concern or "none">
-->
