# GitHub Pages 定时版

仓库 huhulihui8-star/sykk；目标网址 https://huhulihui8-star.github.io/sykk/ 。此地址只有在 Pages 部署完成后可用。

GitHub Actions 每小时第 7、37 分钟抓取公开真实行情及新闻，构建看板、59 个详情页、历史图表和评估页。任务可能延迟或遗漏，以页面证据时间和 generation.json 为准。没有行情仍显示数据不足；客户端超过 24 小时清除旧展望。网页不依赖 ChatGPT 或旧服务器，不提供服务端 API/MCP。源码中保留后端能力供自行托管。

Settings → Pages → Source 选择 GitHub Actions。公开访问是否稳定应实际验证，不能保证国内所有网络均可访问。

预测留档只在核实过的收盘后窗口执行，迟到不补写；SQLite 保存在 analyst-state 分支，含公开行情、新闻和评估记录，不含密钥。每次恢复后非强制提交更新。任务密钥仅在生成时随机创建。

本地：npm ci；node scripts/build-pages.mjs；npm run pages:export。输出 out/，不要提交到 main。

## v11 评分替换

新闻时间半衰期 24 小时，7 天后排除，未来和未知时间排除。标题/规范化文章 URL 去重，近似标题仅在数字一致且相似度达到 0.95 时合并，保持最早发布时刻；冲突报道中性。新闻方向按时间与来源权重归一化，证据少时几何平均置信度收缩至 50。该参数是可解释规则，未经命中率训练；validationStatus=UNVALIDATED，百分比仍是信号占比。保持 65/35、海外国内 60/40 和方向阈值 52，未引入新输出状态。旧 v10 快照不能作为 v11 结果复用，历史预测记录不修改。
