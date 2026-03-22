# device-event-logger

记录用户设备事件的 API 端点，支持通过 MCP 查询。

## 部署

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Tosd0/device-event-logger)

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/template/TEMPLATE_ID)

### Render

点击上方按钮即可。Render 会通过 `render.yaml` 自动创建 PostgreSQL 数据库并配置所有环境变量。数据库表会在首次请求时自动创建。

### Railway

1. 将此仓库推送到 GitHub（需包含 `package.json`）
2. 前往 [railway.com/button](https://railway.com/button)，从 `Tosd0/device-event-logger` 创建模板
3. 添加 **Web Service** + **PostgreSQL** 插件
4. 设置变量：
   - `DATABASE_URL` -> `${{Postgres.DATABASE_URL}}`
   - `API_KEY` -> 你的密钥
   - `TZ_OFFSET` -> `480`（默认值，UTC 偏移分钟数）
5. 发布模板后，将上方徽章 URL 中的 `TEMPLATE_ID` 替换为实际 ID

## 环境变量

| 变量 | 说明 | 必填 |
|------|------|------|
| `DATABASE_URL` | PostgreSQL 连接字符串 | 是 |
| `API_KEY` | `/events` 端点的认证密钥 | 是 |
| `TZ_OFFSET` | 与 UTC 的时区偏移（分钟，默认 `480`） | 否 |
| `PORT` | 服务端口（默认 `8000`） | 否 |
