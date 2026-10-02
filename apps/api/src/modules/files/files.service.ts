import { extractPdf } from "./pdf-extraction.js";
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { PrismaService } from "../../infra/prisma.service.js";
import { ConversationsService } from "../conversations/conversations.service.js";
import { EmbeddingService } from "./embedding.service.js";
import { JobsService } from "../../infra/jobs.service.js";
import { deleteMemoryFactsBySources } from "../memories/memory-history.js";

@Injectable()
export class FilesService {
  private readonly root = process.env.STORAGE_ROOT ?? join(process.cwd(), "data", "uploads");
  constructor(private readonly prisma: PrismaService, private readonly conversations: ConversationsService, private readonly embeddings: EmbeddingService, private readonly jobs: JobsService) {}

  async save(userId: string, conversationId: string, file: Express.Multer.File, deferQueue = false) {
    const conversation = await this.conversations.assertOwned(userId, conversationId);
    const {ext,kind} = this.validateUpload(file,conversation.mode);
    const hash = createHash("sha256").update(file.buffer).digest("hex");
    let writtenPath: string | undefined;
    let result;
    try {
      result = await this.prisma.$transaction(async tx => {
        // Scope the lock to the owner, conversation, type and bytes. Other
        // conversations never reuse this asset or its storage path.
        const key = `${userId}:${conversationId}:${kind}:${hash}`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
        const existing = await tx.fileAsset.findFirst({ where: { userId, conversationId, kind, sha256: hash }, orderBy: { createdAt: "asc" } });
        if (existing) return { asset: existing, created: false };
        const id = randomUUID(); const dir = join(this.root, userId, conversationId);
        await mkdir(dir, { recursive: true });
        const finalPath = join(dir, `${id}${ext}`); writtenPath = finalPath;
        await writeFile(finalPath, file.buffer, { mode: 0o600 });
        const asset = await tx.fileAsset.create({ data: {
          id, userId, conversationId, kind, originalName: file.originalname.slice(0,255), storagePath: finalPath,
          mimeType: file.mimetype, size: file.size, sha256: hash, status: "PROCESSING",
        }});
        if (conversation.mode === "MEETING") await tx.conversation.update({ where: { id: conversationId }, data: { meetingStatus: "PROCESSING", meetingErrorMessage: null } });
        return { asset, created: true };
      });
    } catch(error) { if(writtenPath) await rm(writtenPath,{force:true}); throw error; }
    if(result.created && !deferQueue) await this.enqueue(result.asset.id);
    return result.asset;
  }

  async validateBatch(userId:string,conversationId:string,files:Express.Multer.File[]) {
    const conversation=await this.conversations.assertOwned(userId,conversationId);
    if(!files?.length)throw new BadRequestException("请选择要上传的文件");
    for(const file of files)this.validateUpload(file,conversation.mode);
  }

  private validateUpload(file:Express.Multer.File,mode:string):{ext:string;kind:"PDF"|"TXT"} {
    if (!file?.buffer) throw new BadRequestException("请选择要上传的文件");
    const ext = extname(file.originalname).toLowerCase();
    const kind = ext === ".pdf" ? "PDF" : ext === ".txt" ? "TXT" : null;
    if (!kind) throw new BadRequestException("仅支持 PDF 和 UTF-8 TXT 文件");
    if (kind === "TXT" && mode !== "MEETING") throw new BadRequestException("TXT 仅可上传到会议分析会话");
    if (kind === "PDF" && file.mimetype !== "application/pdf") throw new BadRequestException("PDF 的 MIME 类型不正确");
    if (kind === "PDF" && file.buffer.subarray(0, 5).toString("ascii") !== "%PDF-") throw new BadRequestException("文件内容不是有效的 PDF");
    if (kind === "TXT" && !["text/plain", "application/octet-stream"].includes(file.mimetype)) throw new BadRequestException("TXT 的 MIME 类型不正确");
    if (kind === "PDF" && file.size > 20 * 1024 * 1024) throw new BadRequestException("PDF 不得超过 20 MB");
    if (kind === "TXT" && file.size > 5 * 1024 * 1024) throw new BadRequestException("TXT 不得超过 5 MB");
    if (kind === "TXT") {
      try { const text = new TextDecoder("utf-8", { fatal: true }).decode(file.buffer); if(!text.trim()) throw new BadRequestException("TXT 文件为空，请提供会议原文"); if(text.length > 120_000) throw new BadRequestException("TXT 最多支持 120,000 字符，请按会议或章节拆分后上传"); }
      catch (error) { if(error instanceof BadRequestException) throw error; throw new BadRequestException("TXT 必须为 UTF-8 文本"); }
      if (file.buffer.includes(0)) throw new BadRequestException("TXT 必须为 UTF-8 文本");
    }
    return {ext,kind};
  }

