# 换机上手 + stash 甄别备忘

> 2026-07-03 换机前生成。老电脑不再使用,本文帮新电脑「克隆即最新进度」上手,
> 并说明那个 `wip/stash-7ce899d` 分支里到底有什么值得救。

## 1. 新电脑上手(3 步)

```bash
git clone https://github.com/ppzbb666-del/Auto_goods.git
cd Auto_goods                 # 默认在 master = 最新进度(含 POD Studio)
npm install                   # 装 workspaces 依赖(node_modules 不入库)
npm run dev:server            # http://localhost:8787
npm run dev:dashboard         # http://localhost:5173
```

克隆下来默认就是 `master`,不用 checkout 别的分支。之后开发都在 `master` 上,
收工前 `git add -A && git commit && git push`。

## 2. GitHub 上有什么(全部代码已上云)

| 分支 | 提交 | 说明 |
|------|------|------|
| `master` | `892e959` | 最新主线,克隆默认分支 |
| `feat/dianxiaomi-save-draft-walls` | `892e959` | 与 master 同点(历史备份) |
| `wip/stash-7ce899d` | `83d34ea` | 抢救出来的旧 parked 工作,**未合入 master**(见 §4) |

## 3. GitHub 上「没有」、换机需手动处理的东西

被 `.gitignore` 排除,不在仓库里:

- **可自动重建,不用管**:`node_modules`(`npm install`)、`dist`/`build`/`.vite`、
  `.runtime`/`output`(运行时产物)、`*.log`。
- **`待发布编辑页/`(约 35M)** —— 真实店小秘**已登录浏览器用户目录,含 cookie/凭据**,
  按项目规矩绝不入库。新电脑没有它,因此:
  - **纯写代码 / 看界面**:不受影响,直接开发。
  - **要跑写动作(save-draft / submit-listing)**:必须先在新电脑上**重新做真实店小秘
    登录 + 校准**一次,否则被 `dianxiaomi-session` 闸门挡在 `PAUSED`。
    流程见 [real-dianxiaomi-calibration-runbook.md](real-dianxiaomi-calibration-runbook.md)。
- 全仓库**没有** `.env` / 密钥文件,无凭据遗漏风险。

## 4. `wip/stash-7ce899d` 分支:救还是丢?

### 结论:主体是旧实验,**默认不合入 master**;只有极少数类型定义值得酌情捞回。

这个分支是老电脑上一个 4946 行的未提交 stash,抢救成分支上了云。它诞生于
基点 `7ce899d`(6 月中旬),而 **master 之后又推进了 22 个提交**(一路修到 7/3 的
价格墙 / submit 墙 / edit.json 裁决)。所以 `git diff master...wip` 显示的
`+4946 / -320` 是 merge-base 算法的**假象**——绝大部分「新增」只是因为 stash 落后了
22 个提交,并非真的独有。

**逐文件甄别结果:**

| 文件 | 结论 |
|------|------|
| `planner.ts`(+864) | 新增的 7 个符号(`PUBLISH_CHECK_*`、`listDianxiaomi*`、`generateSelectorConfig*` 等)master **全部已有**且更完善 → **丢弃** |
| `dianxiaomi-adapter.ts`(+762) | `findFieldByKeyword`、`hasPublishSurface` 等 master 已有 → **丢弃** |
| `content.js`(+513)、`snapshot.ts`(+767) | 未发现 master 缺失的独有关键函数 → **丢弃** |
| `automation-runner.ts` / `index.ts` / test | master 已被后续 22 提交超越 → **丢弃** |
| **`packages/shared/src/types.ts`(+110)** | **唯一值得看的救援点** ↓ |

### 唯一值得酌情捞回:types.ts 里 7 个 master 没有的快照类型

这些是当时探索「媒体 / 尺码表 / 发货仓 快照」方向留下的类型定义,master 里目前没有:

- `DianxiaomiImageRequirementType`("mainImage" | "detailImage" | "skuImage")
- `DianxiaomiImageRequirementRule`
- `DianxiaomiImageTypeStats`
- `DianxiaomiManualDocumentSnapshot`
- `DianxiaomiVideoSnapshot`
- `DianxiaomiSizeChartSnapshot`
- `DianxiaomiFulfillmentSnapshot`

**它们只是类型,没有配套实现**(实现散在 stash 的 adapter/snapshot 里,但那些已被
master 超越)。除非将来要做「媒体/尺码表/发货仓 结构化快照」,否则不用管。要看原文:

```bash
git show wip/stash-7ce899d:packages/shared/src/types.ts   # 见第 85~132 行
```

### 建议处置

1. **默认**:`master` 上正常开发,把 `wip/stash-7ce899d` 当历史存档,不动它。
2. **若将来要做媒体/尺码表快照**:只从上面那 7 个类型手工拷回需要的,**不要**
   `git merge wip/stash-7ce899d`(会拖回 22 个提交前的旧逻辑,覆盖已上线的修复)。
3. 确认彻底用不上后,可删远端分支:
   `git push origin --delete wip/stash-7ce899d`。
