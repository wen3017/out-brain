import { Injectable, NotFoundException, BeforeApplicationShutdown, OnModuleInit } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../../infra/prisma.service.js";
import { attachLogSink, flushLogs, writeLog } from "../../common/activity-log.js";
import { z } from "zod";

const isoDate=z.string().datetime({offset:true});
export const logQuerySchema=z.object({
  level:z.enum(["INFO","WARN","ERROR"]).optional(),
  category:z.enum(["OPERATION","TASK","CONVERSATION","SYSTEM"]).optional(),
  q:z.string().trim().max(120).optional(), from:isoDate.optional(), to:isoDate.optional(),
  cursor:z.string().max(400).optional(), limit:z.coerce.number().int().min(1).max(100).default(50),
}).refine(v=>!v.from||!v.to||Date.parse(v.from)<=Date.parse(v.to),{message:"开始时间不能晚于结束时间"});
export type LogQuery=z.infer<typeof logQuerySchema>;
const cursorSchema=z.object({createdAt:isoDate,id:z.string().uuid()});
export function retentionDays() { const n=Number(process.env.LOG_RETENTION_DAYS ?? 30);return Number.isInteger(n)&&n>=1&&n<=365?n:30; }

export function logWhere(userId:string,query:LogQuery):Prisma.ActivityLogWhereInput {
  const oldest=new Date(Date.now()-retentionDays()*86400000);
  return {userId, createdAt:{gte:query.from?new Date(Math.max(oldest.valueOf(),Date.parse(query.from))):oldest,...(query.to?{lte:new Date(query.to)}:{})},
    ...(query.level?{level:query.level}:{}),...(query.category?{category:query.category}:{}),
    ...(query.q?{OR:["operation","traceId","resourceId","errorCode"].map(key=>({[key]:{contains:query.q,mode:"insensitive"}}))}:{}),
  };
}

@Injectable()
export class LogsService implements OnModuleInit, BeforeApplicationShutdown {
  private detach?:()=>void;
  private timer?:ReturnType<typeof setInterval>;
  private cleaning=false;
  constructor(private readonly prisma:PrismaService) {}
  onModuleInit() {
    this.detach=attachLogSink(async record=>{await this.prisma.activityLog.create({data:record});});
    if(process.env.WORKER_MODE!=="true") {
      void this.cleanup();
      this.timer=setInterval(()=>void this.cleanup(),3600000);this.timer.unref();
    }
  }
  async beforeApplicationShutdown() { if(this.timer)clearInterval(this.timer);await flushLogs();this.detach?.(); }
  async cleanup() {
    if(this.cleaning)return;
    this.cleaning=true;
    try {await this.prisma.activityLog.deleteMany({where:{createdAt:{lt:new Date(Date.now()-retentionDays()*86400000)}}});}
    catch {writeLog({category:"SYSTEM",level:"ERROR",operation:"logs.retention",status:"FAILED",errorCode:"LOG_CLEANUP_FAILED"});}
    finally{this.cleaning=false;}
  }
  async list(userId:string,query:LogQuery) {
    const where=logWhere(userId,query);
    let pageWhere=where;
    if(query.cursor) {
      let raw:unknown;try{raw=JSON.parse(Buffer.from(query.cursor,"base64url").toString("utf8"));}catch{raw=null;}
      const cursor=cursorSchema.parse(raw);
      pageWhere={AND:[where,{OR:[{createdAt:{lt:new Date(cursor.createdAt)}},{createdAt:new Date(cursor.createdAt),id:{lt:cursor.id}}]}]};
    }
    const [rows,total,counts]=await Promise.all([
      this.prisma.activityLog.findMany({where:pageWhere,orderBy:[{createdAt:"desc"},{id:"desc"}],take:query.limit+1,omit:{userId:true}}),
      this.prisma.activityLog.count({where}),
      this.prisma.activityLog.groupBy({by:["level"],where,_count:true}),
    ]);
    const hasMore=rows.length>query.limit,items=rows.slice(0,query.limit),last=items.at(-1);
    return {items,total,counts:Object.fromEntries(counts.map(c=>[c.level,c._count])),retentionDays:retentionDays(),nextCursor:hasMore&&last?Buffer.from(JSON.stringify({id:last.id,createdAt:last.createdAt.toISOString()})).toString("base64url"):null};
  }
  async detail(userId:string,id:string) {
    const value=await this.prisma.activityLog.findFirst({where:{id,...logWhere(userId,{limit:1})},omit:{userId:true}});
    if(!value)throw new NotFoundException("日志不存在或已超过保留期限");
    return value;
  }
}
