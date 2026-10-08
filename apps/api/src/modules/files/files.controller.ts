import { Controller, Delete, Get, Param, Post, Res, UploadedFile, UploadedFiles, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileInterceptor, FilesInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { CurrentUser, type AuthUser } from "../../common/current-user.js";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { FilesService } from "./files.service.js";
import { UPLOAD_LIMITS } from "@nbboss/contracts";
import { boundedUploadStorage } from "./upload-storage.js";
import { AiQuotaGuard } from "../../common/request-limits.js";

@Controller() @UseGuards(JwtAuthGuard, AiQuotaGuard)
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Post("conversations/:conversationId/files") @UseInterceptors(FileInterceptor("file", { storage: boundedUploadStorage, limits: { fileSize: UPLOAD_LIMITS.pdfBytes, fields: 0 } }))
  async upload(@CurrentUser() user: AuthUser, @Param("conversationId") conversationId: string, @UploadedFile() file: Express.Multer.File) {
    const asset = await this.files.save(user.id, conversationId, file);
    return { id: asset.id, conversationId: asset.conversationId, kind: asset.kind, originalName: asset.originalName, mimeType: asset.mimeType, size: asset.size, status: asset.status, errorMessage: asset.errorMessage, createdAt: asset.createdAt };
  }

  @Post("conversations/:conversationId/files/batch") @UseInterceptors(FilesInterceptor("files", UPLOAD_LIMITS.files, { storage: boundedUploadStorage, limits: { fileSize: UPLOAD_LIMITS.pdfBytes, files: UPLOAD_LIMITS.files, fields: 0 } }))
  async uploadBatch(@CurrentUser() user: AuthUser, @Param("conversationId") conversationId: string, @UploadedFiles() files: Express.Multer.File[]) {
    const assets = await this.files.saveBatch(user.id, conversationId, files);
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
