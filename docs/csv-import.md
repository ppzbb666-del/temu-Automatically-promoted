# CSV / Excel 商品导入

控制台左侧提供商品导入面板。当前支持两种方式：

- 直接粘贴 CSV 文本。
- 上传 `.xlsx` Excel 文件。
- 下载 CSV 模板后按模板填写。

一行代表一个 SKU；同 `productId` 的多行会合并为同一个商品。如果没有 `productId`，会按商品标题生成 ID。

## 推荐字段

```csv
productId,title,category,supplierPriceCny,estimatedDomesticShippingCny,estimatedWeightKg,skuId,skuName,stock,attributes,sourceUrl,images
```

字段说明：

- `productId`：商品 ID，可选；多 SKU 合并时建议填写。
- `title`：商品标题，必填。
- `category`：商品类目。
- `supplierPriceCny`：采购/供货成本，人民币。
- `estimatedDomesticShippingCny`：国内运费，人民币。
- `estimatedWeightKg`：预估重量，千克。
- `skuId`：SKU ID，可选。
- `skuName`：SKU 名称。
- `stock`：库存。
- `attributes`：属性，格式为 `颜色:灰色;尺码:M`。
- `sourceUrl`：来源链接，例如 1688 链接。
- `images`：图片链接，多个链接用 `;`、`；` 或 `|` 分隔。

## 示例

```csv
productId,title,category,supplierPriceCny,estimatedDomesticShippingCny,estimatedWeightKg,skuName,stock,attributes,sourceUrl
bag-001,便携收纳包,旅行收纳,12.9,1.6,0.22,灰色 M,100,颜色:灰色;尺码:M,https://detail.1688.com/example
bag-001,便携收纳包,旅行收纳,13.6,1.6,0.24,灰色 L,80,颜色:灰色;尺码:L,https://detail.1688.com/example
```

## 当前限制

- Excel 导入默认读取第一个工作表。
- Excel 第一行必须是字段名，字段名与 CSV 一致。
- 当前只支持 `.xlsx`，不支持旧版 `.xls`。
- CSV 解析器支持基础引号和逗号转义，不建议在字段里放复杂换行。
- AI 内容生成仍沿用当前 mock 规则，后续会替换为真实 AI 生成流程。

## 导入校验

导入时会返回警告并展示在控制台：

- 缺少商品标题：该行跳过。
- 缺少有效成本价：按 0 处理，并提示。
- 缺少有效库存：按 0 处理，并提示。
- SKU ID 重复：继续导入，但提示重复。

## 本地持久化

导入的 CSV 商品、生成的任务和当前 active task 会保存到：

```text
.runtime/data/planner-state.json
```

该目录已加入 `.gitignore`，用于本机运行数据，不会提交到代码仓库。重启本地 server 后，导入过的商品任务会自动恢复。
