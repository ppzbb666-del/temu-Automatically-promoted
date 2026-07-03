# 手动商品录入

控制台左侧提供手动录入面板，用于临时创建商品任务。当前支持单 SKU 和多 SKU。

## 字段

- 商品标题
- 类目
- SKU 名称
- 成本价 CNY
- 国内运费 CNY
- 重量 kg
- 库存
- 来源链接
- 商品属性
- 图片链接
- SKU 列表

## 多 SKU 格式

SKU 列表每行一个 SKU：

```text
SKU名,成本价,库存,属性
```

示例：

```text
灰色 M,12.9,100,颜色:灰色;尺码:M
灰色 L,13.6,80,颜色:灰色;尺码:L
```

商品属性和 SKU 属性都支持：

```text
颜色:灰色;材质:尼龙
```

图片链接支持换行、`;`、`；` 或 `|` 分隔。

保存后系统会：

1. 创建 `manual` 来源商品。
2. 按当前核价规则生成刊登任务。
3. 将任务设为 active task。
4. 持久化到 `.runtime/data/planner-state.json`。

## API

```http
POST /products/manual
```

请求示例：

```json
{
  "title": "便携收纳包",
  "category": "旅行收纳",
  "supplierPriceCny": 12.9,
  "estimatedDomesticShippingCny": 1.6,
  "estimatedWeightKg": 0.22,
  "stock": 100,
  "skuName": "灰色 M",
  "sourceUrl": "https://detail.1688.com/example",
  "attributes": {
    "材质": "尼龙"
  },
  "skus": [
    {
      "skuName": "灰色 M",
      "costCny": 12.9,
      "stock": 100,
      "attributes": {
        "颜色": "灰色",
        "尺码": "M"
      }
    }
  ],
  "images": [
    "https://images.example.com/bag-1.jpg"
  ]
}
```
