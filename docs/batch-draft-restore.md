# Batch Draft Restore

批量草稿恢复用于把多个任务恢复到最近一次 AI 生成的草稿版本，适合批量编辑后需要回到 AI 初稿重新审核的场景。

## API

```http
POST /tasks/draft/restore-latest-ai/batch
```

Request:

```json
{
  "taskIds": ["task-prod-wireless-cleaner-01"]
}
```

Response:

```json
{
  "restored": [],
  "skipped": [
    {
      "taskId": "task-id",
      "reason": "no ai draft version"
    }
  ]
}
```

## Behavior

- 每个任务会恢复到自己的最近 AI 草稿版本。
- 不要求不同任务共享同一个 `versionId`。
- 恢复成功后会写入新的 `restore` 草稿版本记录。
- 已审核通过或已完成任务恢复后会回到需要审核的状态，避免绕过人工审核。
- 没有 AI 草稿版本或任务不存在时会进入 `skipped`，不会影响其他任务恢复。

## Dashboard

任务列表支持多选后点击“批量恢复 AI 草稿”。恢复完成后会刷新任务列表、清空选区，并显示恢复/跳过数量。
