import { confirmedMemoryInput, explicitlyAdoptsProposal } from "../src/modules/memories/confirmed-input.js";
import { presentationTextNodes } from "../src/modules/presentations/presentation-grounding.js";
import { describe, expect, it, vi } from "vitest";
import { FilesService } from "../src/modules/files/files.service.js";
import { readableFileName } from "../src/modules/files/filename.js";
import { MemoriesService } from "../src/modules/memories/memories.service.js";
import { TodosService } from "../src/modules/todos/todos.service.js";
import { AgentRuntimeService } from "../src/modules/agent/agent-runtime.service.js";
import { PresentationsService } from "../src/modules/presentations/presentations.service.js";
import { safeErrorMeta } from "../src/common/safe-error.js";
import { JobsService } from "../src/infra/jobs.service.js";
import { MeetingsService } from "../src/modules/meetings/meetings.service.js";
import { z } from "zod";
import { presentationSchema } from "@nbboss/contracts";

describe("file safety", () => {
  it("restores Chinese multipart filenames without changing valid filenames", () => {
    const original = "Java_AI工程岗位高频面试题与追问答案.pdf";
    expect(readableFileName(Buffer.from(original).toString("latin1"))).toBe(original);
    expect(readableFileName(original)).toBe(original);
    expect(readableFileName("résumé.pdf")).toBe("résumé.pdf");
  });
  const service = new FilesService({} as any, { assertOwned: vi.fn(async () => ({mode:"MEETING"})) } as any, {} as any, {} as any);
  it("rejects a PDF extension with a forged MIME type", async () => {
    await expect(service.save("u", "c", { originalname: "attack.pdf", mimetype: "text/plain", size: 5, buffer: Buffer.from("hello") } as any)).rejects.toMatchObject({ status: 400 });
  });
  it("rejects a fake PDF signature", async () => {
    await expect(service.save("u", "c", { originalname: "attack.pdf", mimetype: "application/pdf", size: 5, buffer: Buffer.from("hello") } as any)).rejects.toMatchObject({ status: 400 });
  });
  it("rejects invalid UTF-8 text", async () => {
    await expect(service.save("u", "c", { originalname: "bad.txt", mimetype: "text/plain", size: 2, buffer: Buffer.from([0xc3, 0x28]) } as any)).rejects.toMatchObject({ status: 400 });
  });
  it("rejects long TXT before creating an asset rather than discarding its tail",async()=>{
    const buffer=Buffer.from("正".repeat(120001));
    await expect(service.save("u","c",{originalname:"long.txt",mimetype:"text/plain",size:buffer.length,buffer} as any)).rejects.toThrow("120,000");
  });
  it("rejects TXT uploads outside meeting mode", async () => {
    const chatService = new FilesService({} as any, { assertOwned: vi.fn(async () => ({ mode: "CHAT" })) } as any, {} as any, {} as any);
    await expect(chatService.save("u", "c", { originalname: "notes.txt", mimetype: "text/plain", size: 5, buffer: Buffer.from("hello") } as any)).rejects.toMatchObject({ status: 400 });
  });
});

describe("meeting upload scheduling", () => {
  it("debounces a batch of parsed TXT files under one conversation key", async () => {
    const service = new JobsService({} as any);
    const add = vi.spyOn(service.queue, "add").mockResolvedValue({ id: "job" } as never);
    try {
      await service.analyzeMeetingAfterUpload("user", "conversation");
      expect(add).toHaveBeenCalledWith("meeting.analyze", { userId: "user", conversationId: "conversation", force: false }, expect.objectContaining({
        delay: 2_000,
        deduplication: { id: "meeting-upload-conversation", ttl: 2_000, extend: true, replace: true },
      }));
    } finally {
      await service.onModuleDestroy();
    }
  });
});

