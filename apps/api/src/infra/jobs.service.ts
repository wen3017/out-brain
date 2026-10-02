import { NotFoundException, Injectable, OnModuleDestroy } from "@nestjs/common";
import { PrismaService } from "./prisma.service.js";
import { Queue } from "bullmq";
import { randomUUID } from "node:crypto";

@Injectable()
export class JobsService implements OnModuleDestroy {
  constructor(private readonly prisma: PrismaService) {}
  readonly queue = new Queue("nbboss", { connection: { url: process.env.REDIS_URL ?? "redis://localhost:6379" }, defaultJobOptions: { attempts: 3, backoff: { type: "exponential", delay: 1000 }, removeOnComplete: 100, removeOnFail: 100 } });
  parseFile(fileId: string) { return this.queue.add("file.parse", { fileId }, { jobId: `file-${fileId}` }); }
  analyzeMeeting(userId: string, conversationId: string, force = false) { return this.queue.add("meeting.analyze", { userId, conversationId, force }, { jobId: `meeting-${conversationId}-${randomUUID()}`, attempts: 10, backoff: { type: "fixed", delay: 15_000 } }); }
  analyzeMeetingAfterUpload(userId: string, conversationId: string) {
    const configured = Number(process.env.MEETING_UPLOAD_DEBOUNCE_MS ?? 2_000);
    const delay = Number.isFinite(configured) ? Math.max(250, Math.min(configured, 30_000)) : 2_000;
    // Multiple TXT files are commonly uploaded together and finish parsing a
    // few milliseconds apart. BullMQ debounce replaces/extends the delayed job
    // so that one analysis sees the complete batch and sends one summary mail.
    // If another file becomes ready after the first analysis has started, its
    // deduplication TTL has expired and a necessary incremental run is queued.
    return this.queue.add("meeting.analyze", { userId, conversationId, force: false }, {
      jobId: `meeting-upload-${conversationId}-${randomUUID()}`,
      delay,
      deduplication: { id: `meeting-upload-${conversationId}`, ttl: delay, extend: true, replace: true },
      attempts: 10,
      backoff: { type: "fixed", delay: 15_000 },
    });
  }
  async extractMemory(userId: string, sourceType: "CONVERSATION" | "MEETING", sourceId: string, text: string, observedAt = new Date()) {
    const task = await this.prisma.memoryExtraction.upsert({where:{userId_sourceType_sourceId_observedAt:{userId,sourceType,sourceId,observedAt}},update:{},create:{userId,sourceType,sourceId,text,observedAt}});
    if(task.status==="READY")return {id:task.id};
    return this.enqueueMemoryTask(task.id,userId);
  }
  listMemoryTasks(userId:string){return this.prisma.memoryExtraction.findMany({where:{userId},orderBy:{createdAt:"desc"},take:100,select:{id:true,sourceType:true,sourceId:true,status:true,errorMessage:true,createdAt:true,updatedAt:true}});}
  async retryMemoryTask(userId:string,id:string){
    const task=await this.prisma.memoryExtraction.findFirst({where:{id,userId}});
    if(!task)throw new NotFoundException("记忆抽取任务不存在");
    if(task.status==="READY")return {queued:false};
    await this.enqueueMemoryTask(id,userId);
    return {queued:true};
  }
  private async enqueueMemoryTask(taskId:string,userId:string){
    try {
      const old=await this.queue.getJob(`memory-${taskId}`);
      if(old){const state=await old.getState();if(["active","waiting","delayed"].includes(state))return old;await old.remove();}
      await this.prisma.memoryExtraction.updateMany({where:{id:taskId,userId},data:{status:"PENDING",errorMessage:null}});
      return await this.queue.add("memory.extract",{taskId,userId},{jobId:`memory-${taskId}`});
    }catch(error){await this.prisma.memoryExtraction.updateMany({where:{id:taskId,userId},data:{status:"FAILED",errorMessage:"记忆抽取入队失败，请稍后重试"}});throw error;}
  }
  generatePresentation(userId: string, presentationId: string) { return this.queue.add("presentation.generate", { userId, presentationId }, { jobId: `presentation-${presentationId}`, attempts: 2, backoff: { type: "exponential", delay: 3000 } }); }
  async onModuleDestroy() { await this.queue.close(); }
}
