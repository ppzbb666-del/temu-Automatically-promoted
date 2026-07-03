# Dianxiaomi Selector Config

自动填表会优先使用店小秘选择器配置；配置不可用时再回退到关键词识别。

## Generate Config

先采集并诊断页面：

```powershell
npm run snapshot --workspace @temu-ai-ops/automation
npm run snapshot:diagnose --workspace @temu-ai-ops/automation
```

从最新诊断报告生成配置：

```powershell
npm run selector-config:generate --workspace @temu-ai-ops/automation
```

也可以在 Dashboard 的“店小秘选择器诊断”面板点击“生成选择器配置”。

默认输出：

```text
.runtime/dianxiaomi-selector-config.json
```

## Use Config

自动填表 runner 默认读取 `.runtime/dianxiaomi-selector-config.json`。

也可以指定配置：

```powershell
npm run run --workspace @temu-ai-ops/automation -- --selector-config=.runtime/dianxiaomi-selector-config.json
```

## Format

```json
{
  "fields": {
    "title": ["input[name=\"productTitle\"]"],
    "description": ["textarea[name=\"description\"]"],
    "price": ["input[name=\"salePrice\"]"],
    "stock": ["input[name=\"stock\"]"],
    "attribute": []
  },
  "buttons": {
    "save": ["button.save"],
    "submit": []
  },
  "mediaTools": {
    "imageTranslation": ["button:has-text(\"Image Translation\")"],
    "whiteBackground": ["button:has-text(\"White Background\")"],
    "imageEditor": ["button:has-text(\"Image Editor\")"],
    "batchResize": ["button:has-text(\"Batch Resize\")"],
    "imageManagement": ["button:has-text(\"Image Management\")"]
  },
  "skuRows": ["tr, [role='row'], [class*='sku' i]"]
}
```

## Notes

- 配置命中后优先使用配置 selector。
- selector 失效或找不到可见元素时，会回退到关键词识别。
- 真实店小秘页面改版后，重新运行 `snapshot`、`snapshot:diagnose`、`selector-config:generate` 即可更新配置。
- Dashboard 生成配置会调用 `POST /selector-config/generate`，使用最近一份诊断报告写入 `.runtime/dianxiaomi-selector-config.json`。
- Dashboard 会调用 `GET /selector-config` 展示当前配置是否存在、配置路径和 selector 数量。
