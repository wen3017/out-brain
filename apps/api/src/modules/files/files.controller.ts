import { Controller, Delete, Get, Param, Post, Res, UploadedFile, UploadedFiles, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileInterceptor, FilesInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { CurrentUser, type AuthUser } from "../../common/current-user.js";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { FilesService } from "./files.service.js";

@Controller() @UseGuards(JwtAuthGuard)
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Post("conversations/:conversationId/files") @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 20 * 1024 * 1024 } }))
  async upload(@CurrentUser() user: AuthUser, @Param("conversationId") conversationId: string, @UploadedFile() file: Express.Multer.File) {
    const asset = await this.files.save(user.id, conversationId, file);
    return { id: asset.id, conversationId: asset.conversationId, kind: asset.kind, originalName: asset.originalName, mimeType: asset.mimeType, size: asset.size, status: asset.status, errorMessage: asset.errorMessage, createdAt: asset.createdAt };
  }

  @Post("conversations/:conversationId/files/batch") @UseInterceptors(FilesInterceptor("files", 20, { limits: { fileSize: 20 * 1024 * 1024 } }))
  async uploadBatch(@CurrentUser() user: AuthUser, @Param("conversationId") conversationId: string, @UploadedFiles() files: Express.Multer.File[]) {
    await this.files.validateBatch(user.id,conversationId,files);
    const assets = [];
    try { for(const file of files ?? []) assets.push(await this.files.save(user.id, conversationId, file, true)); }
    finally {
      const results = await Promise.allSettled(assets.filter(asset=>asset.status==="PROCESSING").map(asset=>this.files.enqueue(asset.id)));
      if(results.some(result=>result.status==="rejected")) throw new Error("部分文件入队失败，请在文件面板重试");
    }
    return assets.map(asset=>({id:asset.id,conversationId:asset.conversationId,originalName:asset.originalName,status:asset.status}));
  }

  @Get("files/:id")
  async download(@CurrentUser() user: AuthUser, @Param("id") id: string, @Res() res: Response) {
    const file = await this.files.get(user.id, id);
    res.download(file.storagePath, file.originalName);
  }

  @Delete("files/:id") remove(@CurrentUser() user: AuthUser, @Param("id") id: string) { return this.files.remove(user.id, id); }
  @Post("files/:id/retry") retry(@CurrentUser() user: AuthUser, @Param("id") id: string) { return this.files.retry(user.id, id); }
}
