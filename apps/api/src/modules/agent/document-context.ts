import type { DocumentOverview } from "../files/retrieval.service.js";

export function isDocumentOverviewRequest(content: string): boolean {
  return /^(?:请|帮我|你|先|给我|能否|可以)?(?:读|读取|阅读|看|查看|浏览|总结|概括|介绍|分析)(?:下|一下|一遍)?(?:当前|这份|这个|已上传的|上传的|会话里的)?(?:文件|文档|PDF|资料|材料|论文)(?:内容)?[。！!?？\s]*$/i.test(content.trim());
}

export function documentInventoryContext(files: DocumentOverview["files"]): string {
  if (!files.length) return "当前会话没有上传 PDF。";
  const inventory = files.map(file => `${file.name}（状态 ${file.status}，已解析 ${file.pages} 页）`).join("；");
  return `本轮从数据库实时读取的当前会话文件清单：${inventory}。此清单优先于旧聊天记录和旧工具结果；禁止声称本会话没有上传文件或文件数量为 0。状态不是 READY 或 PARTIAL 的文件尚不可读。`;
}

export function documentOverviewContext(overview: DocumentOverview): string {
  const excerpts = overview.excerpts.map(item => `[${item.fileName} 第${item.pageStart}页摘录] ${item.content}`).join("\n\n");
  return `${documentInventoryContext(overview.files)}${excerpts ? `以下是覆盖 ${overview.sampledPages}/${overview.totalPages} 页的有限摘录，并非全文；只能据此概览，不得声称逐字读完：\n${excerpts}` : "当前没有可读取的正文摘录，不得猜测文件内容。"}`;
}
