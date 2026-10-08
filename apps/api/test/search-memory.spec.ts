import { afterEach, describe, expect, it, vi } from "vitest";
import { searchPolicy } from "../src/modules/search/search-policy.js";
import { timeContext } from "../src/common/time-context.js";
import { MemoriesService } from "../src/modules/memories/memories.service.js";
import { AgentRuntimeService } from "../src/modules/agent/agent-runtime.service.js";

afterEach(() => vi.unstubAllEnvs());

describe("search policy and time context", () => {
  it.each(["今天有哪些科技新闻？", "今年最新的行业政策是什么？", "帮我联网查一下官网", "What is the current exchange rate?"])("automatically searches %s", text => {
    expect(searchPolicy(text).required).toBe(true);
    expect(searchPolicy(text, false).required).toBe(false);
    expect(searchPolicy(text, "off").required).toBe(false);
  });
  it.each(["你好", "解释二分查找", "请记住我下周五去上海开会", "仅根据文件总结今年的风险", "不要联网，解释最新这个词", "今天我去上海开会", "我们项目目前的待办有哪些", "今天是几号"])("keeps local tasks offline: %s", text => {
    expect(searchPolicy(text).required).toBe(false);
  });
  it("force-on searches non-time-sensitive queries, but respects an explicit prohibition", () => {
    expect(searchPolicy("比较两种排序算法", "on").required).toBe(true);
    expect(searchPolicy("不要联网，比较两种排序算法", "on").required).toBe(false);
  });
  it("fails clearly before inference if live information cannot be retrieved", async () => {
    const runtime = new AgentRuntimeService({} as any, {} as any, {} as any, {} as any, {} as any, {available:()=>false} as any, {} as any, {} as any, {} as any);
    await expect(runtime.run({userId:"u",conversationId:"c",content:"今天的新闻",webSearch:"auto"},()=>{})).rejects.toThrow("未取得实时证据");
  });
  it("uses Shanghai calendar boundaries and safely handles invalid time zones", () => {
    vi.stubEnv("APP_TIME_ZONE", "invalid");
    const context = timeContext(new Date("2026-10-07T17:00:00Z"));
    expect(context).toMatch(/2026(?:年|\/)10(?:月|\/)08/);
    expect(context).toContain("Asia/Shanghai");
  });
});

describe("short and contextual memory", () => {
  function fixture(output: unknown, context: unknown[] = []) {
    const models = {runStructuredAgent: vi.fn(async () => output)};
    const prisma = {agentRun:{findFirst:vi.fn(async()=>({id:"run",conversationId:"c",createdAt:new Date("2026-10-07T01:00:00Z")}))},message:{findMany:vi.fn(async()=>context)}};
    const service = new MemoriesService(prisma as any, models as any, {} as any);
    const saved = vi.spyOn(service as any, "upsertFact").mockResolvedValue(undefined);
    return {service, models, prisma, saved};
  }
  it.each(["我叫张三", "我在上海工作", "张总负责星辰项目"])("extracts useful short inputs: %s", async text => {
    const f = fixture({facts:[{entityType:"PERSON",entityName:"当前用户",attribute:"事实",value:text,confidence:1,effectiveAt:null,kind:"STATE",evidence:text}]});
    await f.service.extract("u","CONVERSATION","run",text);
    expect(f.saved).toHaveBeenCalledOnce();
  });
  it("uses only preceding user turns from the same owned conversation", async () => {
    const f = fixture({facts:[]}, [{content:"张三负责验收，原定周四提交。",createdAt:new Date("2026-10-06")}]);
    await f.service.extract("u","CONVERSATION","run","他改到周五了",new Date("2026-10-07T01:00:00Z"));
    expect(f.prisma.message.findMany).toHaveBeenCalledWith(expect.objectContaining({where:{conversationId:"c",conversation:{userId:"u"},role:"USER",createdAt:{lt:new Date("2026-10-07T01:00:00Z")}}}));
    expect(f.models.runStructuredAgent.mock.calls[0]).toEqual(expect.arrayContaining([expect.stringContaining("张三负责验收")]));
    expect(f.models.runStructuredAgent.mock.calls[0]).toEqual(expect.arrayContaining([expect.stringContaining("2026-10-07T01:00:00.000Z")]));
  });
  it("rejects evidence copied only from prior turns, even when relevant", async () => {
    const f = fixture({facts:[{evidence:"张三负责验收"}]},[{content:"张三负责验收",createdAt:new Date("2026-10-06")}]);
    await expect(f.service.extract("u","CONVERSATION","run","他改到周五了")).rejects.toThrow("MEMORY_EVIDENCE_MISMATCH");
    expect(f.saved).not.toHaveBeenCalled();
  });
  it("allows no facts for greetings and rejects whitespace without calling a model", async () => {
    const f = fixture({facts:[]});
    await f.service.extract("u","CONVERSATION","run","好的");
    await f.service.extract("u","CONVERSATION","run","  ");
    expect(f.models.runStructuredAgent).toHaveBeenCalledOnce();
    expect(f.saved).not.toHaveBeenCalled();
  });
});
