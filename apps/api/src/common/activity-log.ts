import { createHash, randomUUID } from "node:crypto";

export type LogInput = {
  userId?: string; level?: "INFO" | "WARN" | "ERROR";
  category: "OPERATION" | "TASK" | "CONVERSATION" | "SYSTEM";
  operation: string; status: string; traceId?: string; resourceId?: string;
  errorCode?: string; durationMs?: number; attempt?: number; httpStatus?: number;
};
type LogRecord = ReturnType<typeof normalizeLog>;
type LogSink = (record: LogRecord) => Promise<void>;
let sink: LogSink | undefined;
const pending = new Set<Promise<void>>();
let lastFailureAt = 0;

const identifier = (value: unknown, max: number) => typeof value === "string" && /^[\w.:/ -]+$/.test(value) ? value.slice(0,max) : undefined;
const number = (value?:number) => typeof value === "number" && Number.isFinite(value) ? Math.min(2147483647,Math.max(0,Math.round(value))) : undefined;

// Deliberate allowlist: never persist request bodies, cookies, headers, raw
// exceptions, prompts, tool arguments or document content in this log store.
export function normalizeLog(input:LogInput) {
  return {
    createdAt:new Date(), userId:identifier(input.userId,64),
    level:(["INFO","WARN","ERROR"].includes(input.level ?? "") ? input.level : "INFO") as "INFO"|"WARN"|"ERROR",
    service:process.env.WORKER_MODE === "true" ? "worker" : "api",
    category:["OPERATION","TASK","CONVERSATION","SYSTEM"].includes(input.category) ? input.category : "SYSTEM",
    operation:identifier(input.operation,120) ?? "unknown",
    status:typeof input.status === "string" && /^[A-Z_]{1,24}$/.test(input.status) ? input.status : "UNKNOWN",
    traceId:identifier(input.traceId,160) ?? randomUUID(), resourceId:identifier(input.resourceId,160),
    errorCode:input.errorCode ? (/^[A-Z][A-Z0-9_]{0,63}$/.test(input.errorCode) ? input.errorCode : "INTERNAL_ERROR") : undefined,
    durationMs:number(input.durationMs), attempt:number(input.attempt), httpStatus:number(input.httpStatus),
  };
}
export function attachLogSink(value:LogSink) { sink=value; return () => { if(sink===value)sink=undefined; }; }
export function writeLog(input:LogInput):void {
  const record=normalizeLog(input);
  const {userId,...publicRecord}=record;
  const line=JSON.stringify({...publicRecord,user:userId?createHash("sha256").update(userId).digest("hex").slice(0,12):undefined});
  if(record.level==="ERROR")console.error(line);else if(record.level==="WARN")console.warn(line);else console.info(line);
  if(!sink)return;
  // Logging failures never fail the business operation; bounded buffering
  // prevents an unavailable database from creating an unbounded queue.
  if(pending.size>=500){reportFailure("LOG_BUFFER_FULL");return;}
  const writer=sink;
  const write=Promise.resolve().then(()=>writer(record)).catch(()=>reportFailure("LOG_WRITE_FAILED"));
  pending.add(write);void write.finally(()=>pending.delete(write));
}
function reportFailure(errorCode:string) {
  if(Date.now()-lastFailureAt<60000)return;
  lastFailureAt=Date.now();console.error(JSON.stringify({createdAt:new Date().toISOString(),level:"ERROR",operation:"logs.persist",errorCode}));
}
export async function flushLogs() { await Promise.allSettled([...pending]); }
