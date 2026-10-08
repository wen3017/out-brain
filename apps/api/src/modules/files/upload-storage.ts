import { PayloadTooLargeException } from "@nestjs/common";
import { UPLOAD_LIMITS } from "@nbboss/contracts";
import type { StorageEngine } from "multer";

/** Multer's per-file limit alone allows all files to fill RAM simultaneously. */
const totals = new WeakMap<object, number>();
export const boundedUploadStorage: StorageEngine = {
  _handleFile(req, file, callback) {
    const chunks: Buffer[] = [];
    let size = 0, finished = false;
    const fail = (error: Error) => {
      if (finished) return;
      finished = true; chunks.length = 0; callback(error);
    };
    file.stream.on("data", (chunk: Buffer) => {
      if (finished) return;
      const total = (totals.get(req) ?? 0) + chunk.length;
      totals.set(req, total);
      if (total > UPLOAD_LIMITS.batchBytes) return fail(new PayloadTooLargeException("每批文件总大小不能超过 50 MB"));
      size += chunk.length; chunks.push(chunk);
    });
    file.stream.once("error", fail);
    file.stream.once("end", () => {
      if (finished) return;
      finished = true; callback(null, {buffer:Buffer.concat(chunks),size});
    });
  },
  _removeFile(_req, file, callback) { delete (file as Partial<Express.Multer.File>).buffer; callback(null); },
};