describe("meeting structured-output normalization", () => {
  it("normalizes provider business dates before strict domain validation", () => {
    const service = Object.create(MeetingsService.prototype) as any;
    const output = service.normalizeAnalysisDates({ meetings: [{ risks: [
      { todo: { dueAt: "2026-10-01" } },
      { todo: { dueAt: "2026年10月2日" } },
      { todo: { dueAt: "待确认" } },
    ] }] });
    expect(output.meetings[0].risks.map((risk: any) => risk.todo.dueAt)).toEqual([
      "2026-10-01T00:00:00.000Z",
      "2026-10-01T16:00:00.000Z",
      null,
    ]);
  });
});

describe("agent tool exposure policy", () => {
  const service = Object.create(AgentRuntimeService.prototype) as any;
  it("only recognizes explicit presentation requests", () => {
    expect(service.wantsPresentation("请基于当前会话生成一份 PPT")).toBe(true);
    expect(service.wantsPresentation("帮我制作演示文稿")).toBe(true);
    expect(service.wantsPresentation("总结一下刚才的内容")).toBe(false);
    expect(service.wantsPresentation("不要生成 PPT")).toBe(false);
    expect(service.wantsPresentation("PPT 是什么？")).toBe(false);
    expect(service.wantsPresentation("按刚才要求生成三页",["我要做一份星辰项目 PPT"])) .toBe(true);
    expect(service.wantsPresentation("按刚才要求生成三页",[])).toBe(false);
  });
  it("uses the latest PDF deck request without mixing in an older project brief", () => {
    const history = ["开放实操题：系统要支持 PPT", "请读取论文"];
    expect(service.presentationRequirements("基于这个 PDF 生成一份 PPT", history)).toEqual(["基于这个 PDF 生成一份 PPT"]);
    expect(service.presentationRequirements("按刚才要求改成三页", ["做一份论文 PPT"])) .toEqual(["做一份论文 PPT", "按刚才要求改成三页"]);
  });
  it("exposes memory without a trigger word and reads current meetings without reanalysis", async () => {
    const jobs = { analyzeMeeting: vi.fn() };
    const findMany = vi.fn(async (_args: any) => [{ title: "周会", todos: [{ owner: "张总" }] }]);
    const runtime = new AgentRuntimeService({ fileAsset: { count: async () => 0 }, meeting: { findMany } } as any, { assertOwned: async () => ({ mode: "MEETING", meetingStatus: "READY" }) } as any, {} as any, {} as any, {} as any, { available: () => false } as any, {} as any, {} as any, jobs as any);
    const tools = await (runtime as any).tools({ userId: "u", conversationId: "c", content: "张总负责哪个项目？", webSearch: false }, () => {});
    expect(tools.some((t: any) => t.name === "retrieve_memory")).toBe(true);
    const result = await tools.find((t: any) => t.name === "read_meetings").execute();
    expect(result.content[0].text).toContain("张总");
    expect(findMany.mock.calls[0][0].where).toMatchObject({ conversation: { userId: "u" }, conversationId: "c" });
    expect(jobs.analyzeMeeting).not.toHaveBeenCalled();
  });
});

