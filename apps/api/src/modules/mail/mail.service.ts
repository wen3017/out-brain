import { Injectable, NotFoundException } from "@nestjs/common";
import { createHash } from "node:crypto";
import nodemailer from "nodemailer";
import { PrismaService } from "../../infra/prisma.service.js";
import type { Prisma } from "@prisma/client";
import { smtpFailure } from "./smtp-policy.js";

@Injectable()
export class MailService {
  constructor(private readonly prisma: PrismaService) {}
  async enqueueSummary(meetingId: string, db: Prisma.TransactionClient = this.prisma) {
    const meeting = await db.meeting.findUnique({ where: { id: meetingId }, include: { risks: { where: { active: true } }, todos: true } });
    if (!meeting || meeting.archived || !meeting.risks.length) {
      await db.emailDelivery.updateMany({where:{meetingId,status:{in:["PENDING","FAILED","DISABLED"]}},data:{status:"CANCELLED",errorCode:"NO_CURRENT_RISKS"}});
      return;
    }
    const risks = meeting.risks;
    const todos = meeting.todos.filter(t => risks.some(r => r.id === t.riskId));
    const payload = { title: meeting.title,
      risks: risks.map(r=>({fingerprint:r.fingerprint??r.id,severity:r.severity,description:r.description,evidence:r.evidence})).sort((a,b)=>a.fingerprint.localeCompare(b.fingerprint)),
      todos: todos.map(t=>({id:t.id,title:t.title,description:t.description,owner:t.owner,dueAt:t.dueAt,status:t.status})).sort((a,b)=>a.id.localeCompare(b.id)),
    };
    const idempotencyKey = createHash("sha256").update(`${meetingId}:${JSON.stringify(payload)}`).digest("hex");
    await db.emailDelivery.updateMany({where:{meetingId,idempotencyKey:{not:idempotencyKey},status:{in:["PENDING","FAILED","DISABLED"]}},data:{status:"CANCELLED",errorCode:"SUPERSEDED_BY_CURRENT_CONTENT"}});
    const delivery = await db.emailDelivery.upsert({ where: { idempotencyKey }, update: {}, create: { meetingId, idempotencyKey, payload: JSON.parse(JSON.stringify(payload)), status: this.available() ? "PENDING" : "DISABLED", recipientMasked: this.mask(process.env.SMTP_TO ?? ""), errorCode: this.available() ? null : "SMTP_NOT_CONFIGURED" } });
    return delivery;
  }

  available() { return process.env.SMTP_ENABLED === "true" && (process.env.SMTP_PROVIDER === "mock" || Boolean(process.env.SMTP_HOST && process.env.SMTP_TO && process.env.SMTP_FROM)); }
  async retry(userId: string, conversationId: string, id: string, inboxChecked = false) {
    const delivery = await this.prisma.emailDelivery.findFirst({ where: { id, meeting: { conversationId, conversation: { userId } } } });
    if (!delivery) throw new NotFoundException("邮件不存在");
    if (!this.available()) return { queued: false, reason: "请先配置 SMTP 与收件人并重启服务" };
    const rebuilt = await this.enqueueSummary(delivery.meetingId);
    if(!rebuilt)return {queued:false,reason:"当前会议已归档或风险已撤回，不发送历史内容"};
    if(rebuilt.status==="SENT" || rebuilt.status==="SENDING")return {queued:false,reason:"当前版本已发送或正在发送，请核对收件箱"};
    if (["DELIVERY_UNCERTAIN_CHECK_INBOX", "DELIVERY_PARTIAL_CHECK_INBOX"].includes(rebuilt.errorCode ?? "") && !inboxChecked) return { queued: false, reason: "邮件可能已经被接收，请先核对收件箱；确认需要重发后再提交", requiresInboxCheck: true };
    const result=await this.prisma.emailDelivery.updateMany({where:{id:rebuilt.id,status:{in:["FAILED","DISABLED","CANCELLED","PENDING"]}},data:{status:"PENDING",errorCode:null,recipientMasked:this.mask(process.env.SMTP_TO??"")}});
    return {queued:result.count>0};
  }

