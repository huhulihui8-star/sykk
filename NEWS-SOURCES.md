# 新闻源扩容与「参考性」改善方案

> 起因：用户反馈「新闻的数据来源可以扩大，现在感觉样本太少，预测参考性不大」。
> 这份文档记录**实测数据、根因、已落地的改动与仍然缺的部分**。
> 所有"可达/不可达"结论都来自本机与线上沙箱的真实请求，不是照抄文档。

---

## 一、症状拆成三层

用户看到的是"参考性不大"，但拆开来是三个独立问题，而且**第三个才是主因**：

| 层 | 问题 | 实测证据 |
| --- | --- | --- |
| ① 数量 | 样本条数少 | 改前：A 股信息池 28 条（海外 8 + 国内 20） |
| ② 来源 | 名字上写着五家媒体，实际只有两家在供数 | 74 条事件里 Reuters / Bloomberg / FT / AP / NYT 各 **0 条**，只有 WSJ 24 + CNBC 19 |
| ③ **方向** | **85% 的样本不携带方向，导致信息分几乎恒等于 50** | 83 条里 **71 条被判「中性」**；`rise` 用子串匹配会命中 `surprise` |

③ 最致命：**只扩充条数而不修方向判定，样本再多也等于 0**。这条是本次排查中最重要的发现。

---

## 二、实测可达性清单（2026-09，本机 / 线上沙箱同构）

### ✅ 可用

| 来源 | 入口 | 结果 |
| --- | --- | --- |
| 东方财富 板块/指数/美股 | `push2delay.eastmoney.com` | 200 |
| 东财 资讯栏目 350/351 | `np-listapi.eastmoney.com` | 200 |
| 东财 上市公司公告 | `np-anotice-stock.eastmoney.com` | 200 |
| 东财 **机构研报** | `reportapi.eastmoney.com/report/list`（需 `beginTime`/`endTime`） | 200 |
| CNBC（5 个主题 feed） | `cnbc.com/id/{100003114,10000664,19854910,20910258,15839135}` | 200 |
| WSJ | `feeds.content.dowjones.io/public/rss/{RSSMarketsMain,RSSWorldNews,RSSOpinion,WSJcomUSBusiness}` | 200 |
| MarketWatch | 同域 `mw_topstories` / `mw_marketpulse` / `mw_realtimeheadlines` | 200 |
| Nasdaq | `nasdaq.com/feed/rssoutbound?category={Markets,International}`，也可用 `?symbol=<ticker>` | 200 |
| Fortune / Seeking Alpha | `fortune.com/feed/`、`seekingalpha.com/market_currents.xml` | 200 |
| **Seeking Alpha 公司 feed** | `seekingalpha.com/api/sa/combined/<TICKER>.xml`（每支 30 条） | 200 |
| **Rhodium Group** | `rhg.com/feed/` — 美国专门研究中国经济的机构 | 200 |
| 新浪财经 7x24 | `zhibo.sina.com.cn/api/zhibo/feed` | 200 |
| 华尔街见闻 全球快讯 | `api-one.wallstcn.com/apiv1/content/lives` | 200 |
| SEC EDGAR | `sec.gov/cgi-bin/browse-edgar` | 200 |

**踩过的坑**：`feeds.a.dj.com` 那批 WSJ 旧 feed 虽然返回 200，但内容停在 **2025-01**，
是死数据；同名的 `feeds.content.dowjones.io` 才是活的。**只测状态码不够，还要看 pubDate。**

### ❌ 不可用（已从代码中移除，避免"看起来有源其实取不到"）

| 来源 | 失败方式 |
| --- | --- |
| **Yahoo Finance 全线** | **403 + 中文地区封锁页**（"no longer be accessible from mainland China"，2021-11-01 起） |
| **Google News RSS** | 连接超时（改前 9 个查询全部超时，白占请求还拖慢构建十几秒） |
| Bloomberg / FT | 连接超时 |
| Reuters（agency feed、ARC、旧 feed 三种入口都试了） | 超时 / 404 |
| BBC、Guardian、DW、Business Insider、CNN | ECONNRESET / 超时 |
| NYT、Economist、Al Jazeera、CNA、Nikkei、SCMP、ZeroHedge | 连接超时 |
| AP News、Fox Business、Investing.com | 403 |
| **智库/研究机构**：PIIE、IMF Blog、OECD、Bruegel | 403 |
| **智库/研究机构**：Brookings、CSIS、Chatham House、Asia Society、MERICS、The Diplomat、Asia Times | 连接超时 |
| 联合早报（RSS 路径已下线）、Jing Daily | 返回 HTML 页 / 404 |
| RSSHub 公共实例 | ECONNRESET |
| 雪球 kline | 400（需要有效 cookie） |
| 财联社电报 | 404（接口路径已变） |
| `feeds.a.dj.com` 的 WSJ 旧 feed | 200 但内容停在 2025-01（**死数据**） |

