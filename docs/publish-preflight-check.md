# Publish Preflight Check

发布前检查用于在同步到店小秘之前给任务做最后一道结构化校验。

## API

- `GET /tasks/:taskId/publish-check`
- 返回 `taskId`、`canPublish`、`issues`、`checkedAt`。
- `POST /tasks/publish-check/batch`
- 请求体：`{ "taskIds": ["task-id"] }`。
- 返回多个任务的发布前检查结果，不修改任务状态。

## Blocking Issues

以下高风险问题会让 `canPublish` 返回 `false`：

- 任务尚未审核通过。
- 商品缺少图片链接。
- 草稿标题为空。
- 存在无效 SKU 售价。

## Warning Issues

以下中风险问题会展示给审核员，但不会单独阻止发布：

- 草稿卖点为空。

## Dashboard

Dashboard 的审核工作台会轮询发布前检查接口，并展示当前任务是否可以发布以及所有检查项。同步到店小秘按钮仍然只允许 `approved` 任务使用。

任务列表支持多选后执行批量发布前检查，用于在批量审核或批量同步前快速筛出需要处理的问题任务。