  async flushPending() {
    // A process crash after SMTP acceptance is ambiguous: require explicit retry
    // instead of automatically sending the same message again.
    await this.prisma.emailDelivery.updateMany({ where: { status: "SENDING", updatedAt: { lt: new Date(Date.now()-10*60_000) } }, data: { status: "FAILED", errorCode: "DELIVERY_UNCERTAIN_CHECK_INBOX" } });
    const rows = await this.prisma.emailDelivery.findMany({ where: { status: "PENDING" }, orderBy: { createdAt: "asc" }, take: 10 });
    for (const row of rows) {
      const current = await this.enqueueSummary(row.meetingId);
      if(!current || current.id!==row.id)continue;
      if (!row.payload) { await this.prisma.emailDelivery.updateMany({ where: { id: row.id, status: "PENDING" }, data: { status: "FAILED", errorCode: "LEGACY_PAYLOAD_MISSING" } }); continue; }
      const claim = await this.prisma.emailDelivery.updateMany({ where: { id: row.id, status: "PENDING" }, data: { status: "SENDING" } });
      if (!claim.count) continue;
      const payload = row.payload as unknown as { title: string; risks: Array<{ description: string; evidence?: Array<{ quote: string }> }>; todos: Array<{ title: string; owner: string; dueAt?: string | null }> };
      await this.sendMeetingSummary(row.meetingId, payload.title, payload.risks, payload.todos, row.id);
    }
  }
  async sendMeetingSummary(meetingId: string, title: string, risks: Array<{ description: string; evidence?: Array<{ quote: string }> }>, todos: Array<{ title: string; owner: string; dueAt?: string | Date | null }>, deliveryId?: string) {
    const mock = process.env.SMTP_PROVIDER === "mock";
    const recipient = process.env.SMTP_TO ?? (mock ? "demo@example.test" : "");
    if (process.env.SMTP_ENABLED !== "true" || !recipient || (!mock && !process.env.SMTP_HOST)) {
      const data = { recipientMasked: this.mask(recipient), status: "DISABLED" as const, errorCode: "SMTP_NOT_CONFIGURED" };
      return deliveryId ? this.prisma.emailDelivery.update({ where: { id: deliveryId }, data }) : this.prisma.emailDelivery.create({ data: { meetingId, ...data } });
    }
    const delivery = deliveryId ? { id: deliveryId } : await this.prisma.emailDelivery.create({ data: { meetingId, recipientMasked: this.mask(recipient), status: "PENDING" } });
    if (mock) return this.prisma.emailDelivery.update({ where: { id: delivery.id }, data: { status: "SENT", attempts: 1, sentAt: new Date(), errorCode: "MOCK_DELIVERY" } });
    const transport = nodemailer.createTransport({
        host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT ?? 587), secure: Number(process.env.SMTP_PORT) === 465,
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined,
        connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
    });
    try {
      const html = `<h2>${this.escape(title)}</h2><p>会议编号：${this.escape(meetingId)}</p><h3>风险</h3><ul>${risks.map((r) => `<li>${this.escape(r.description)}<blockquote>${this.escape(r.evidence?.map(e => e.quote).join("；") ?? "")}</blockquote></li>`).join("")}</ul><h3>待办</h3><ul>${todos.map((t) => `<li>${this.escape(t.title)}（${this.escape(t.owner)}）截止：${this.escape(t.dueAt ? String(t.dueAt) : "待确认")}</li>`).join("")}</ul>`;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const info = await transport.sendMail({ from: process.env.SMTP_FROM, to: recipient, messageId: `<${delivery.id}@nbboss.local>`, subject: `[NBBOSS] ${title} 风险与待办汇总`, html });
          if (!info.accepted?.length || info.rejected?.length) {
            return await this.prisma.emailDelivery.update({ where: { id: delivery.id }, data: { status: "FAILED", attempts: attempt, errorCode: info.accepted?.length ? "DELIVERY_PARTIAL_CHECK_INBOX" : "SMTP_RECIPIENT_REJECTED" } });
          }
        } catch (error) {
          const failure = smtpFailure(error);
          if (!failure.retryable || attempt === 3) {
            return await this.prisma.emailDelivery.update({ where: { id: delivery.id }, data: { status: "FAILED", attempts: attempt, errorCode: failure.code } });
          }
          await this.prisma.emailDelivery.update({ where: { id: delivery.id }, data: { attempts: attempt } });
          await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
          continue;
        }
        // Keep DB acknowledgement outside the transport retry block: a DB outage
        // after SMTP acceptance must never result in sending the email again.
        return await this.prisma.emailDelivery.update({ where: { id: delivery.id }, data: { status: "SENT", attempts: attempt, sentAt: new Date(), errorCode: null } });
      }
    } finally { transport.close(); }
  }
  private mask(value: string) { if (!value.includes("@")) return value ? "***" : ""; const [name, domain] = value.split("@"); return `${name.slice(0, 2)}***@${domain}`; }
  private escape(value: string) { return value.replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[m]!); }
}
