# Playwright 店小秘自动上品脚本

脚本位置：`apps/automation/src/temu-publish.ts`

它默认走店小秘工作流：打开店小秘，复用本地浏览器登录态，从本地任务 API 或 JSON 文件读取上品草稿，然后在产品编辑/刊登页自动填写标题、描述、属性、SKU 价格和库存。默认只尝试保存草稿，不会点击最终发布。

## 启动前

先启动本地任务服务：

```bash
npm run dev:server
```

第一次运行会打开真实浏览器。你需要在浏览器里手动登录店小秘，并进入对应商品的产品编辑或刊登页；脚本检测到表单后会自动继续。登录态会保存在 `.runtime/playwright/dianxiaomi-profile`，后续运行会复用。

## 常用命令

打开店小秘并读取当前 active task：

```bash
npm run run --workspace @temu-ai-ops/automation
```

采集店小秘当前页面结构和截图：

```bash
npm run snapshot --workspace @temu-ai-ops/automation
```

查看最近执行报告：

```bash
npm run report --workspace @temu-ai-ops/automation
```

指定店小秘具体页面：

```bash
npm run run --workspace @temu-ai-ops/automation -- --url="https://www.dianxiaomi.com/web/popTemu/edit?id=<real-item-id>"
```

注意：

- `--url` 必须是店小秘真实商品编辑页，不能填首页，也不能填 `help.dianxiaomi.com` 帮助页。
- 如果这次启动只需要借用已登录 profile，也可以先打开店小秘主站登录，再手动进入真实商品编辑页；自动化现在不会再把帮助页当成目标页反复跳转。

从任务 JSON 文件读取：

```bash
npm run run --workspace @temu-ai-ops/automation -- --task-file=./task.json
```

只填表，不点击保存：

```bash
npm run run --workspace @temu-ai-ops/automation -- --save-draft=false
```

填完后停在页面等待人工审核，不保存也不提交：

```bash
npm run run --workspace @temu-ai-ops/automation -- --review=true
```

允许点击发布/提交按钮：

```bash
npm run run --workspace @temu-ai-ops/automation -- --submit=true
```

## 参数

- `--platform=`：平台预设，当前自动填表 runner 默认并仅支持 `dianxiaomi`
- `--url=`：目标页面地址，店小秘默认 `https://www.dianxiaomi.com/`
- `--task-api=`：任务 API，默认 `http://localhost:8787/tasks/active`
- `--task-file=`：从本地 JSON 文件读取任务，优先级高于 API
- `--profile=`：浏览器登录态目录，默认 `.runtime/playwright/dianxiaomi-profile`
- `--headed=`：是否显示浏览器，默认 `true`
- `--slow-mo=`：每个动作的延迟毫秒数，默认 `80`
- `--save-draft=`：是否尝试保存草稿，默认 `true`
- `--submit=`：是否点击发布/提交，默认 `false`
- `--review=`：审核停靠模式，默认 `false`；开启后填完表只截图和写报告，不保存也不提交

## 调试产物

每次填写后会保存调试产物到 `output/playwright/`：

- `dianxiaomi-filled-*.png`：填表后的整页截图。
- `dianxiaomi-run-*.json`：执行报告，包含任务、页面、最终状态和每一步结果。
- `dianxiaomi-error-*.png`：运行异常时的现场截图。
- `dianxiaomi-error-*.json`：运行异常时的错误报告。
- `dianxiaomi-snapshot-*.json`：`snapshot` 命令采集的输入框、按钮和 SKU 行摘要。
- `dianxiaomi-snapshot-*.png`：`snapshot` 命令采集的页面截图。

如果页面字段识别失败，优先查看执行报告、截图和终端里的“未找到字段”提示，再补充对应页面的字段关键词或 DOM 选择器。

## 当前开发路线

长期开发路线固定在 `docs/roadmap-to-production.md`。当前优先做店小秘页面快照采集、店小秘适配器和单商品保存草稿闭环。
