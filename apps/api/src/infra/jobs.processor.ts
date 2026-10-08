import { writeLog } from "../common/activity-log.js";
import { BadRequestException, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { UnrecoverableError, Worker } from "bullmq";
import { PrismaService } from "./prisma.service.js";
import { FilesService } from "../modules/files/files.service.js";
import { MeetingsService } from "../modules/meetings/meetings.service.js";
import { MemoriesService } from "../modules/memories/memories.service.js";
import { JobsService } from "./jobs.service.js";
import { PresentationsService } from "../modules/presentations/presentations.service.js";
import { safeErrorMeta } from "../common/safe-error.js";
import { MailService } from "../modules/mail/mail.service.js";

@Injectable()
export class JobsProcessor implements OnModuleInit, OnModuleDestroy {
  private worker?: Worker;
  private mailTimer?: ReturnType<typeof setInterval>;
  private flushingMail = false;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private heartbeatRunning = false;
  private recoveryTick = 0;
  constructor(private readonly prisma: PrismaService, private readonly files: FilesService, private readonly meetings: MeetingsService, private readonly memories: MemoriesService, private readonly presentations: PresentationsService, private readonly jobs: JobsService, private readonly mail: MailService) {}
  onModuleInit() {
    if (process.env.WORKER_MODE !== "true") return;
    const heartbeat=async()=>{
      if(this.heartbeatRunning)return;this.heartbeatRunning=true;
      try{
        const client=await this.jobs.queue.client;await client.set("nbboss:worker:heartbeat",new Date().toISOString(),"PX",20_000);
        if(this.recoveryTick++ % 6 !== 0)return;
        const staleAt=new Date(Date.now()-15*60_000);
        const staleFiles=await this.prisma.fileAsset.findMany({where:{status:{in:["PENDING","PROCESSING"]},createdAt:{lt:staleAt}},take:30});
        for(const file of staleFiles){const job=await this.jobs.queue.getJob(`file-${file.id}`);const state=job?await job.getState():"missing";if(!["active","waiting","delayed"].includes(state))await this.prisma.fileAsset.updateMany({where:{id:file.id,status:{in:["PENDING","PROCESSING"]}},data:{status:"FAILED",errorMessage:"文件处理任务已中断或丢失，请重试解析"}});}
        const stalePpts=await this.prisma.presentation.findMany({where:{status:{in:["PENDING","PROCESSING"]},updatedAt:{lt:staleAt}},take:30});
        for(const ppt of stalePpts){const job=await this.jobs.queue.getJob(`presentation-${ppt.id}`);const state=job?await job.getState():"missing";if(!["active","waiting","delayed"].includes(state))await this.prisma.presentation.updateMany({where:{id:ppt.id,status:{in:["PENDING","PROCESSING"]}},data:{status:"FAILED",errorMessage:"PPT 任务已中断或丢失，请重试生成"}});}
        const staleMeetings=await this.prisma.conversation.findMany({where:{meetingStatus:"PROCESSING",updatedAt:{lt:staleAt}},take:30});
        if(staleMeetings.length){const jobs=await this.jobs.queue.getJobs(["active","wait","delayed"],0,500);for(const conversation of staleMeetings){const pending=jobs.some(job=>job.name==="meeting.analyze"&&job.data.conversationId===conversation.id);const files=await this.prisma.fileAsset.count({where:{conversationId:conversation.id,status:{in:["PENDING","PROCESSING"]}}});if(!pending&&!files)await this.prisma.conversation.updateMany({where:{id:conversation.id,meetingStatus:"PROCESSING"},data:{meetingStatus:"FAILED",meetingErrorMessage:"会议分析任务已中断或丢失，请重新分析"}});}}
        const tasks=await this.prisma.memoryExtraction.findMany({where:{status:{in:["PENDING","PROCESSING"]},updatedAt:{lt:new Date(Date.now()-10*60_000)}},take:30});
        for(const task of tasks){
          const job=await this.jobs.queue.getJob(`memory-${task.id}`);const state=job?await job.getState():"missing";
          if(!["active","waiting","delayed"].includes(state))await this.prisma.memoryExtraction.updateMany({where:{id:task.id,status:{in:["PENDING","PROCESSING"]}},data:{status:"FAILED",errorMessage:"后台任务已中断或丢失，请重试抽取"}});
        }
      }catch{writeLog({category:"SYSTEM",level:"ERROR",operation:"worker.recovery",status:"FAILED",errorCode:"RECOVERY_FAILED"});}finally{this.heartbeatRunning=false;}
    };
    void heartbeat();this.heartbeatTimer=setInterval(()=>void heartbeat(),5000);this.heartbeatTimer.unref();
    this.mailTimer = setInterval(() => {
      if (this.flushingMail) return;
      this.flushingMail = true;
      void this.mail.flushPending().catch(() => writeLog({category:"SYSTEM",level:"ERROR",operation:"mail.delivery",status:"FAILED",errorCode:"DELIVERY_FAILED"})).finally(() => { this.flushingMail = false; });
    }, 5000);
    this.mailTimer.unref();
    this.worker = new Worker("nbboss", async (job) => {
      const startedAt = Date.now();
      let userId = typeof job.data.userId === "string" ? job.data.userId : undefined;
      let resource = job.data.conversationId ?? job.data.sourceId ?? job.data.presentationId ?? job.data.fileId ?? "unknown";
      if (job.name === "file.parse" && !userId) {
        const file = await this.prisma.fileAsset.findUnique({ where: { id: job.data.fileId }, select: { userId: true, conversationId: true } });
        userId = file?.userId;
        resource = file?.conversationId ?? job.data.fileId;
      }
      try {
        if (job.name === "file.parse") {
          await this.files.process(job.data.fileId);
          const file = await this.prisma.fileAsset.findUnique({ where: { id: job.data.fileId } });
          if (file && ["READY","PARTIAL"].includes(file.status)) {
            const conversation = await this.prisma.conversation.findUnique({where:{id:file.conversationId}});
            if(conversation?.mode === "MEETING") await this.jobs.analyzeMeetingAfterUpload(file.userId, file.conversationId);
          }
        } else if (job.name === "meeting.analyze") {
          try { await this.meetings.analyzeConversation(job.data.userId, job.data.conversationId, Boolean(job.data.force)); }
          catch (error) {
            const meta = safeErrorMeta(error);
            if (error instanceof NotFoundException) throw new UnrecoverableError("SOURCE_NOT_FOUND");
            if (error instanceof BadRequestException) throw new UnrecoverableError(`INVALID_REQUEST: ${error.message.slice(0,200)}`);
            if (meta.errorCode === "INVALID_RESPONSE" && job.attemptsMade >= 1) throw new UnrecoverableError("INVALID_RESPONSE");
            throw error;
          }
        } else if (job.name === "memory.extract") {
          if(job.data.taskId){
            const task=await this.prisma.memoryExtraction.findUnique({where:{id:job.data.taskId}});
            if(task && task.status!=="READY"){
              await this.prisma.memoryExtraction.updateMany({where:{id:task.id},data:{status:"PROCESSING",errorMessage:null}});
              await this.memories.extract(task.userId,task.sourceType as "CONVERSATION"|"MEETING",task.sourceId,task.text,task.observedAt);
              await this.prisma.memoryExtraction.updateMany({where:{id:task.id},data:{status:"READY",text:"",errorMessage:null}});
            }
          }else await this.memories.extract(job.data.userId,job.data.sourceType,job.data.sourceId,job.data.text,new Date(job.data.observedAt));
        } else if (job.name === "presentation.generate") {
          await this.presentations.process(job.data.userId, job.data.presentationId, (progress) => job.updateProgress(progress));
        } else {
          throw new UnrecoverableError("UNKNOWN_JOB_TYPE");
        }
        writeLog({category:"TASK",userId,traceId:String(job.id),resourceId:resource,operation:job.name,status:"COMPLETED",durationMs:Date.now()-startedAt,attempt:job.attemptsMade+1});
      } catch (error) {
        const meta = safeErrorMeta(error);
        const attempt = job.attemptsMade + 1;
        const final = error instanceof UnrecoverableError || attempt >= (job.opts.attempts ?? 1);
        const traceId = String(job.id ?? "unknown");
        if(job.name==="memory.extract" && job.data.taskId)await this.prisma.memoryExtraction.updateMany({where:{id:job.data.taskId},data:{status:final?"FAILED":"PENDING",errorMessage:final?`记忆抽取失败，请重试（参考编号：${traceId}）`:"记忆抽取暂时失败，后台正在重试"}});
        if (final && job.name === "meeting.analyze") {
          await this.prisma.conversation.updateMany({ where: { id: job.data.conversationId, userId: job.data.userId }, data: { meetingStatus: "FAILED", meetingErrorMessage: error instanceof UnrecoverableError && error.message.startsWith("INVALID_REQUEST: ") ? error.message.slice(17) : `会议分析失败，系统已记录（参考编号：${traceId}）` } });
        }
        if (final && job.name === "presentation.generate") {
          await this.prisma.presentation.updateMany({ where: { id: job.data.presentationId, conversation: { userId: job.data.userId } }, data: { status: "FAILED", errorMessage: error instanceof BadRequestException ? error.message : `PPT 生成失败，系统已记录（参考编号：${traceId}）` } });
        }
        writeLog({category:"TASK",userId,level:final?"ERROR":"WARN",traceId,resourceId:resource,operation:job.name,status:final?"FAILED":"RETRYING",durationMs:Date.now()-startedAt,attempt,errorCode:error instanceof UnrecoverableError && /^[A-Z_]+$/.test(error.message)?error.message:meta.errorCode});
        throw error;
      }
    }, {
      connection: { url: process.env.REDIS_URL ?? "redis://localhost:6379" },
      concurrency: 3,
      // Provider calls may legitimately approach the configured three-minute
      // timeout. Keep the BullMQ lease longer than that window so a long
      // structured response is not mistaken for a stalled duplicate job.
      lockDuration: 10 * 60_000,
    });
  }
  async onModuleDestroy() { if(this.heartbeatTimer)clearInterval(this.heartbeatTimer); if (this.mailTimer) clearInterval(this.mailTimer); await this.worker?.close(); }
}