---

## 三、已落地的改动

### 1. 换数据源（顺手把 Yahoo 的 23 个请求全部拿掉）

- 美股 11 行业 ETF → 东财 `107.XLK…XLC`，**11/11 可用**，含价、涨跌幅、5 日涨跌幅（`f109`）、量比（`f10`）、成交量。
- 海外指数 → 东财 `100.*`，**11/11 可用**（欧元50 因无任何可用历史源已移除）。其中罗素2000 东财没有该指数，改用 `107.IWM`（ETF 代理）并如实披露。
- 全部合并进**一次批量请求**（`ulist.np`，27 个 secid 一次取回）。
- 顺带修掉一个一直在虚报的指标：原来美股指数的"涨跌家数"是用 ETF 自身涨跌方向伪造的（`change>0 ? 1 : 0`），等于把 `returnScore` 重复计入 `breadthScore`。现在指数/ETF 的广度项直接按中性处理。

### 2. 新闻源扩容

- **移除**：9 个 Google News 查询（死）、Bloomberg、FT（死）。
- **新增**：CNBC ×4、WSJ Opinion、MarketWatch ×3、Nasdaq ×2（国际版）、Fortune、Seeking Alpha。
- **新增中文快讯**：新浪 7x24、华尔街见闻全球快讯。
- **新增机构研报**：东财研报（行业评级、评级变动、机构名）。这是最接近"下一交易日预期"的样本，但**属于观点而非事实**，打分权重给 0.8（低于新闻的 1.0，公告类 1.35）。

### 2b. 「海外看中国」专项扩容（第二轮）

这一池原来是全链路最薄的一环（周末只剩 13 条 / 2 家媒体），做法是三管齐下：

**(1) 找中国专项入口。** 逐个试了 20 个直连入口，只有这几个真的能用：

| 新增入口 | 为什么选它 |
| --- | --- |
| `WSJcomUSBusiness` | WSJ 商业版，实测 85 条且当天更新，是补量主力 |
| **Rhodium Group** `rhg.com/feed/` | 美国专门研究中国经济的机构，正对方法论里的「经济学家及机构分析」 |
| **Seeking Alpha 公司 feed** `api/sa/combined/{BABA,PDD,JD,BIDU,NIO,TCOM}.xml` | 海外分析师对中国公司的公开分析，每支 30 条，是池子里最贴近行业映射的一块 |

**(2) 让「只写公司名」的稿子也能进来。** 中国企业名（Alibaba/PDD/BYD/Huawei…）单独作为一类标记：
针对中国公司的分析**本身就是「海外对中国产业的分析」**，而中概股 feed 里标题几乎不写 "China"。

**(3) 把判定从"只看标题"改成"标题 + 摘要"。** 很多稿子标题不提中国、正文才提，只匹配标题会大量漏掉。

**(4) 同时加了一道地缘政治闸门。** 放宽主体识别后立刻发现副作用：混进了
「Satellite Imagery Linked to Iranian Strike」「On Okinawa, U.S. Bases…」「Greetings From President Xi」这类时政/军事稿。
**危害不只是主题不纯**——这类稿子的行业归属会落到「全部行业」，等于**一条军事新闻污染 31 个行业的分数**。
所以判定改成三个条件缺一不可：**有中国主体 + 无地缘政治词 + （点名中国公司 或 有经济产业词）**。
`test/market.test.ts` 里有专门的用例锁死这两侧（该排除的排除、该保留的保留）。

**顺带修的延迟问题**：新闻源没有缓存，所以**单个 feed 卡住会把整个快照拖到超时上限**（观察到 15s）。
把海外 RSS 的超时从 15s 压到 **6s**——实测所有健康 feed 都在 5s 内返回，这个上限就是最坏延迟。

### 3. 修方向判定（这是参考性提升的主因）

- 词表从 26 + 25 扩到 **约 80 + 100**（中英双语，覆盖 rise/slide/plunge/misses/shrinks/dents/inject…）。
- 英文词改为**词边界匹配**（`matchesTerm`，带正则缓存）：旧实现用 `includes`，`rise` 命中 `surprise`、`miss` 命中 `dismissed`，方向直接被带偏。

