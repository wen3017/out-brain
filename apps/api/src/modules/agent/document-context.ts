import type { DocumentOverview } from "../files/retrieval.service.js";

export function isDocumentOverviewRequest(content: string): boolean {
  return /^(?:请|帮我|你|先|给我|能否|可以)?(?:读(?:一下|一遍)?|看(?:一下|一遍)?|浏览|总结|概括|介绍)(?:下|一下)?(?:当前|这份|这个|已上传的|上传的|会话里的)?(?:文件|文档|PDF|资料)(?:内容)?[。！!?？\s]*$/i.test(content.trim());
}

export function documentOverviewContext(overview: DocumentOverview): string {
  const inventory = overview.files.map(file => `${file.name}（状态 ${file.status}，已解析 ${file.pages} 页）`).join("；");
  const excerpts = overview.excerpts.map(item => `[${item.fileName} 第${item.pageStart}页摘录] ${item.content}`).join("\n\n");
  return `以下是本轮从数据库实时读取的当前会话文件清单，优先于旧聊天记录和旧工具结果。文件清单：${inventory || "无 PDF"}。${overview.files.length ? "禁止声称本会话没有上传文件或文件数量为 0。" : "当前会话确实没有上传 PDF。"}状态不是 READY 或 PARTIAL 的文件尚不可读，必须明确指出。${excerpts ? `以下是覆盖 ${overview.sampledPages}/${overview.totalPages} 页的有限摘录，并非全文；只能据此概览，不得声称逐字读完：\n${excerpts}` : "当前没有可读取的正文摘录，不得猜测文件内容。"}`;
}