describe("presentation request parsing", () => {
  const service = Object.create(PresentationsService.prototype) as any;
  it("recognizes Arabic and Chinese requested page counts", () => {
    expect(service.requestedSlideCount("生成 4 页 PPT")).toBe(4);
    expect(service.requestedSlideCount("做一份十二页的演示文稿")).toBe(12);
    expect(service.requestedSlideCount("制作二十三页 PPT")).toBe(23);
    expect(service.requestedSlideCount("生成专业 PPT")).toBeNull();
    expect(service.requestedSlideCount("原计划八页，现在改为三页")).toBe(3);
  });

  it("normalizes common provider color and canvas variants before validation", () => {
    const service = Object.create(PresentationsService.prototype) as any;
    const normalized = service.normalizePresentationOutput({ title: "deck", slides: [{ id: "s", title: "slide", notes: "", elements: [{
      id: "e", type: "shape", text: "", x: -2, y: 7.45, w: 20, h: 5, fontSize: 100, color: "#abc", fill: "#7c3aed",
    }] }] });
    const element = normalized.slides[0].elements[0];
    expect(element).toMatchObject({ x: 0, y: 7.4, w: 13.333, fontSize: 72, color: "AABBCC", fill: "7C3AED" });
    expect(element.h).toBeCloseTo(0.1);
    expect(() => presentationSchema.parse(normalized)).not.toThrow();
  });

  it("returns the winning presentation when concurrent idempotent creation races", async () => {
    const existing = { id: "p1", conversationId: "c1", status: "PENDING" };
    const findFirst = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(existing);
    const create = vi.fn(async () => { throw Object.assign(new Error("unique"), { code: "P2002" }); });
    const jobs = { generatePresentation: vi.fn() };
    const service = new PresentationsService(
      { fileAsset: { count: async()=>0 }, presentation: { findFirst, create } } as any,
      {} as any,
      { assertOwned: vi.fn(async () => ({ id: "c1" })) } as any,
      jobs as any,
      {} as any,
    );
    await expect(service.request("u1", "c1", "deck", "c1:key")).resolves.toBe(existing);
    expect(create).toHaveBeenCalledOnce();
    expect(jobs.generatePresentation).not.toHaveBeenCalled();
  });

  it("enforces requested and default slide-count bounds on structured output", async () => {
    const slide = (index: number) => ({ id: `s${index}`, title: `第 ${index} 页`, notes: "", elements: [{ id: `e${index}`, type: "text", text: "内容", x: 1, y: 1, w: 4, h: 1, fontSize: 20, color: "111827", bold: false }] });
    const contextDb = {
      documentPage: { findMany: async()=>[] }, fileAsset: { count: async()=>0 }, message: { findMany: vi.fn(async () => []) }, documentChunk: { findMany: vi.fn(async () => []) },
      searchRun: { findMany: vi.fn(async () => []) }, meeting: { findMany: vi.fn(async () => []) },
    };
    const output = { title: "测试", slides: Array.from({ length: 8 }, (_, index) => slide(index + 1)) };
    const models = { runStructuredAgent: vi.fn(async (_system:string,request:string,tool:string) => tool==="review_presentation_facts"
      ? {items:(JSON.parse(request.slice(request.lastIndexOf("待审文字：\n")+"待审文字：\n".length)) as Array<{key:string;text:string}>).map(({key,text})=>({key,text,kind:"HEADING",evidence:""}))}
      : output) };
    const service = new PresentationsService(contextDb as any, models as any, {} as any, {} as any, {} as any);
    await expect((service as any).createDocument("u", "c", "生成专业 PPT", async () => {})).resolves.toMatchObject({ slides: expect.any(Array) });
    expect(models.runStructuredAgent.mock.calls.filter(call => call[2] === "review_presentation_facts")).toHaveLength(4);
    await expect((service as any).createDocument("u", "c", "生成十二页 PPT", async () => {})).rejects.toThrow("未满足指定的 12 页");
    output.slides = Array.from({ length: 5 }, (_, index) => slide(index + 1));
    await expect((service as any).createDocument("u", "c", "生成专业 PPT", async () => {})).rejects.toThrow("6-12 页");
  });

  it("repairs overflowing or overlapping PPT text boxes without dropping content",()=>{
    const service=Object.create(PresentationsService.prototype) as any;
    const document={title:"test",slides:[{id:"s",title:"test",notes:"",elements:[{id:"a",type:"text",text:"项目标题",x:.5,y:.3,w:12,h:.1,fontSize:28,color:"111111",bold:true},{id:"b",type:"text",text:"负责人：王芳\n截止日期：待确认",x:.5,y:7.4,w:12,h:.1,fontSize:12,color:"111111",bold:false}]}]};
    service.ensureReadableLayout(document);
    const [a,b]=document.slides[0].elements;
    expect(b.text).toContain("负责人：王芳");expect(a.y+a.h).toBeLessThan(b.y);expect(b.y+b.h).toBeLessThan(7.5);expect(b.fontSize).toBeGreaterThanOrEqual(16);
  });

  it("excludes unrelated chat history when the deck is explicitly based on a PDF", async () => {
    const db={fileAsset:{count:async()=>0},message:{findMany:async()=>[{role:"USER",content:"旧项目：AI 外脑 Demo 需求"}]},
      documentChunk:{findMany:async()=>[{content:"Multi-UAV cooperative path planning balances efficiency and fairness.",pageStart:1,file:{originalName:"paper.pdf"}}]},
      searchRun:{findMany:async()=>[]},meeting:{findMany:async()=>[]},documentPage:{findMany:async()=>[]}};
    const models={runStructuredAgent:vi.fn(async(_system:string,request:string)=>{
      expect(request).toContain("Multi-UAV cooperative path planning");
      expect(request).not.toContain("旧项目：AI 外脑 Demo 需求");
      throw new Error("checked prompt scope");
    })};
    const service=new PresentationsService(db as any,models as any,{} as any,{} as any,{} as any);
    await expect((service as any).createDocument("u","c","基于当前 PDF 生成 1 页 PPT",async()=>{})).rejects.toThrow("checked prompt scope");
  });

  it("keeps long verified slide text in notes while fitting a short excerpt",()=>{
    const service=Object.create(PresentationsService.prototype) as any;
    const original="A source-backed sentence about cooperative UAV path planning. ".repeat(8);
    const document={title:"UAV",slides:[{id:"s",title:"UAV",notes:"",elements:[{id:"e",type:"text",text:original,x:1,y:1,w:8,h:1,fontSize:20,color:"111111",bold:false}]}]};
    service.compactSlideText(document);
    expect(document.slides[0].elements[0].text.length).toBeLessThanOrEqual(150);
    expect(document.slides[0].notes).toContain(original);
  });
  it("turns a compact model outline into an editable deck",()=>{
    const service=Object.create(PresentationsService.prototype) as any;
    const document=service.fromCompactPresentation({title:"多无人机路径规划",slides:[{title:"研究问题",bullets:["效率与公平性", "任务分配"]}]});
    expect(()=>presentationSchema.parse(document)).not.toThrow();
    expect(document.slides[0].elements.filter((element:any)=>element.type==="text")).toHaveLength(3);
    expect(document.slides[0].elements[1].text).toContain("效率与公平性");
  });

  it("keeps a transient PPT failure retryable without leaking provider diagnostics", async () => {
    const updates: any[] = [];
    const prisma = {
      presentation: {
        findFirst: vi.fn(async () => ({ id: "p", conversationId: "c", requestedPrompt: "deck", status: "PENDING", versions: [] })),
        update: vi.fn(async ({ data }: any) => { updates.push(data); return { id: "p", ...data }; }),
      },
      documentPage: { findMany: async()=>[] }, fileAsset: { count: async()=>0, findMany: async()=>[] }, message: { findMany: vi.fn(async () => []) }, documentChunk: { findMany: vi.fn(async () => []) },
      searchRun: { findMany: vi.fn(async () => []) }, meeting: { findMany: vi.fn(async () => []) },
    };
    const secret = "provider-secret-diagnostic";
    const service = new PresentationsService(prisma as any, { runStructuredAgent: vi.fn(async () => { throw new Error(secret); }) } as any, {} as any, {} as any, {} as any);
    const logger = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(service.process("u", "p")).rejects.toThrow(secret);
    expect(updates.at(-1)).toMatchObject({ progress: 20 });
    expect(updates.some((update) => update.status === "FAILED")).toBe(false);
    expect(JSON.stringify(updates)).not.toContain(secret);
    expect(logger.mock.calls.flat().join(" ")).not.toContain(secret);
  });

  it("corrects non-contiguous PPT evidence once without accepting invalid quotes",async()=>{
    const source="甲型设备 3 台，单价 1200 元/台。";
    const document={title:"采购",slides:[{id:"s",title:"采购",notes:"",elements:[{id:"e",type:"text",text:source,x:1,y:1,w:8,h:1,fontSize:20,color:"111111",bold:false}]}]};
    const db={fileAsset:{count:async()=>0},message:{findMany:async()=>[{role:"USER",content:source}]},documentChunk:{findMany:async()=>[]},searchRun:{findMany:async()=>[]},meeting:{findMany:async()=>[]},documentPage:{findMany:async()=>[]}};
    let reviewCount=0,alwaysInvalid=false;
    const models={runStructuredAgent:vi.fn(async(_system:string,prompt:string,tool:string)=>{
      if(tool!=="review_presentation_facts")return structuredClone(document);
      reviewCount++;
      if(reviewCount>1)expect(prompt).toContain("无效引文");
      return {items:presentationTextNodes(document as any).map(({key,text})=>({key,text,kind:key==="0/element/0"?"FACT":"HEADING",evidence:key==="0/element/0"?(reviewCount===1||alwaysInvalid?"甲型设备3台单价1200元":source):""}))};
    })};
    const service=new PresentationsService(db as any,models as any,{} as any,{} as any,{} as any);
    await expect((service as any).createDocument("u","c","生成 1 页 PPT",async()=>{})).resolves.toMatchObject({title:"采购"});
    expect(reviewCount).toBe(2);
    reviewCount=0;alwaysInvalid=true;
    const conservative = await (service as any).createDocument("u","c","生成 1 页 PPT",async()=>{});
    expect(conservative.slides[0].elements.some((element:any)=>element.type==="text"&&element.text.includes("待确认"))).toBe(true);
    expect(reviewCount).toBe(2);
  });

  it("keeps PPT generation safe when a provider never submits the review structure",async()=>{
    const document={title:"采购",slides:[{id:"s",title:"采购",notes:"",elements:[{id:"e",type:"text",text:"张总已审批采购",x:1,y:1,w:8,h:1,fontSize:20,color:"111111",bold:false}]}]};
    const db={fileAsset:{count:async()=>0},message:{findMany:async()=>[]},documentChunk:{findMany:async()=>[]},searchRun:{findMany:async()=>[]},meeting:{findMany:async()=>[]},documentPage:{findMany:async()=>[]}};
    const models={runStructuredAgent:vi.fn(async(_system:string,_prompt:string,tool:string)=>{
      if(tool==="review_presentation_facts")throw new Error("模型未返回符合 review_presentation_facts 结构的结果");
      return structuredClone(document);
    })};
    const service=new PresentationsService(db as any,models as any,{} as any,{} as any,{} as any);
    const result=await (service as any).createDocument("u","c","生成 1 页 PPT",async()=>{});
    expect(result.slides[0].elements.some((element:any)=>element.type==="text"&&element.text.includes("待确认"))).toBe(true);
  });

  it("corrects invisible text on the slide background while retaining white text on dark panels",()=>{
    const service=Object.create(PresentationsService.prototype) as any;
    const element={id:"a",type:"text",text:"数量（台）",x:1,y:1,w:3,h:1,fontSize:20,color:"FFFFFF",bold:true};
    const document={title:"表格",slides:[{id:"s",title:"表格",notes:"",elements:[{...element},{id:"panel",type:"shape",text:"",x:1,y:3,w:5,h:2,fontSize:20,color:"111827",fill:"111827",bold:false},{...element,id:"b",y:3.5}]}]};
    service.ensureReadableLayout(document);
    expect(document.slides[0].elements[0].color).toBe("111827");
    expect(document.slides[0].elements[2].color).toBe("FFFFFF");
  });

  it("rejects a deck if its source pages change during generation and records stable snapshots", async () => {
    let pageText = "原始材料";
    const prisma = {
      presentation: { findFirst: async()=>({id:"p",conversationId:"c",requestedPrompt:"生成 PPT",status:"PENDING",versions:[]}), update: vi.fn(async({data}:any)=>data) },
      fileAsset: {findMany: async()=>[{id:"f",sha256:"same-upload",status:"READY",pages:[{pageNo:1,text:pageText,qualityStatus:"OK"}]}]},
    };
    const service = new PresentationsService(prisma as any,{} as any,{} as any,{} as any,{} as any);
    const save = vi.spyOn(service,"saveVersion").mockResolvedValue({} as any);
    (service as any).createDocument = async()=>{pageText="重新解析后的材料";return {title:"测试"};};
    await expect(service.process("u","p")).rejects.toThrow("材料发生变化");
    expect(save).not.toHaveBeenCalled();
    (service as any).createDocument = async()=>({title:"测试"});
    await expect(service.process("u","p")).resolves.toMatchObject({status:"READY"});
    expect(save.mock.calls[0][4]).toEqual([{id:"f",sha256:"same-upload",status:"READY",parsedSha256:expect.stringMatching(/^[a-f0-9]{64}$/)}]);
  });
});