  async enqueue(fileId: string) {
    try { await this.jobs.parseFile(fileId); }
    catch(error) {
      await this.prisma.fileAsset.updateMany({where:{id:fileId},data:{status:"FAILED",errorMessage:"后台处理队列暂不可用，请重试解析"}});
      throw error;
    }
  }

  async process(fileId: string) {
    const asset = await this.prisma.fileAsset.findUnique({ where: { id: fileId } });
    if (!asset) return;
    if (asset.status === "READY") return;
    let parseNotice: string | null = null; let partial = false;
    try {
      await this.prisma.$transaction([this.prisma.documentChunk.deleteMany({ where: { fileId } }), this.prisma.documentPage.deleteMany({ where: { fileId } })]);
      const buffer = await readFile(asset.storagePath);
      if (asset.kind === "TXT") {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
        if (!text.trim()) throw new Error("TXT 文件为空");
        await this.prisma.documentPage.create({ data: { fileId, pageNo: 1, text } });
        await this.createChunks(fileId, [{ pageNo: 1, text }]);
      } else {
        const pages = await extractPdf(buffer, async (page, total) => {
          await this.prisma.fileAsset.updateMany({ where: { id: fileId }, data: { errorMessage: '正在解析 PDF：' + page + '/' + total + ' 页' } });
        });
        if (pages.some(page => page.extractionMethod === "OCR")) parseNotice = "已使用本地 OCR；图片文字可能存在识别误差，请结合原页核对。";
        const uncertain = pages.filter(page=>page.qualityStatus!=="OK");
        partial = uncertain.length > 0;
        if(partial)parseNotice=`部分解析：第 ${uncertain.map(p=>p.pageNo).join("、")} 页需要核对；请上传更清晰版本或重试。`;
        await this.prisma.documentPage.createMany({ data: pages.map((page) => ({ fileId, ...page })) });
        await this.createChunks(fileId, pages);
      }
      // The owner may delete the file/conversation while parsing is in flight.
      // updateMany turns that normal cancellation race into a no-op instead of
      // making BullMQ retry a job whose source no longer exists.
      await this.prisma.fileAsset.updateMany({ where: { id: fileId }, data: { status: partial ? "PARTIAL" : "READY", errorMessage: parseNotice } });
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : "解析失败";
      const updated = await this.prisma.fileAsset.updateMany({ where: { id: fileId }, data: { status: "FAILED", errorMessage: message } });
      if (updated.count) await this.prisma.conversation.updateMany({ where: { id: asset.conversationId, mode: "MEETING" }, data: { meetingStatus: "FAILED", meetingErrorMessage: `会议文件解析失败：${message}` } });
      if (updated.count) throw error;
    }
  }

