import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../infra/prisma.service.js";
import { EmbeddingService } from "./embedding.service.js";
import { buildBm25Index, reciprocalRankFuse, searchBm25, type Bm25Index } from "./retrieval-ranking.js";

export interface RetrievedChunk { fileId: string; fileName: string; pageStart: number; pageEnd: number; content: string; score: number }
export interface DocumentOverview {
  files: Array<{ id: string; name: string; status: string; pages: number }>;
  excerpts: RetrievedChunk[];
  totalPages: number;
  sampledPages: number;
}

@Injectable()
export class RetrievalService {
  private readonly lexicalCache = new Map<string, { signature: string; index: Bm25Index<any> }>();
  constructor(private readonly prisma: PrismaService, private readonly embeddings: EmbeddingService) {}

  /** A generic "read this file" request has no search terms. Show bounded
   * excerpts across pages rather than treating a wildcard as no evidence. */
  async overview(userId: string, conversationId: string): Promise<DocumentOverview> {
    const files = await this.prisma.fileAsset.findMany({
      where: { userId, conversationId, kind: "PDF" }, orderBy: { createdAt: "asc" }, take: 20,
      select: { id: true, originalName: true, status: true, pages: { select: { pageNo: true }, orderBy: { pageNo: "asc" } } },
    });
    const readyIds = files.filter(file => ["READY", "PARTIAL"].includes(file.status)).map(file => file.id);
    const chunks = readyIds.length ? await this.prisma.documentChunk.findMany({
      where: { fileId: { in: readyIds } }, orderBy: [{ fileId: "asc" }, { pageStart: "asc" }, { charStart: "asc" }],
      select: { fileId: true, pageStart: true, pageEnd: true, content: true },
    }) : [];
    const names = new Map(files.map(file => [file.id, file.originalName]));
    const firstPerPage = new Map<string, typeof chunks[number]>();
    for (const chunk of chunks) {
      const key = `${chunk.fileId}:${chunk.pageStart}`;
      if (!firstPerPage.has(key)) firstPerPage.set(key, chunk);
    }
    const pages = [...firstPerPage.values()];
    const maxPages = 32;
    const samples = pages.length <= maxPages ? pages : Array.from({ length: maxPages }, (_, index) => pages[Math.floor(index * (pages.length - 1) / (maxPages - 1))]);
    const excerpts = samples.map(chunk => ({
      fileId: chunk.fileId, fileName: names.get(chunk.fileId) ?? "文件", pageStart: chunk.pageStart,
      pageEnd: chunk.pageEnd, content: chunk.content.slice(0, 400), score: 0,
    }));
    return { files: files.map(file => ({ id: file.id, name: file.originalName, status: file.status, pages: file.pages.length })), excerpts, totalPages: pages.length, sampledPages: excerpts.length };
  }

  async search(userId: string, conversationId: string, query: string, limit = 8): Promise<RetrievedChunk[]> {
    const chunks = await this.prisma.documentChunk.findMany({
      where: { file: { userId, conversationId, status: { in: ["READY","PARTIAL"] }, kind: "PDF" } },
      include: { file: { select: { id: true, originalName: true } } },
    });
    const documents = chunks.map((chunk) => ({ id: chunk.id, fileId: chunk.file.id, fileName: chunk.file.originalName, pageStart: chunk.pageStart, pageEnd: chunk.pageEnd, content: chunk.content }));
    const signature = documents.map((document) => document.id).join(":");
    let cache = this.lexicalCache.get(conversationId);
    if (!cache || cache.signature !== signature) {
      cache = { signature, index: buildBm25Index(documents) };
      this.lexicalCache.set(conversationId, cache);
      if (this.lexicalCache.size > 100) this.lexicalCache.delete(this.lexicalCache.keys().next().value!);
    }
    const lexical = searchBm25(cache.index, query);
    if (!this.embeddings.available()) return lexical.slice(0, limit);
    try {
      const [embedding] = await this.embeddings.embed([query]);
      const vector = `[${embedding.join(",")}]`;
      const semantic = await this.prisma.$queryRaw<Array<{ fileId: string; fileName: string; pageStart: number; pageEnd: number; content: string; score: number }>>`
        SELECT c."fileId", f."originalName" AS "fileName", c."pageStart", c."pageEnd", c."content",
               1 - (c."embedding" <=> ${vector}::vector) AS score
        FROM "DocumentChunk" c JOIN "FileAsset" f ON f.id = c."fileId"
        WHERE f."userId" = ${userId} AND f."conversationId" = ${conversationId}
          AND f.status IN ('READY','PARTIAL') AND f.kind = 'PDF' AND c.embedding IS NOT NULL
        ORDER BY c.embedding <=> ${vector}::vector LIMIT ${limit * 2}`;
      return reciprocalRankFuse([lexical.slice(0, limit * 2), semantic], (item) => `${item.fileId}:${item.pageStart}:${item.content.slice(0, 30)}`)
        .map(({ value, score }) => ({ ...value, score })).slice(0, limit);
    } catch { return lexical.slice(0, limit); }
  }
}
