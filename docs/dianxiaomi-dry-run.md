# Dianxiaomi Dry Run

Dry run mode checks whether the current Dianxiaomi listing page can be automated without writing form values, saving drafts, or submitting listings.

```powershell
npm run run --workspace @temu-ai-ops/automation -- --dry-run=true --headed=true
```

Use this after opening the real Dianxiaomi Temu listing or edit page. The runner will:

- wait for login if needed
- wait until a listing form is detected
- inspect title and description fields
- inspect attribute field availability
- inspect SKU rows
- inspect configured save and submit buttons
- save a screenshot and JSON report under `output/playwright`

Dry run reports are named:

```text
dianxiaomi-dry-run-*.json
```

Dashboard includes these reports in the recent automation report panel.

Recommended real-page flow:

```powershell
npm run snapshot --workspace @temu-ai-ops/automation
npm run snapshot:diagnose --workspace @temu-ai-ops/automation
npm run selector-config:generate --workspace @temu-ai-ops/automation
npm run run --workspace @temu-ai-ops/automation -- --dry-run=true --headed=true
```

Only run without `--dry-run=true` after the dry run report is `completed` or the remaining skipped checks are acceptable.
