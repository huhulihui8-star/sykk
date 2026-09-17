# GitHub Pages 定时更新版

参见 [GitHub Pages 部署说明](GITHUB-PAGES.md)。以下为完整项目及历史部署说明，历史网址不代表当前发布状态。

# 最强分析师 · A 股 / 美股 / 全球指数信息面雷达

基于**当日公开信息**（新闻、财报公告、指数与行业 ETF 行情）生成 A 股、美股行业及国内外主流指数的**下一交易日信息面统计展望**。

> 产品边界：本站只输出行业与指数级别的统计展望。上涨/下跌百分比是**综合信息信号的相对占比**，不是经回测校准的真实概率，也不构成个股推荐、目标价、仓位建议或收益承诺。详见页面底部免责声明。

---

## 快速开始

```bash
npm install          # 安装依赖
cp .env.example .env # 配置环境变量（见下）
npm run dev          # 本地开发（vinext dev，含 Cloudflare Workers 本地模拟）
```

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 启动本地开发服务器 |
| `npm run build` | 生产构建，产物在 `dist/` |
| `npm start` | 用 wrangler 跑构建产物（Cloudflare 本地模拟） |
| `npm run serve` | **单端口生产启动**（先 build 再 `vinext start`，监听 `$PORT`、绑 `0.0.0.0`）——发布到托管平台时用这个 |
| `npm test` | 单元测试（`node --test`，无需测试框架） |
| `npm run typecheck` | TypeScript 全量类型检查 |
| `npm run lint` | oxlint（开启 type-aware 检查） |
| `npm run check` | 一次跑完 typecheck + lint + test |

已发布地址：<https://a-share-analyst-dashboard.app.workbuddy.host/>（`npm run serve` 作为启动命令，平台会自动注入 `PORT`）。

---

## 环境变量

见 `.env.example`。

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `MCP_API_KEY` | 生产必填 | `/mcp` 与 `/api/mcp` 的访问密钥。**未配置时该端点一律返回 401**（fail-closed，这是有意设计）。 |

Cloudflare D1 绑定由 `.openai/hosting.json` 的 `d1: "DB"` 声明，本地开发由 wrangler 自动模拟，不需要 `.env` 配置。

---

## 架构

```
外部数据源                      抓取与计算                     存储              渲染
────────────────────────────  ──────────────────────────  ──────────────  ──────────────────
东方财富 板块/指数/资讯/公告  ─┐
海外 RSS / 新浪 / 华尔街见闻   ─┤
CNBC / WSJ / MarketWatch 等  ─┼→ lib/market.ts              ─┐
SEC EDGAR Atom               ─┤   createMarketSnapshot()    │  D1 (可选)
东方财富批量行情      ─┘   （同轮启动、最多 6 路并发）           ├→ lib/market-repository.ts
                                  ↓                          │   ├ 内存快照缓存
                              SectorSnapshot / MarketSnapshot┘   ├ D1 快照缓存
                                                                  └ D1 行业历史缓存
                                                                       ↓
                                              app/page.tsx（Server Component 直接传 props）
                                              app/sectors/[code]/page.tsx
```

关键设计：

- **不造数据**。行情/新闻取不到就明确标记 `dataAvailable: false`、`dataStatus: STALE`，并且**不输出任何涨跌百分比**（`nextSessionDirection` 为 `null`），页面上显示"数据不足"。历史 K 线取不到就返回空，不生成模拟走势。
- **首页只传它真正会渲染的字段**。`toDashboardSnapshot()` 会剥离每个行业的证据链正文（`evidence`），并把事件按区域裁剪到看板实际需要的条数；`DashboardSector` 类型保证首页**不可能**读到证据链——详情页才需要全文。
  注意口径：**这类优化要测 HTTP 层的真实字节，不能用 `JSON.stringify` 代替**。React 的 RSC 序列化按引用去重，字符串化会把"同一对象的多次引用"算成多次重复，从而系统性高估收益（本项目实测过 228 KB vs 实际 17 KB 的差距）。
