# 核价规则

控制台左侧提供核价规则面板。保存后，后端会把规则写入本地状态，并重算仍处于 `planned` / `queued` 的任务价格。

## 字段

- `exchangeRateCnyPerUsd`：人民币兑美元汇率，用于把采购价和国内运费折算成美元。
- `logisticsUsdPerKg`：默认每千克预估物流成本，美元。没有命中分段规则时使用。
- `logisticsRateTiers`：可选物流重量分段规则。
- `platformFeeUsd`：每件预估平台固定费用，美元。
- `targetMarginRate`：目标毛利率，用于展示和风控判断。
- `priceMultiplier`：售价倍数，用于从保本价计算建议售价。
- `minimumMarginRate`：最低毛利率阈值，低于该值会生成高风险提醒。
- `minimumSuggestedPriceUsd`：最低建议售价阈值，低于该值会生成中风险提醒。

## 物流分段

控制台使用一行一个分段：

```text
最小重量kg,最大重量kg,基础费USD,每kg费用USD
0,0.25,0.35,3.6
0.25,0.75,0.45,3.2
0.75,,0.75,2.8
```

最后一段的最大重量可以留空，表示无上限。命中分段后物流费计算为：

```text
基础费 + 商品重量kg * 每kg费用
```

## API

读取规则：

```http
GET /pricing-rules
```

保存规则：

```http
PUT /pricing-rules
```

请求体：

```json
{
  "exchangeRateCnyPerUsd": 7.2,
  "logisticsUsdPerKg": 3.2,
  "logisticsRateTiers": [
    { "minWeightKg": 0, "maxWeightKg": 0.25, "baseFeeUsd": 0.35, "usdPerKg": 3.6 },
    { "minWeightKg": 0.25, "maxWeightKg": 0.75, "baseFeeUsd": 0.45, "usdPerKg": 3.2 },
    { "minWeightKg": 0.75, "baseFeeUsd": 0.75, "usdPerKg": 2.8 }
  ],
  "platformFeeUsd": 0.78,
  "targetMarginRate": 0.28,
  "priceMultiplier": 1.55,
  "minimumMarginRate": 0.18,
  "minimumSuggestedPriceUsd": 3
}
```

## 持久化

核价规则会保存到：

```text
.runtime/data/planner-state.json
```
