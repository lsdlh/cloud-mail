import orm from '../entity/orm';
import email from '../entity/email';
import { emailConst, settingConst } from '../const/entity-const';
import BizError from '../error/biz-error';
import verifyUtils from '../utils/verify-utils';
import emailUtils from '../utils/email-utils';
import settingService from './setting-service';
import accountService from './account-service';
import userService from './user-service';
import emailService from './email-service';
import attService from './att-service';
import kvConst from '../const/kv-const';
import dayjs from 'dayjs';
import { t } from '../i18n/i18n';

/**
 * 外部发信服务
 *
 * 提供给外部系统通过内部密钥调用的发信能力，支持以「系统已配置域名下的任意邮箱」作为发送方，
 * 发送后会：
 *   1. 通过 Cloudflare Email Routing (send_email binding) 或 Resend 真实投递（Cloudflare 后台/日志可见）
 *   2. 落库到 email 表（type=SEND），使系统「全部邮件 / 已发送」可见
 *   3. 若收件人为站内邮箱，复用站内投递逻辑写入收件人收件箱
 *   4. 累计每日发送统计，数据分析图表同样可见
 *
 * 复用 email-service 的底层纯发送方法（sendByCloudflareEmail / sendByResend），不改动用户级发信逻辑。
 */
const externalService = {

	// 把 c.env.domain 归一化成字符串数组（部署时可能是 JSON 字符串或数组）
	resolveDomainList(c) {
		let domainEnv = c.env.domain;
		if (typeof domainEnv === 'string') {
			try {
				domainEnv = JSON.parse(domainEnv);
			} catch (e) {
				domainEnv = [domainEnv];
			}
		}
		return Array.isArray(domainEnv) ? domainEnv : [];
	},

	// 归一化收件人为数组
	normalizeRecipients(to) {
		if (typeof to === 'string') {
			return to.split(',').map(item => item.trim()).filter(Boolean);
		}
		if (Array.isArray(to)) {
			return to.map(item => (item || '').toString().trim()).filter(Boolean);
		}
		return [];
	},

	async sendEmail(c, params) {

		let {
			from,        // 发送方邮箱（必填，域名须为系统已配置域名）
			fromName,    // 发送方显示名（可选）
			to,          // 收件人，字符串或数组（必填）
			subject,     // 邮件标题（必填）
			text,        // 纯文本内容
			html,        // HTML 内容（text / html 至少一个）
			attachments  // 附件数组 [{ filename, content(base64), type(mimeType) }]（可选，需配置 R2）
		} = params || {};

		attachments = Array.isArray(attachments) ? attachments : [];

		// ---------- 参数校验 ----------
		if (!from || !verifyUtils.isEmail(from)) {
			throw new BizError(t('externalFromInvalid'), 400);
		}

		const fromDomain = emailUtils.getDomain(from);
		const domainList = this.resolveDomainList(c);

		if (!domainList.includes(fromDomain)) {
			throw new BizError(t('externalFromDomainInvalid'), 400);
		}

		const receiveEmail = this.normalizeRecipients(to);

		if (receiveEmail.length === 0) {
			throw new BizError(t('externalToRequired'), 400);
		}

		for (const addr of receiveEmail) {
			if (!verifyUtils.isEmail(addr)) {
				throw new BizError(t('notEmail'), 400);
			}
		}

		if (!subject) {
			throw new BizError(t('externalSubjectRequired'), 400);
		}

		if (!text && !html) {
			throw new BizError(t('externalContentRequired'), 400);
		}

		if (attachments.length > 10) {
			throw new BizError(t('attLimit'), 400);
		}

		// ---------- 通道判定 ----------
		const { resendTokens, send, domainList: settingDomainList } = await settingService.query(c);

		if (send === settingConst.send.CLOSE) {
			throw new BizError(t('disabledSend'), 403);
		}

		// 收件人是否全部为站内邮箱
		const allInternal = receiveEmail.every(addr => {
			return settingDomainList.includes('@' + emailUtils.getDomain(addr));
		});

		const resendToken = resendTokens[fromDomain];
		const useCloudflareEmail = !!c.env.email;

		// 存在站外收件人却没有任何发信服务
		if (!useCloudflareEmail && !resendToken && !allInternal) {
			throw new BizError(t('noSendProvider'), 400);
		}

		const name = fromName || emailUtils.getName(from);

		// ---------- 真实投递（Cloudflare / Resend）----------
		let sendResult = {};

		if (!allInternal) {

			const sendParams = {
				name,
				accountEmail: from,
				receiveEmail,
				subject,
				text,
				html,
				attachments,
				sendType: 'external',
				messageId: null
			};

			if (useCloudflareEmail) {
				sendResult = await emailService.sendByCloudflareEmail(c, sendParams);
			} else {
				sendResult = await emailService.sendByResend(resendToken, sendParams);
			}

		}

		const { data, error } = sendResult;

		if (error) {
			throw new BizError(error.message || String(error));
		}

		// ---------- 归属：优先绑定到 from 对应账户，否则归属管理员，保证「全部邮件」可关联展示 ----------
		const accountRow = await accountService.selectByEmailIncludeDel(c, from);
		const adminUser = await userService.selectByEmail(c, c.env.admin);

		const userId = (accountRow && accountRow.userId) || (adminUser && adminUser.userId) || 0;
		const accountId = (accountRow && accountRow.accountId) || 0;

		// ---------- 落库（系统可见）----------
		const recipient = receiveEmail.map(addr => ({ address: addr, name: '' }));

		const emailData = {
			sendEmail: from,
			name,
			subject,
			content: html || '',
			text: text || '',
			accountId,
			userId,
			status: useCloudflareEmail ? emailConst.status.DELIVERED : emailConst.status.SENT,
			type: emailConst.type.SEND,
			resendEmailId: data?.id || null,
			recipient: JSON.stringify(recipient)
		};

		const emailResult = await orm(c).insert(email).values(emailData).returning().get();

		// ---------- 附件落库（需配置 R2）----------
		if (attachments.length > 0) {
			await attService.saveSendAtt(c, attachments, userId, accountId, emailResult.emailId);
		}

		const attList = await attService.selectByEmailIds(c, [emailResult.emailId]);
		emailResult.attList = attList;

		// ---------- 站内投递：写入收件人收件箱，并回写发件状态 ----------
		if (allInternal) {
			await emailService.HandleOnSiteEmail(c, receiveEmail, emailResult, attList);
		}

		// ---------- 每日发送统计（分析图表可见）----------
		const dateStr = dayjs().format('YYYY-MM-DD');
		let daySendTotal = await c.env.kv.get(kvConst.SEND_DAY_COUNT + dateStr);

		if (!daySendTotal) {
			await c.env.kv.put(kvConst.SEND_DAY_COUNT + dateStr, JSON.stringify(receiveEmail.length), { expirationTtl: 60 * 60 * 24 });
		} else {
			daySendTotal = Number(daySendTotal) + receiveEmail.length;
			await c.env.kv.put(kvConst.SEND_DAY_COUNT + dateStr, JSON.stringify(daySendTotal), { expirationTtl: 60 * 60 * 24 });
		}

		return {
			emailId: emailResult.emailId,
			messageId: data?.id || null,
			channel: allInternal ? 'internal' : (useCloudflareEmail ? 'cloudflare' : 'resend'),
			status: allInternal ? 'delivered' : (useCloudflareEmail ? 'delivered' : 'sent'),
			from,
			to: receiveEmail,
			createTime: emailResult.createTime
		};
	}

};

export default externalService;