- **单一 schema 真值**：`lib/market-repository.ts` 的 `ensureSchema()` 是 D1 表结构的唯一来源，全部为 `CREATE ... IF NOT EXISTS`，不做任何破坏性 DDL。
- **多级降级**：内存缓存 → D1 快照缓存 → 行情读缓存（见下）→ 合并上一份快照的可用行业（`mergeSnapshotCoverage`）→ 前端 `app/error.tsx` 兜底。

### 数据源与延迟披露

| 市场 | 行情来源 | 延迟 |
| --- | --- | --- |
| A 股行业（31 个申万一级） | 东方财富板块资金流（`push2delay`） | 约 15 分钟 |
| 国内指数（6 个） | 东方财富批量行情（`ulist.np`，一次请求取回全部） | 近实时 |
| 美股行业（11 个 GICS） | 东方财富批量行情，用 XLE/XLF/XLK 等行业 ETF 作代理 | 近实时 |
| 海外指数（11 个） | 东方财富指数原始代码（罗素2000 使用 IWM 代理） | 近实时 |

A 股信息因子按**海外主流媒体及经济学家对中国分析 60% + 国内经济新闻与上市公司公告 40%** 加权；综合分 = 信息面 65% + 盘面 35%。

### 图表：自绘 SVG，不依赖 recharts

4 张图（行业涨跌幅横柱、信息面环形、60 日面积、量能+宽度双轴）都在
`components/charts.tsx` 里用 SVG 直接画，`lib/chart-ticks.ts` 提供刻度与柱宽算法。

- **为什么换掉**：recharts 的图表代码实测占 **111.3 KB gzip**（客户端 JS 的最大单块），换成自绘只有 **3.8 KB**。整站客户端 js+css 现在是 **154 KB gzip**（换之前 ≈ 261 KB，按图表增量 107.5 KB 推算）。
- **几何怎么保证不漂移**：刻度算法（`niceTickValues` / `niceTickValuesFixedDomain`）与柱宽公式（`trunc(band - 2×gap)`）是按 recharts 源码复刻的，并与 recharts 真实渲染做过逐项对拍——刻度坐标、柱子/曲线包围盒 0px 偏差，环形图路径逐点偏差 6e-5px。另外 7 条容易踩的细节（margin 不与默认值合并、`tspan` 基线、标签从末尾贪心筛选等）记在 `work/preview/README.md`。
- **服务端直出**：图表现在是 Server Component 渲染出来的真实 SVG（recharts 时代首屏是空的，要等 JS），因此首屏就能看到图。
- **入场动画用 CSS**（`app/globals.css` 的 `.chart-anim-*`）：柱子 400ms 从 0 轴生长、面积/折线 1500ms 从左揭示、环形 1500ms（延迟 400ms）缩放淡入 —— 时长与缓动取自 recharts 默认值，且能被 `prefers-reduced-motion` 关掉。用 CSS 而不是 JS 逐帧，是因为图表已服务端直出，JS 动画会先显示成图再回跳重播。
- 唯一的已知差异：环形的入场是缩放淡入，recharts 是"扇形扫开"（扫开要动 `d` 属性，CSS 做不了）。

---

## ⚠️ 出站请求预算（改代码前必读）

快照构建在**单个请求内并发发出大量上游请求**。Cloudflare Workers 免费计划的**单请求子请求上限是 50**，超限会让整个快照构建失败并静默降级为旧数据。

当前冷启动：**38 个子请求**（2026-09 实测；换源前 47）。热刷新（命中行情缓存）会显著更低，休市期间接近 0。

