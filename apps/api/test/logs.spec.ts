import { describe, expect, it, vi } from "vitest";
import { attachLogSink, flushLogs, normalizeLog, writeLog } from "../src/common/activity-log.js";
import { LogsService, logQuerySchema, logWhere, retentionDays } from "../src/modules/logs/logs.service.js";

describe("activity logs",()=>{
  it("persists only safe metadata and never raw payloads or errors",()=>{
    const value=normalizeLog({category:"TASK",operation:"file.parse",status:"FAILED",errorCode:"Bearer secret\npassword=abc",durationMs:-5,password:"private",body:{content:"document text"},headers:{authorization:"secret"},message:"raw error"} as any);
    expect(value.errorCode).toBe("INTERNAL_ERROR");expect(value.durationMs).toBe(0);
    const text=JSON.stringify(value);for(const secret of ["secret","password","document text","raw error"])expect(text).not.toContain(secret);
    expect(value.createdAt).toBeInstanceOf(Date);expect(value.traceId).toBeTruthy();
  });
  it("does not propagate storage failure into business operations",async()=>{
    const error=vi.spyOn(console,"error").mockImplementation(()=>{}),info=vi.spyOn(console,"info").mockImplementation(()=>{});
    const detach=attachLogSink(async()=>{throw new Error("database-password-secret");});
    try{expect(()=>writeLog({category:"OPERATION",operation:"test.write",status:"COMPLETED"})).not.toThrow();await flushLogs();expect(error.mock.calls.flat().join(' ')).not.toContain("database-password-secret");}
    finally{detach();error.mockRestore();info.mockRestore();}
  });
  it("validates dates, enums, page sizes and retains user scope with search",()=>{
    expect(()=>logQuerySchema.parse({level:"debug"})).toThrow();expect(()=>logQuerySchema.parse({limit:1000})).toThrow();
    expect(()=>logQuerySchema.parse({from:"2026-10-03T00:00:00Z",to:"2026-10-01T00:00:00Z"})).toThrow();
    const query=logQuerySchema.parse({q:"reference",userId:"another-user"});expect(query).not.toHaveProperty('userId');
    const where=logWhere("current-user",query);expect(where.userId).toBe("current-user");expect(where.OR).toHaveLength(4);
  });
  it("applies the retention cutoff even before cleanup and never deletes business tables",async()=>{
    const deleteMany=vi.fn(async()=>({count:2}));const service=new LogsService({activityLog:{deleteMany}} as any);
    await service.cleanup();const cutoff=deleteMany.mock.calls[0] as unknown as [{where:{createdAt:{lt:Date}}}];
    expect(Date.now()-cutoff[0].where.createdAt.lt.valueOf()).toBeGreaterThanOrEqual(retentionDays()*86400000);
    const where=logWhere("user",logQuerySchema.parse({from:"2000-01-01T00:00:00Z"}));
    expect((where.createdAt as {gte:Date}).gte.getFullYear()).toBeGreaterThan(2000);
  });
  it("does not reveal another user's log through the detail endpoint",async()=>{
    const findFirst=vi.fn(async()=>null);const service=new LogsService({activityLog:{findFirst}} as any);
    await expect(service.detail("owner","00000000-0000-4000-a000-000000000001")).rejects.toMatchObject({status:404});
    expect((findFirst.mock.calls[0] as any)[0].where.userId).toBe("owner");
  });
});