### 4. 结构约束（让"样本少"不再伪装成"有结论"）

| 机制 | 作用 |
| --- | --- |
| `diversifyBySource` | 打分时单来源最多 3 条，防止"谁发得多谁说了算" |
| `evidenceConfidence` | 置信度 = 条数与来源数各半；信息分按它向中性 50 收缩 |
| `weightedChinaEvidenceScore` | 某池为空时把权重按比例还给另一池，不再让 60% 变成恒定的 50 |
| `capPerSource` | 展示列表单来源最多 10 条，避免列表被单一媒体刷满 |

> 最后一条修的是一个**一直存在的结构性缺陷**：海外池对某行业为空时，60% 权重变成常数 50，
> 等于把整条信号稀释一半——表现就是"海外 0 条、国内 19 条"的行业信息分被钉死在 50。

---

## 四、效果（同一天、同一环境实测）

| 指标 | 改前 | 改后 |
| --- | --- | --- |
| 单次快照出站请求 | 47 | **38**（含第二轮中国专项 feed） |
| 快照构建耗时 | 十几秒（等 Google 超时） | **3.4s**（偶发慢源最多 8s） |
| 美股行业有行情 | 0 / 11 | **11 / 11** |
| 海外指数有行情 | 0 / 12 | **12 / 12** |
| dataStatus | STALE | **LIVE_PROXY** |
| A 股信息池条数 | 28 | **146** |
| 国内池来源数 | ~17 | **60** |
| **海外看中国池** | **8 条 / 2 家** | **80 条 / 4 家**（展示列表 35 条） |
| **有海外证据的 A 股行业** | 少数几个 | **31 / 31** |
| **有效方向样本（正+负）** | **12** | **36** |
| 判为「中性」的比例 | 85% | **57%** |
| A 股信息分分布 | 大面积恒等于 50 | 43.5~56.5，29/31 个行业不再等于 50 |

---

## 五、仍然缺的（诚实列出）

1. **海外看中国池在周末很薄**（13 条 / 2 家）。工作日 CNBC、WSJ 的中国经济报道会显著更多。但它确实是全链路最薄的一环。
2. **Reuters / Bloomberg / FT 在这个网络环境下无解**。它们是"海外看中国"最主力的来源，现在完全拿不到——不是代码问题，是网络可达性问题，翻墙也不是可靠方案（Yahoo/部分站点还会拦数据中心 IP）。
3. **情绪判定仍是关键词计数，不是情感模型**。已经比之前准得多，但会出现误判，例如"刺激政策"这类标题偶尔会被算成负向。它只用于排序与打分，**不作为结论展示**。
4. **A 股板块的日线历史仍不可用**。东财 `push2his` 各分片主机 socket 直接断，`push2delay` 的 kline 一律返回 `klines=0`；腾讯/新浪都不支持东财板块代码。已确认可用的是：腾讯能取 **国内指数**（`sh000001`/`sh000300`/`sz399006` 各 60 条）与 **`us.DJI`/`hkHSI`**，但对美股 ETF（`usXLK`）只返回 1 条。详情页 60 日走势图因此仍显示"数据不足"。
5. **新闻源没有任何缓存**，每轮构建都要实打实打一遍上游。行情侧已有 `readCachedQuote`，新闻侧没有——若要继续加源，建议先补这一层。

---

## 六、后续可做（按性价比排序）

1. **新闻源健康巡检**：定期跑一遍可达性检查，把"哪些源今天取不到数"输出成报告。这次的教训就是**源被封了几个月都没人发现**，因为没人核对过"名字在名单里"和"真在供数"的区别。
2. **给新闻源加缓存**（参考行情侧的 `readCachedQuote`），把 30 个请求再压下来，同时提高抗抖动能力。
3. **板块历史用指数代理**：A 股行业可以映射到中证/申万行业指数，用腾讯日线取历史。缺点是指数与板块并非同一口径，需要产品确认是否接受。
4. **情绪判定引入评级与结构化信号**：机构研报自带 `emRatingName` / `ratingChange`，比关键词判定可靠；可以把它作为"事实性证据"单独加权。
5. **海外池在公司层面补齐**：CNBC / MarketWatch 对中国公司（BYD、Alibaba、Tencent…）的报道量不小，可以扩展 `isChinaEconomicAnalysisTitle` 的公司名识别。