| 来源 | 冷启动请求数 |
| --- | --- |
| `push2delay.eastmoney.com`（板块 5 页 + 国内指数、美股 ETF、海外指数各 1 次） | 8 |
| 海外 RSS（CNBC×5 / WSJ×4 / MarketWatch×3 / Nasdaq×2 / Fortune / Seeking Alpha×7 / Rhodium） | 23 |
| 新闻与研报（东财资讯 350/351、上市公司公告、机构研报、SEC） | 5 |
| 中文快讯（新浪 7x24、华尔街见闻） | 2 |
| ~~`query1.finance.yahoo.com`（11 ETF + 12 指数）~~ 已换源 | 0 |
| ~~`news.google.com`（RSS 查询）~~ 全部超时，已移除 | 0 |

**因此：新增任何上游数据源前，必须先确认总请求数不会越过 50。** 可用的压缩手段：

- 能批量就批量（美股 11 ETF、海外 11 指数、国内 6 指数各用 1 次批量请求；换源前是 23 次 Yahoo + 1 次东财）；
- 同一轮里同一个 URL 只抓一次（海外 RSS 由 `OVERSEAS_FEED_SPECS` 统一抓取后由两条链路共享）；
- 东方财富 `clist` 接口的 `pz` 上限是 100，无法用大分页合并（`total` 约 496 个板块）；
- **行情类请求会自动走 `readCachedQuote` 缓存**（见下）。**新闻按来源缓存 5 分钟，失败最多回退原始时间起 30 分钟，并进行失败退避。**

### 新闻源：只写进代码前先测可达性

`OVERSEAS_FEED_SPECS` 里每个 URL 都是实测过的。**别照抄文档加源**——本项目就吃过这个亏：
名单里挂着 Reuters / Bloomberg / FT / AP / NYT，页面上写着「海外主流媒体」，
实际**这四家在这个网络环境下一条都取不到**，只有 CNBC 与 WSJ 在供数。

- 可达：CNBC（5 个主题 feed）、WSJ（markets/world/opinion/US Business）、MarketWatch ×3、Nasdaq ×2、Fortune、Seeking Alpha（含 6 支中概股公司 feed）、Rhodium Group、新浪 7x24、华尔街见闻。
- 不可达：Yahoo 全线（地区封锁 403）、Google News（超时）、Bloomberg / FT / Reuters / BBC / Guardian / NYT / AP / CNN / Nikkei / SCMP / DW / Economist 等。
- 完整清单与失败方式见 [`NEWS-SOURCES.md`](./NEWS-SOURCES.md)。

**另一个容易忽略的坑：扩样本量 ≠ 提高参考性。** 实测发现旧情绪词典让 85% 的事件落到「中性」，
中性的新闻对信息分没有任何贡献，所以**即使把源扩到十几家，信息分依然恒等于 50**。
修完方向判定后，A 股 31 个行业里有 29 个的信息分不再等于 50。改 `POSITIVE` / `NEGATIVE` 前先看 `NEWS-SOURCES.md`。

### 历史行情（60 日走势 + 量能与市场宽度）

详情页的两个模块都靠 `fetchHistoryFromProviders`。**东方财富的 K 线接口在这个网络环境下完全不可用**
（`push2his` 及其分片主机 socket 直接断；`push2delay` 的 kline 接口 6 种参数组合一律返回 `klines=0`），
所以历史数据走下面三条**实测可达**的链路：

| 标的 | 来源 | 说明 |
| --- | --- | --- |
| A 股 31 个行业 | **同花顺行业板块日线** | 同花顺行业分类到二级（90 个板块），一个申万一级行业对应多个板块。按**等权聚合**成一条代理序列，映射表见 `CN_SECTOR_THS_BOARDS` |
| 国内指数 6 个 | 新浪 A 股指数日线 | 腾讯 `web.ifzq.gtimg.cn` 作冗余 |
| 美股 11 个行业 | 新浪美股日线 | 直接用 ETF 代码（XLK…），近 20 年日线含成交量 |
| 美股 5 个指数 | 新浪美股日线 | 标普500 用 `.INX`，纳指 `.IXIC`、道指 `.DJI`、纳指100 `.NDX`；罗素2000 用 `IWM` 代理 |
| **海外指数 6 个** | **同花顺全球指数日线（`88_*` / `hk_*`）** | 日经225 / KOSPI / 台湾加权 / DAX / 富时100 / 恒生，见下节 |

