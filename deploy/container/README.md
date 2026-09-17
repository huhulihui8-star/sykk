# 独立国内云平台部署准备

本配置不使用原 HiFi 服务器或 ChatGPT Sites。需要连接新云账号后才能创建服务、持久存储及公开地址。

构建：docker build -f deploy/container/Dockerfile -t strongest-analyst .

容器端口 3000（可用 PORT 覆盖），部署实例须配置独立随机密钥 MCP_API_KEY 和 FORECAST_JOB_KEY、公开网址 NEXT_PUBLIC_SITE_URL，并挂载持久存储到 /data。预测任务调用实例自身本地地址，不依赖外部站点。

Node 服务与五分钟调度同时运行；SQLite 保存留档。须采用持续运行的单实例并挂载持久卷，不能以临时容器文件系统或会休眠的按请求实例冒充持久化及固定时点调度。

尚未创建其他云服务或公网地址；仅完成便携部署准备。
