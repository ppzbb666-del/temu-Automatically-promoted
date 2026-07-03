# 草稿内容编辑

控制台支持对 AI 生成的刊登草稿做人工修改。保存草稿内容不会重建商品资料，也不会重新核价，只会更新当前任务的 `draft`。

## 可编辑内容

- 发布标题。
- 核心卖点：一行一个卖点。
- 商品描述。
- 类目路径：一行一级类目。
- 草稿属性：`属性名:属性值`，分号或换行分隔。
- SKU 售价：一行一个 SKU，格式为 `skuId,SKU名,售价USD,库存,属性`。

## API

```http
PATCH /tasks/:taskId/draft
```

请求体示例：

```json
{
  "listingTitle": "Edited Listing Title",
  "sellingPoints": ["Edited point one", "Edited point two"],
  "description": "Edited description",
  "categoryPath": ["Temu", "Travel Organizer"],
  "attributes": {
    "material": "nylon"
  },
  "skuPricing": [
    {
      "skuId": "sku-gray-m",
      "skuName": "Gray M",
      "salePriceUsd": 9.99,
      "stock": 18,
      "attributes": {
        "color": "gray",
        "size": "M"
      }
    }
  ]
}
```

## 行为说明

- 如果任务不存在，返回 404。
- 未提交的字段保持原值。
- SKU 按 `skuId` 匹配，只更新已有 SKU。
- 已完成任务被编辑后会回到 `reviewing` 状态，避免编辑后直接视为完成。
- 每次 AI 生成、人工编辑、恢复版本都会写入 `draftVersions`。
- 草稿版本最多保留最近 20 条。

## 恢复版本

```http
POST /tasks/:taskId/draft/restore
```

请求体：

```json
{
  "versionId": "draft-ai-..."
}
```

恢复后会把该版本草稿设置为当前草稿，并新增一条 `restore` 版本记录。