**行业代理序列的构造方式（不是原始点位，必须知道）**：

- 涨跌幅取各子板块**等权平均**；点位从 1000 起按平均涨跌幅**复利复合**（各板块绝对点位口径不一，不能相加）
- 成交量取各子板块**求和**
- 宽度取**当日上涨子板块占比** —— 这是真实宽度，不是估算值，所以「市场宽度」模块才有数据

**两个容易踩的坑**：

1. **沙箱连不上腾讯，但能连新浪。** 线上实测：只配腾讯的指数页全部拿不到数据，而走新浪的（美股行业、标普500）正常。
   所以新浪排在腾讯前面，腾讯只作为冗余。**判断数据源可用性时，本机结论不能直接套到线上。**
2. **成交量单位不一致。** 新浪 A 股给的是「股」，腾讯给的是「手」（1 手 = 100 股），差 100 倍。
   `parseSinaCnSeries` 统一换算成手，否则同一指数换源后量柱量级会跳变。

#### 海外指数的历史源（同花顺「市场前缀」体系）

同花顺的行情节点用 **`市场_代码`** 命名，实测确认了三段：

| 前缀 | 含义 | 例子 |
| --- | --- | --- |
| `bk_` | A 股行业板块 | `bk_881155`（半导体） |
| `hk_` | 港股指数 | `hk_HSI`（恒生指数）、`hk_HSCEI` |
| **`88_`** | **全球指数** | `88_N225`、`88_KS11`、`88_TWII`、`88_GDAXI`、`88_FTSE`、`88_SPX` |

映射表是 `THS_INDEX_CODES`，**代码不是猜的**：先穷举 1–99 各市场段 × 指数名变体，再把候选与东财实时值逐位比对
（如 `88_N225` 末根收盘 64011.34 = 日经 225 实时值）。给的是**指数本身**的日线，不是 ETF 代理。

**两条必须保留的细节**：

1. **`last.js` 的分片更新进度不一致，必须取多份选最新。** 同花顺对每个代码给 `/00/ /01/ /02/` 三份：
   实测 `hk_HSI` 的 `/00/`、`/01/` 停在 2026-04-21（滞后五个月），只有 `/02/` 到最新交易日；
   而**线上沙箱**又观察到 `/02/` 拿到旧窗口（边缘节点同步不同步，同一份代码先拿到 06-18~09-11、
   十几分钟后再拿就变成 01-20~04-21）。所以 `fetchThsIndexHistory` 同时取 `/01/` 与 `/02/`，
   交给 `freshestSeries` 选末条日期更新的那份。**只取单一分片会让 K 线静默回退到几个月前。**
   注意 A 股板块 `bk_*` 的三个分片实测一致，仍只取 `01`，不必翻倍请求。
2. **同花顺对部分海外指数不提供成交量，字段用常量 `1` 占位。**
   实测：`88_N225` / `88_KS11` / `88_TWII` / `88_GDAXI` / `88_FTSE` 的量恒为 1，而 `88_SPX`、`hk_HSI` 是真实量。
   `normalizeThsIndexVolume` 把这种常量占位当成「无成交量」置 0，否则量能图会画出一排等高柱（纵轴 0~1，没有任何信息量）。

#### 纵轴刻度宽度按最宽标签动态计算

指数级别的点位是 8 个字符（`26029.46`）。原来固定 48px 的纵轴会把首位裁掉，
页面上显示成 `6029.46`——看起来像"数值算错"，实际是标签被裁。
现在用 `axisWidthFor()`（纯函数估算，SSR 与客户端一致）按最宽刻度留宽。
**判断"数据错"之前先看坐标轴有没有裁字。**

