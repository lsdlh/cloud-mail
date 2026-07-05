# 外部发信 API 说明

本文档说明新增的「外部发信 API」，它允许外部系统通过内部密钥调用，以系统已配置域名下的**任意邮箱**作为发送方发信，且发送记录在系统与 Cloudflare 侧均可见。

> 本功能为**纯新增**，不改动任何现有发信/鉴权逻辑，对线上现有功能零影响；无需新增任何环境变量，随 GitHub Action 无缝部署。

## 一、接口

```
POST /api/public/sendEmail
```

### 鉴权

请求头 `Authorization` 需为以下任一（二选一）：

| 密钥 | 来源 | 特点 |
|------|------|------|
| `jwt_secret` | 部署时设置的环境变量（GitHub Secrets: `JWT_SECRET`） | **推荐**，固定不变，适合外部系统长期配置 |
| public token | 管理员调用 `POST /api/public/genToken`（邮箱+密码）生成，存于 KV | 会随重新生成而失效 |

> 鉴权在 `security.js` 的 `/public` 分支完成：原有 public token 校验行为**完全不变**，仅额外接受 `jwt_secret` 作为稳定 master key。

### 请求体（JSON）

| 字段 | 必填 | 说明 |
|------|------|------|
| `from` | 是 | 发送方邮箱，域名必须是系统 `domain` 中配置的域名，前缀任意（如 `noreply@yourdomain.com`） |
| `fromName` | 否 | 发送方显示名，缺省取 `from` 的前缀 |
| `to` | 是 | 收件人，字符串（逗号分隔）或字符串数组 |
| `subject` | 是 | 邮件标题 |
| `text` | 否 | 纯文本内容（`text` / `html` 至少一个） |
| `html` | 否 | HTML 内容 |
| `attachments` | 否 | 附件数组，元素 `{ filename, content(base64), type(mimeType) }`，最多 10 个，需配置 R2 |

### 返回

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "emailId": 123,
    "messageId": "…",
    "channel": "cloudflare | resend | internal",
    "status": "delivered | sent",
    "from": "noreply@yourdomain.com",
    "to": ["someone@example.com"],
    "createTime": "2026-07-06 12:00:00"
  }
}
```

## 二、调用示例

```bash
curl -X POST https://your-domain.com/api/public/sendEmail \
  -H "Authorization: <你的 jwt_secret>" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "noreply@yourdomain.com",
    "fromName": "My App",
    "to": ["someone@example.com"],
    "subject": "Hello from API",
    "html": "<p>这是通过外部 API 发送的邮件</p>"
  }'
```

## 三、发送机制与「Cloudflare 可见性」

发送时按现有系统一致的优先级选择通道，并在多个层面留下可见记录：

1. **投递通道**
   - 若部署配置了 Cloudflare Email Routing（`CF_EMAIL=true`，`[[send_email]] name="email"`），走 `c.env.email.send()`，在 **Cloudflare Email Routing 后台可见发送活动**；
   - 否则使用 `from` 域名对应的 **Resend** token 发送，在 **Resend 后台可见**，且 Resend Webhook 会回写投递状态（delivered / bounced / …）到本系统；
   - 若收件人全部为站内邮箱，直接写入收件人收件箱（站内投递）。
2. **Worker 日志**：`wrangler.toml` 已开启 `[observability] enabled = true`，每次 API 调用在 **Cloudflare Workers 的 Logs / Analytics 可见**。
3. **系统数据库**：发送记录写入 `email` 表（`type=SEND`），在前端「全部邮件 / 已发送」**可见**。
4. **数据分析**：累计每日发送统计，分析图表同样体现。

## 四、重要边界（诚实说明）

- **发送方并非「无限任意」**：邮件能否真正投递受发信服务商域名验证约束。技术上可行的「任意」= **系统已配置且已在发信服务商（Cloudflare/Resend）验证过的域名**下的任意前缀邮箱。使用未验证域名会被拒收或进垃圾箱。
- **Cloudflare Email Routing 的 `send_email` binding 对收件人有限制**：收件人地址通常需是已验证的目标地址（destination address）。若要向任意外部收件人发信，请配置 **Resend**（对收件人无此限制，仅要求发送方域名已验证）。
- 附件功能依赖 **R2 对象存储**；未配置 R2 时请勿传 `attachments`。

## 五、涉及文件

| 文件 | 变更 |
|------|------|
| `src/service/external-service.js` | 新增，外部发信核心逻辑（复用 email-service 底层发送方法） |
| `src/api/external-api.js` | 新增，`POST /public/sendEmail` 路由 |
| `src/hono/webs.js` | 注册 `external-api`（+1 行 import） |
| `src/security/security.js` | `/public` 鉴权额外接受 `jwt_secret`（向后兼容） |
| `src/i18n/zh.js` / `src/i18n/en.js` | 新增 5 条校验提示词条 |
