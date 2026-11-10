# Validation Round {{round}} — {{slug}}
<!-- factoryDoc: validation -->
<!-- marker-labelled note: Round notes carry #factoryValidation, never #factoryDoc -->

**Workstream:** {{slug}} · **Plan rev:** {{plan_rev}} · **Verdict:** {{verdict}} · **Validated:** {{validated_at}}

## Lenses
| Lens | Verdict | Critical | Important | Minor |
|---|---|---|---|---|
{{lens_rows}}

## Blocking findings
{{blocking_findings}}

## Decision
{{decision}}

## Lens child note body (omit this section from the Round note)
Each lens child note (title `<lens>`) contains only the part below:

### {{lens}} — {{lens_verdict}}
| ID | Severity | Task | Summary | Fix |
|---|---|---|---|---|
{{lens_finding_rows}}

```json
{{lens_json}}
```
