# 审核工作流

控制台支持对当前任务执行人工审核。审核记录保存在任务的 `review` 字段中，并随任务一起持久化。

## 状态

任务状态新增：

- `approved`：审核通过，可以进入后续发布或同步流程。
- `rejected`：审核驳回，不应继续发布。
- `reviewing`：待审核或退回修改。

审核状态：

- `pending`：待审核。
- `approved`：审核通过。
- `rejected`：已驳回。
- `changes_requested`：退回修改。

## API

```http
POST /tasks/:taskId/review
```

请求体：

```json
{
  "decision": "approve",
  "note": "价格和文案已确认"
}
```

`decision` 可选：

- `approve`：审核通过。
- `request_changes`：退回修改。
- `reject`：驳回。

## 行为说明

- 审核通过后任务状态变为 `approved`。
- 退回修改后任务状态变为 `reviewing`。
- 驳回后任务状态变为 `rejected`。
- 每次审核动作都会写入 `review.history`，最多保留最近 50 条。
- 已审核通过的任务如果再次编辑商品或草稿，会回到 `reviewing`。
