# Review R{{round}} {{reviewer}} — {{task_id}}
<!-- factoryDoc: review -->

**Task:** {{task_id}} {{task_title}} · **Round:** {{round}} · **Reviewer:** {{reviewer}} · **Verdict:** {{verdict}} · **Not applicable:** {{not_applicable}}
**Package:** `{{diff_path}}` ({{diff_range}})

## Summary
{{summary}}

## Findings
| ID | Severity | File:Line | Summary | Fix |
|---|---|---|---|---|
{{finding_rows}}

## Addressed (re-review)
| ID | Status | Note |
|---|---|---|
{{addressed_rows}}

## Result
```json
{"reviewer": "{{reviewer}}", "verdict": "{{verdict}}", "not_applicable": {{not_applicable}}, "findings": {{findings_json}}, "addressed": {{addressed_json}}}
```
