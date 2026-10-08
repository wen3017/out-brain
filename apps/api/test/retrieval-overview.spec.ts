import { describe, expect, it, vi } from "vitest";
import { RetrievalService } from "../src/modules/files/retrieval.service.js";
import { AgentRuntimeService } from "../src/modules/agent/agent-runtime.service.js";
import { documentInventoryContext, documentOverviewContext, isDocumentOverviewRequest } from "../src/modules/agent/document-context.js";

describe("reading an uploaded document without search terms", () => {
  it("formats the live inventory and excerpts for a generic read request", () => {
    expect(isDocumentOverviewRequest("读一下当前文件")).toBe(true);
    expect(isDocumentOverviewRequest("读取一下当前文件")).toBe(true);
    expect(isDocumentOverviewRequest("请阅读这份论文")).toBe(true);
    expect(isDocumentOverviewRequest("分析当前PDF")).toBe(true);
    const context = documentOverviewContext({ files: [
      { id: "one", name: "ready.pdf", status: "READY", pages: 2 },
      { id: "two", name: "broken.pdf", status: "FAILED", pages: 0 },
    ], totalPages: 2, sampledPages: 1, excerpts: [
      { fileId: "one", fileName: "ready.pdf", pageStart: 1, pageEnd: 1, content: "Product plan", score: 0 },
    ] });
    expect(context).toContain("ready.pdf");
    expect(context).toContain("broken.pdf");
    expect(context).toContain("禁止声称本会话没有上传文件");
    expect(context).toContain("Product plan");
    expect(context).toContain("并非全文");
    expect(documentInventoryContext([{ id: "one", name: "ready.pdf", status: "READY", pages: 2 }])).toContain("禁止声称本会话没有上传文件");
  });
  it("samples a long document across its pages within a bounded response", async () => {
    const pages = Array.from({ length: 200 }, (_, index) => ({ pageNo: index + 1 }));
    const chunks = pages.map(page => ({ fileId: "file", pageStart: page.pageNo, pageEnd: page.pageNo, content: `page ${page.pageNo} `.repeat(100), charStart: 0 }));
    const prisma = { fileAsset: { findMany: vi.fn(async () => [{ id: "file", originalName: "report.pdf", status: "READY", pages }]) }, documentChunk: { findMany: vi.fn(async () => chunks) } };
    const result = await new RetrievalService(prisma as any, {} as any).overview("owner", "conversation");
    expect(result).toMatchObject({ totalPages: 200, sampledPages: 32 });
    expect(result.excerpts[0].pageStart).toBe(1);
    expect(result.excerpts.at(-1)?.pageStart).toBe(200);
    expect(result.excerpts.every(item => item.content.length <= 400)).toBe(true);
    expect(prisma.fileAsset.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ userId: "owner", conversationId: "conversation" }) }));
  });

  it("does not describe an uploaded file as absent when the model searches for *", async () => {
    const files = [{ originalName: "report.pdf", status: "READY", errorMessage: null }];
    const overview = { files: [{ id: "file", name: "report.pdf", status: "READY", pages: 2 }], totalPages: 2, sampledPages: 2,
      excerpts: [{ fileId: "file", fileName: "report.pdf", pageStart: 1, pageEnd: 1, content: "A product plan", score: 0 }] };
    const prisma = { fileAsset: { count: vi.fn(async () => 1), findMany: vi.fn(async () => files) } };
    const retrieval = { search: vi.fn(async () => []), overview: vi.fn(async () => overview) };
    const runtime = new AgentRuntimeService(prisma as any, { assertOwned: vi.fn(async () => ({ mode: "CHAT" })) } as any, {} as any, retrieval as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    const tools = await (runtime as any).tools({ userId: "owner", conversationId: "conversation", content: "你读一下当前文件", webSearch: false }, () => {});
    const read = tools.find((tool: { name: string }) => tool.name === "retrieve_documents");
    const response = await read.execute("call", { query: "*" });
    expect(response.content[0].text).toContain("第1页摘录");
    expect(response.content[0].text).not.toContain("资料中没有相关信息");
    expect(retrieval.overview).toHaveBeenCalledWith("owner", "conversation");
    const specificTools = await (runtime as any).tools({ userId: "owner", conversationId: "conversation", content: "文件中谁负责供应链？", webSearch: false }, () => {});
    const noMatch = await specificTools.find((tool: { name: string }) => tool.name === "retrieve_documents").execute("call", { query: "unrelated phrase" });
    expect(noMatch.content[0].text).toContain("已上传 1 个 PDF");
    expect(noMatch.content[0].text).toContain("不能声称没有上传文件");
  });
});
