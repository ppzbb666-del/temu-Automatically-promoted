# Dianxiaomi Snapshot Diagnosis

真实店小秘页面适配前，先采集页面快照，再运行诊断命令判断现有选择器策略是否能识别关键字段。

## Commands

采集快照：

```powershell
npm run snapshot --workspace @temu-ai-ops/automation
```

诊断最新快照：

```powershell
npm run snapshot:diagnose --workspace @temu-ai-ops/automation
```

诊断指定快照：

```powershell
npm run snapshot:diagnose --workspace @temu-ai-ops/automation -- --snapshot=output/playwright/dianxiaomi-snapshot-example.json
```

## Output

诊断文件会写入 `output/playwright/dianxiaomi-diagnosis-*.json`，并在终端输出：

- `Required fields ready`：标题、价格或 SKU 行、库存或 SKU 行、保存按钮是否满足最低自动填表条件。
- `Fields`：标题、描述、价格、库存、属性字段识别状态。
- `Buttons`：保存和发布按钮识别状态。
- `SKU rows`：检测到的 SKU 行数量。

## How To Use

- 如果 `title` 缺失，优先补标题字段关键词或选择器。
- 如果 `price` / `stock` 缺失但 `SKU rows` 大于 0，优先校准 SKU 行内字段识别。
- 如果 `save` 缺失，不能自动保存草稿，需要先校准保存按钮。
- 如果 `Required fields ready` 为 `no`，不要运行自动填表批量任务。
