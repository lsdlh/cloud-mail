import app from '../hono/hono';
import result from '../model/result';
import externalService from '../service/external-service';

/**
 * 外部发信 API
 *
 * 鉴权：走 /public 前缀鉴权（见 security.js），请求头 Authorization 需为：
 *   - 系统的 public token（管理员通过 /api/public/genToken 生成），或
 *   - 部署时配置的 jwt_secret（作为稳定的内部 API master key）
 *
 * 示例：
 *   POST /api/public/sendEmail
 *   Authorization: <jwt_secret 或 public token>
 *   Content-Type: application/json
 *   {
 *     "from": "noreply@yourdomain.com",
 *     "fromName": "Your App",
 *     "to": ["someone@example.com"],
 *     "subject": "Hello",
 *     "text": "纯文本内容",
 *     "html": "<p>HTML 内容</p>"
 *   }
 */
app.post('/public/sendEmail', async (c) => {
	const data = await externalService.sendEmail(c, await c.req.json());
	return c.json(result.ok(data));
});
