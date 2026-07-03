# probes/ — 一次性诊断探针

真实店小秘页面的**只读/半只读**诊断脚本。每个探针为某次根因排查而生，不属于生产链路（生产代码在 `../adapters/`）。跑法统一：

```bash
npx tsx apps/automation/src/probes/<probe>.ts [--url=...] [--profile=...]
```

默认 profile 多为 `.runtime/dianxiaomi-real-profile`（需已登录）。相对路径以**项目根**为 CWD。

## 现役（对应未解墙，别删）

| 探针 | 用途 | 关联 |
|---|---|---|
| probe-theme-color-structure.ts | dump 主题颜色/SKC 勾选态/color-table 行 | 墙 4（适配未写） |
| probe-variant-remap-confirm.ts | 「重新对应变种」确认流程结构 | 墙 4 |
| probe-color-skc.ts | `.skuAttrItem_1001` 颜色区块 + 色表行 | 墙 4 |
| probe-editjson-images.ts | 验证 `edit.json` 暴露每色图 URL | 墙 3（已验证 ✅，留作回归） |

## 已完成使命（问题已解或已固化进 adapter，可考虑删除）

- probe-readonly-category-state.ts / probe-category-detection-compare.ts / probe-category-restore.ts / probe-category-vue-state.ts / probe-public-category-fallback.ts —— 墙 1 品类（已解）
- probe-image-check-*.ts / probe-live-image-check-repair.ts / probe-image-translation-result.ts —— 图片检测/媒体工具排查（墙 2 第一层已修）
- probe-errmsg.ts / probe-publish-status.ts / probe-material-image-controls.ts / probe-product-image-surface.ts / probe-shipment-promise.ts / probe-site-warehouse.ts / probe-size-chart-structure.ts / probe-target-surface-readiness.ts / probe-transport-fields.ts / probe-variations.ts —— 各次校准的一次性结构探查

删除原则：关联的墙已解 + 对应能力有 adapter 生产代码 + 一个迭代内没再用到。