describe("safe logging", () => {
  it("classifies provider failures without returning sensitive messages", () => {
    const secret = "super-secret-provider-key";
    const meta = safeErrorMeta(new Error(`HTTP 429 authorization=${secret}`));
    expect(meta).toEqual({ name: "Error", errorCode: "RATE_LIMITED" });
    expect(JSON.stringify(meta)).not.toContain(secret);
  });
  it("classifies schema failures as invalid provider responses", () => {
    const failure = z.object({ dueAt: z.string().datetime() }).safeParse({ dueAt: "not-a-date" });
    if (failure.success) throw new Error("fixture must fail");
    expect(safeErrorMeta(failure.error).errorCode).toBe("INVALID_RESPONSE");
  });
});

describe("memory task compensation",()=>{
  it("persists queue failure separately from the successful source and keeps retry ownership scoped",async()=>{
    const updateMany=vi.fn(async()=>({count:1}));
    const prisma={memoryExtraction:{upsert:vi.fn(async()=>({id:"task",status:"PENDING"})),updateMany,findFirst:vi.fn(async()=>null)}};
    const jobs=new JobsService(prisma as any);
    vi.spyOn(jobs.queue,"getJob").mockRejectedValue(new Error("queue offline"));
    try{
      await expect(jobs.extractMemory("user","CONVERSATION","run","事实",new Date())).rejects.toThrow("queue offline");
      expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({where:{id:"task",userId:"user"},data:expect.objectContaining({status:"FAILED"})}));
      await expect(jobs.retryMemoryTask("attacker","task")).rejects.toMatchObject({status:404});
      expect(prisma.memoryExtraction.findFirst).toHaveBeenCalledWith({where:{id:"task",userId:"attacker"}});
    }finally{await jobs.onModuleDestroy();}
  });
});

