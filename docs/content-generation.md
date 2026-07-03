# 内容生成模块

内容生成有两层：**规则化基线**（本地确定性生成，永远可用）+ **可选的真实大模型增强**（配置后覆写文案）。服务端创建、导入、编辑、重新规划任务时都会重新生成草稿内容。

## 生成内容

- `listingTitle`：优先使用商品标题中的英文/数字词；没有英文词时使用类目关键词组合。
- `sellingPoints`：基于类目、SKU、重量、库存生成 4 条卖点。
- `description`：生成英文描述，提醒发布前复核图片、合规词和类目映射。
- `categoryPath`：使用 `Temu / 商品类目`。
- `attributes`：合并商品属性、SKU 属性，并补充 `usage`、`package`、`source`。
- `skuPricing`：保留 SKU 属性和库存，价格由核价模块写入。

## 真实大模型增强

- 实现：[`packages/shared/src/llm-content.ts`](../packages/shared/src/llm-content.ts) 的 `enhanceListingDraftWithLlm`，用 Node 内置 `fetch` 直连 **OpenAI 兼容**的 `/chat/completions`，零新依赖，一套代码适配 DeepSeek / Qwen / OpenAI / 本地 vLLM。
- **只接管 `listingTitle` / `sellingPoints` / `description` 三项文案**；定价、SKU、attributes、categoryPath、searchKeywords 仍由确定性逻辑决定，不交给模型。
- 接入位置：**只在交互式单件重规划入口** `planTaskForProduct`（`POST /plan/:productId`）生效。无人值守队列/恢复批跑走的两个店小秘建任务函数刻意保持同步+规则化 —— 那是硬门控自动化热路径，不引入每件一次的网络依赖；店小秘 work-item 的 description 是"按需求修复"的功能性指引，也不该被覆写。
- **优雅回退（硬规则）**：未配置 `LLM_API_KEY` → 行为与纯规则 100% 一致，不加任何风险；调用失败/超时/解析失败 → 回退规则草稿，并附一条 `level:low` 的 `risk-llm-fallback`（可见但不阻断）。模型输出会复用 `sanitizeMarketplaceEnglishText` 清洗、标题裁到 ≤120 字符、卖点取前 4 条，并重跑内容风险判定。

### 环境变量

| 变量 | 作用 | 默认 |
|------|------|------|
| `LLM_API_KEY` | 模型 API key；**不设 = 不启用**，纯规则生成 | 无（禁用） |
| `LLM_BASE_URL` | OpenAI 兼容基址（如 `https://api.deepseek.com/v1`） | `https://api.openai.com/v1` |
| `LLM_MODEL` | 模型名 | `gpt-4o-mini` |
| `LLM_TIMEOUT_MS` | 单次调用超时（毫秒） | `20000` |

## 风险提示

内容生成会附加以下风险：

- `risk-sensitive-keywords`：检测到品牌词、敏感词或合规高风险词。
- `risk-missing-images`：商品没有图片链接。
- `risk-thin-attributes`：属性数量不足。
- `risk-title-too-long`：标题长度超过当前限制。
- `risk-llm-fallback`（low）：真实大模型调用失败，本次回退到规则草稿。

## 当前限制

- 规则化生成只能做基础草稿，不等同于最终可直接发布的营销文案。
- 类目关键词表还比较小，需要随着商品类目扩展。
- 敏感词表是本地静态表，后续应接入更完整的品牌词、禁售词和平台规则。
- 大模型增强目前只覆盖交互式重规划，未覆盖无人值守批量（刻意为之，见上）。

## 后续升级

- ~~接入大模型生成标题、卖点和描述。~~（已完成：交互式重规划入口，见「真实大模型增强」）
- 增加类目模板，把属性补全变成类目相关。
- 增加英文合规改写，避免夸大、医疗、杀菌等风险表达。
- 支持人工编辑 AI 草稿并持久化。