覆盖情况：**海外 11 个指数的历史行情全部可用**。
**欧元50 已移除**——东财只有它的实时行情、没有 K 线；同花顺全球指数段（试遍 1–99 市场号 × 40 余种代码拼法）、
腾讯、新浪、WSCN、stooq、CNBC 全部拿不到它的历史日线。与其保留一个「走势图永远显示数据不足」的页面，
不如不展示该指数；指数定义与 `100.*` secid 映射同时删除，并有单测锁住不再引入。
罗素2000 仍用 `IWM` ETF 代理（东财 `m:100` 全表 63 项里确实没有该指数）。

另外，同花顺对 `88_N225`/`88_KS11`/`88_TWII`/`88_GDAXI`/`88_FTSE` 不提供成交量，
这 5 个指数的「量能与市场宽度」卡片会显示"该原始指数数据源不提供可核验成交量"，
而不是画一排等高的假量柱（恒生与标普500 有真实量）。

### 行情缓存与上游不可用时的降级

**Yahoo 在自己的边缘对来自中国大陆的请求返回 403 + HTML 页面**（`lang="zh"`，正文写明 *“As of November 1st, 2021 Yahoo's suite of services will no longer be accessible from mainland China.”*）。实测与请求频率无关：换 UA、换路径、连首页都是同一个 3125 字节的 403 页。因此**加缓存、降并发都不能修复它**，要恢复美股与海外指数只能换数据源。

缓存层的价值在于其余上游（东方财富、CNBC、WSJ）的抖动：一旦某轮抓取失败，会导致整轮美股 11 行业与 11 个海外指数同时降级。

而日线在休市期间不会变化，所以缓存策略按「**该市场自己是否在交易时段**」决定复用窗口，而不是用统一的全局 TTL：

| 情形 | 复用窗口 |
| --- | --- |
| 该市场在交易时段内 | 3 分钟 |
| 该市场休市（含周末与节假日） | 6 小时 |
| 网络抓取失败 | 最多回退 24 小时内的副本，并标记为降级 |

覆盖市场：CN / US / HK / JP / KR / TW / DE / UK（各自时区与时段）。

存储分两层：**isolate 内存 → Cache API**（同数据中心跨 isolate 复用，不保证跨数据中心共享）。Cache API 在本地 Node 预览环境不存在，此时静默退化为纯内存缓存。

抓取失败时回退的副本会被如实标注：行的 `delayLevel` 置为 `STALE`、`source` 追加“（上游不可用期间复用缓存副本）”，并且 `makeFreshness` 会把整组披露为 `STALE`，不会把旧数据当近实时行情展示。

### 节假日日历

`marketPhase` 与缓存时段判断都会识别官方休市日：

- **A 股**：上交所《关于上海证券交易所 2026 年部分节假日休市安排的通知》（上证公告〔2025〕45 号）。数据按公告原文的**休市区间**录入，便于逐条核对。**2027 年安排尚未公布**，未命中日历的日期会退化为"只判断周末"。
- **美股**：NYSE 官方 Holidays & Trading Hours，2026 与 2027 均已覆盖，另含提前收盘日（13:00 ET 收市，如感恩节次日、平安夜）。
- **新增覆盖**：港、韩、台、英 2026 年；日、德 2026–2027 年。来源和限制见 [MARKET-CALENDAR.md](./MARKET-CALENDAR.md)。未覆盖年份会明确披露，并跳过预测留档。

`test/market.test.ts` 会用**公告原文标注的星期**反向校验日历录入，抄错日期会被测出来。新增年份时请照此补测试。

---

## 有意为之的技术决策

以下几处看起来"不常规"，但都是有意的，改动前请先确认：