  async get(userId: string, id: string) {
    const file = await this.prisma.fileAsset.findFirst({ where: { id, userId } });
    if (!file) throw new NotFoundException("文件不存在");
    return file;
  }
  async retry(userId: string, id: string) {
    const file = await this.get(userId, id);
    if (!["FAILED","PARTIAL"].includes(file.status)) return { queued: false };
    const job = await this.jobs.queue.getJob(`file-${id}`);
    if (job && await job.isActive()) return { queued: false };
    if (job) await job.remove();
    await this.prisma.fileAsset.update({ where: { id }, data: { status: "PROCESSING", errorMessage: null } });
    try { await this.jobs.parseFile(id); }
    catch { await this.prisma.fileAsset.update({ where: { id }, data: { status: "FAILED", errorMessage: "队列暂不可用，请重试" } }); }
    return { queued: true };
  }
  async remove(userId: string, id: string) {
    const file = await this.get(userId, id);
    const trashPath = `${file.storagePath}.deleting-${randomUUID()}`;
    let moved = false;
    try { await rename(file.storagePath, trashPath); moved = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    let reanalyze = false;
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.fileAsset.delete({ where: { id } });
        const conversation = await tx.conversation.findFirst({ where: { id: file.conversationId, userId } });
        if (conversation?.mode !== "MEETING") return;
        const remainingTxt = await tx.fileAsset.count({ where: { conversationId: file.conversationId, userId, kind: "TXT", status: "READY" } });
        if (remainingTxt) {
          reanalyze = true;
          await tx.conversation.update({ where: { id: file.conversationId }, data: { meetingStatus: "PROCESSING", meetingErrorMessage: null } });
        } else {
          const meetings = await tx.meeting.findMany({ where: { conversationId: file.conversationId }, select: { id: true } });
          await deleteMemoryFactsBySources(tx, userId, meetings.map((meeting) => meeting.id));
          await tx.meeting.deleteMany({ where: { conversationId: file.conversationId } });
          await tx.conversation.update({ where: { id: file.conversationId }, data: { meetingStatus: null, meetingErrorMessage: null } });
        }
      });
    } catch (error) {
      if (moved) await rename(trashPath, file.storagePath).catch(() => undefined);
      throw error;
    }
    if (moved) void rm(trashPath, { force: true }).catch((error) => console.error(JSON.stringify({ level: "error", operation: "storage.cleanup", resource: id, error: error instanceof Error ? error.name : "unknown" })));
    if (reanalyze) {
      try { await this.jobs.analyzeMeeting(userId, file.conversationId, true); }
      catch (error) {
        await this.prisma.conversation.updateMany({ where: { id: file.conversationId, userId }, data: { meetingStatus: "FAILED", meetingErrorMessage: "会议分析队列暂不可用，请稍后重试" } });
        throw error;
      }
    }
    return { ok: true };
  }

  private async createChunks(fileId: string, pages: Array<{ pageNo: number; text: string }>) {
    const chunks: Array<{ fileId: string; pageStart: number; pageEnd: number; charStart: number; charEnd: number; content: string; tokenCount: number }> = [];
    for (const page of pages) {
      for (let start = 0; start < page.text.length; start += 1200) {
        const charStart = Math.max(0, start - (start ? 150 : 0));
        const charEnd = Math.min(page.text.length, start + 1500);
        const content = page.text.slice(charStart, charEnd).trim();
        if (content) chunks.push({ fileId, pageStart: page.pageNo, pageEnd: page.pageNo, charStart, charEnd, content, tokenCount: Math.ceil(content.length / 2) });
      }
    }
    if (chunks.length) {
      await this.prisma.documentChunk.createMany({ data: chunks });
      if (this.embeddings.available()) {
        try {
          const stored = await this.prisma.documentChunk.findMany({ where: { fileId }, orderBy: { id: "asc" } });
          for (let offset = 0; offset < stored.length; offset += 32) {
            const batch = stored.slice(offset, offset + 32);
            const vectors = await this.embeddings.embed(batch.map((item) => item.content));
            for (let index = 0; index < vectors.length; index++) {
              const vector = `[${vectors[index].join(",")}]`;
              await this.prisma.$executeRaw`UPDATE "DocumentChunk" SET "embedding" = ${vector}::vector WHERE "id" = ${batch[index].id}`;
            }
          }
        } catch (error) {
          console.warn(JSON.stringify({ level: "warn", operation: "document.embedding", fileId, errorCode: "EMBEDDING_UNAVAILABLE", error: error instanceof Error ? error.name : "unknown", fallback: "BM25" }));
        }
      }
    }
  }
}
