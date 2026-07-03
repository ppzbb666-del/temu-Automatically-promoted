# Sync Preflight Gate

同步到店小秘之前必须通过发布前检查。

## Rules

- `POST /tasks/active` only accepts tasks whose publish preflight result has `canPublish: true`.
- `GET /tasks/active?requireApproved=true` hides tasks that are not approved or fail publish preflight.
- Dashboard disables the sync button unless the task status is `approved` and publish preflight returns `canPublish: true`.

## Why

审核通过只能说明人工同意当前内容进入下一步。发布前检查继续拦截缺图、空标题、无效 SKU 售价等结构性问题，防止绕过 UI 直接调用 API 时把高风险任务交给自动化 runner。