describe("memory conflict policy", () => {
  const fact = { entityType: "PERSON", entityName: "项目", attribute: "负责人", value: "王芳", confidence: 0.9, effectiveAt: null } as const;
  function fixture(current: any) {
    const rows = current ? [{ entityId: "entity", attribute: "负责人", confidence: 0.8, sourceType: "OLD", sourceId: "old", supersededById: null, createdAt: new Date("2026-01-02"), ...current }] : [];
    const create = vi.fn(async ({ data }: any) => { const value = { id: `new${rows.some(r => r.id === "new") ? "-" + rows.length : ""}`, userEdited: false, supersededById: null, createdAt: new Date("2026-04-01"), ...data }; rows.push(value); return value; });
    const update = vi.fn(async ({ where, data }: any) => { const row = rows.find((item) => item.id === where.id); if (row) Object.assign(row, data); return row; });
    const updateMany = vi.fn(async ({ data }: any) => { rows.forEach((row) => Object.assign(row, data)); return { count: rows.length }; });
    const tx = { memoryEntity: { findFirst: vi.fn(async () => ({ id: "entity", forgottenAt: null })) }, memoryFact: { findMany: vi.fn(async () => [...rows]), create, update, updateMany } };
    const prisma = { memoryEntity: { upsert: vi.fn(async () => ({ id: "entity" })) }, $transaction: (fn: any) => fn(tx) };
    const redis = { acquire: vi.fn(async () => "lock"), release: vi.fn(async () => undefined) };
    return { service: new MemoriesService(prisma as any, {} as any, redis as any), create, update, rows };
  }
  it("supersedes an older automatic value", async () => {
    const { service, create, rows } = fixture({ id: "old", value: "李明", userEdited: false, effectiveAt: null, observedAt: new Date("2026-01-01") });
    await (service as any).upsertFact("u", "CONVERSATION", "run", new Date("2026-02-01"), fact);
    expect(create).toHaveBeenCalledOnce(); expect(rows.find((row) => row.id === "old")?.supersededById).toBe("new"); expect(rows.find((row) => row.id === "new")?.supersededById).toBeNull();
  });
  it("keeps a user-edited value current while retaining automatic facts as history", async () => {
    const { service, create, rows } = fixture({ id: "old", value: "李明", userEdited: true, effectiveAt: null, observedAt: new Date("2026-01-01") });
    await (service as any).upsertFact("u", "CONVERSATION", "run", new Date("2026-02-01"), fact);
    expect(create).toHaveBeenCalledOnce(); expect(rows.find((row) => row.id === "new")?.supersededById).toBe("old"); expect(rows.find((row) => row.id === "old")?.supersededById).toBeNull();
  });
  it("retains a late-running older extraction without replacing the newer current fact", async () => {
    const { service, create, rows } = fixture({ id: "newer", value: "李明", userEdited: false, effectiveAt: null, observedAt: new Date("2026-03-01") });
    await (service as any).upsertFact("u", "CONVERSATION", "run", new Date("2026-02-01"), fact);
    expect(create).toHaveBeenCalledOnce(); expect(rows.find((row) => row.id === "new")?.supersededById).toBe("newer"); expect(rows.find((row) => row.id === "newer")?.supersededById).toBeNull();
  });
  it("accepts A to B to A as separate snapshots, but deduplicates the same snapshot retry", async () => {
    const {service,rows,create}=fixture(null);
    await (service as any).upsertFact("u","MEETING","meeting",new Date("2026-01-01"),{...fact,value:"南京"});
    await (service as any).upsertFact("u","MEETING","meeting",new Date("2026-02-01"),{...fact,value:"上海"});
    await (service as any).upsertFact("u","MEETING","meeting",new Date("2026-03-01"),{...fact,value:"南京"});
    await (service as any).upsertFact("u","MEETING","meeting",new Date("2026-03-01"),{...fact,value:"南京"});
    expect(create).toHaveBeenCalledTimes(3);
    expect(rows.filter(r=>r.supersededById===null).map(r=>r.value)).toEqual(["南京"]);
  });
  it("does not recreate a forgotten entity when an old extraction arrives", async () => {
    const prisma={memoryEntity:{upsert:vi.fn(async()=>({id:"entity",forgottenAt:new Date()}))},$transaction:vi.fn()};
    const service=new MemoriesService(prisma as any,{} as any,{} as any);
    await (service as any).upsertFact("u","MEETING","meeting",new Date(),fact);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it("does not resurrect memory when its queued source has been deleted", async () => {
    const models = { runStructuredAgent: vi.fn() };
    const service = new MemoriesService({ agentRun: { findFirst: vi.fn(async () => null) } } as any, models as any, {} as any);
    await service.extract("u", "CONVERSATION", "deleted-run", "这是一个长度足够但来源已经删除的对话内容，不应再生成任何长期记忆。", new Date());
    expect(models.runStructuredAgent).not.toHaveBeenCalled();
  });
});

describe("tenant scoping", () => {
  it("updates a todo only after a user-scoped lookup", async () => {
    const update = vi.fn();
    const prisma = { todo: { findFirst: vi.fn(async ({ where }: any) => where.userId === "owner" ? { id: "t" } : null), update } };
    const service = new TodosService(prisma as any);
    await expect(service.update("attacker", "t", { status: "COMPLETED" })).rejects.toMatchObject({ status: 404 });
    expect(update).not.toHaveBeenCalled();
  });
});


describe("explicit proposal confirmation",()=>{
  it("only promotes an explicitly adopted proposal into future-plan evidence",()=>{
    const proposal="建议王芳负责验收方案，下周五提交。";
    expect(explicitlyAdoptsProposal("我确认采用你刚才的建议")).toBe(true);
    expect(confirmedMemoryInput("我确认采用你刚才的建议",proposal)).toContain("已确认的未来计划");
    for(const text of ["好的","是否确认采用你的建议？","我不确认采用上述方案","假设确认采用你的建议会怎样？"]){expect(explicitlyAdoptsProposal(text)).toBe(false);expect(confirmedMemoryInput(text,proposal)).toBe(text);}
  });
});