1. **不用 `next/link`，一律用原生 `<a>`。** 本项目的产物是 `force-dynamic` 页面，每次导航都要触发服务端重新取数；原生 `<a>` 的全页加载行为比客户端路由更可预期。`test/market.test.ts` 会断言组件里不出现 `next/link`，`.oxlintrc.json` 里也相应关闭了 `nextjs/no-html-link-for-pages`。
2. **`next` 并未安装。** 框架是 `vinext`（Vite + React 19 RSC + Cloudflare Workers），`next`、`next/navigation`、`next/font` 等都由 vinext 的 shim 提供，类型来自 `vinext/types`。
3. **`app/mcp/route.ts` 与 `app/api/mcp/route.ts` 是同一份 handler 的两个入口**，后者只是 re-export，便于不同 MCP 客户端配置路径。
4. **`/api/market` 与 `/api/sectors/:code` 目前没有前端调用方**，页面数据走 Server Component props。保留它们是为了给外部集成（含 MCP 之外的自动化）留出稳定接口。
5. **`spread` 与 `for...of` 的选择**：`lib/market.ts` 的 `hash()` 用 `for...of` 而非 `[...str]`，两者对码位语义等价，前者不触发 `no-misused-spread`。

---

## MCP 服务

`/mcp`（或 `/api/mcp`）暴露 5 个**只读**工具，全部标注 `readOnlyHint: true`，不含任何买卖/目标价字段：

| 工具 | 用途 |
| --- | --- |
| `get_market_overview` | A 股 / 美股 / 指数的信息面概览 |
| `get_sector_analysis` | 按代码读行业结论与证据链 |
| `get_index_analysis` | 按代码读指数结论 |
| `get_evidence_feed` | 新闻、财报、公告证据流 |
| `get_data_freshness` | 各市场行情时间、延迟等级、提供者健康度 |

鉴权：`Authorization: Bearer <MCP_API_KEY>`，或 `x-mcp-api-key: <key>`。密钥比较使用常量时间实现。

---

## 测试约定

- 用 Node 内置 `node:test`，没有额外测试框架。
- `test/market.test.ts` 里有**行为测试**（直接调用 `buildSector` / `nextSessionSignalFromScore` 等纯函数，锁定盘面因子与展望口径）。**新增功能优先补行为测试。**
- 也有一部分是"源码断言"测试（`readFileSync` + 正则），用于锁定产品红线（不出现 `buy|sell|target_price`、不出现模拟数据回退、不引入 `next/link`）。这类断言应保持在**红线级别**，不要用来替代行为测试。

---

## 已知待办

- ~~**图表层 111 KB(gzip) 占比偏高**~~ **已解决**：换成自绘 SVG，图表代码从 111.3 KB 降到 3.8 KB gzip，并顺带拿到了服务端直出与 CSS 入场动画。见上文「图表：自绘 SVG」。剩下的图表相关待办只有一个：环形图的入场动画是缩放淡入，不是 recharts 的"扇形扫开"。
- **A 股 2027 年休市安排**：待上交所公布后补录 `CN_MARKET_CLOSURES`。
- **`outputs/` 里的历史发布包**（`site-*.tgz`，约 22.8 MB）未清理。

## 2026-09-16 接管基线

当前模型为 `provider-split-direction-share-v10`；覆盖 A 股 31 行业、美股 11 行业、国内 6 指数及海外 11 指数（共 17）。历史发布记录不代表当前线上健康；后续验收和优化见 `OPTIMIZATION.md`。

## 持久化评估与本地预览

构建后运行 `npm run preview:persistent`，同时启动 Node 预览和五分钟轮询任务。默认持久保存到 `.data/analyst.sqlite`，不纳入 Git。`/evaluation` 展示实际留档评估；首次运行无样本时如实显示空状态。

部署仍沿用现有 Node 托管入口；持续任务可用 `npm run forecast:watch`，需设置 `FORECAST_SITE_URL`、独立 `FORECAST_JOB_KEY` 和持久数据库（D1 或挂载持久卷的 `ANALYST_SQLITE_PATH`）。未配置数据库时评估 API 返回 503，不使用内存冒充持久留档。本次未发布或修改线上定时任务。
