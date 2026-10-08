import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { createWorker, PSM, type Worker } from "tesseract.js";

export async function prepareOcr(cachePath: string) {
  await mkdir(cachePath, { recursive: true });
  for (const lang of ["chi_sim", "eng"]) {
    const path = join(cachePath, `${lang}.traineddata`);
    try { if ((await readFile(path)).length > 100000) continue; } catch { /* download missing language */ }
    const response = await fetch(`https://cdn.jsdelivr.net/npm/@tesseract.js-data/${lang}/4.0.0_best_int/${lang}.traineddata.gz`, { signal: AbortSignal.timeout(60000) }).catch(() => { throw new Error("OCR 语言包下载失败，请检查网络后重试解析"); });
    if (!response.ok) throw new Error("OCR 语言包下载失败，请检查网络后重试");
    const data = gunzipSync(Buffer.from(await response.arrayBuffer()));
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, data);
    await rename(temporary, path);
  }
}

export async function extractPdf(buffer: Buffer, progress?: (page: number, total: number) => Promise<void>) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise;
  let worker: Worker | undefined;
  const pages: Array<{ pageNo: number; text: string; extractionMethod: string; qualityStatus: string; qualityMessage: string | null }> = [];
  try {
    if (document.numPages > 200) throw new Error("PDF 不得超过 200 页");
    for (let pageNo = 1; pageNo <= document.numPages; pageNo++) {
      const page = await document.getPage(pageNo);
      const content = await page.getTextContent();
      let text = content.items.map(item => "str" in item ? item.str : "").join(" ").replace(/\s+/g, " ").trim();
      let extractionMethod = "TEXT"; let qualityStatus = "OK"; let qualityMessage: string | null = null;
      const operators = await page.getOperatorList();
      const imageOps = new Set([pdfjs.OPS.paintImageXObject,pdfjs.OPS.paintInlineImageXObject,pdfjs.OPS.paintImageXObjectRepeat,pdfjs.OPS.paintImageMaskXObject]);
      const hasImages = operators.fnArray.some(op=>imageOps.has(op));
      const garbled = (text.match(/\uFFFD/g)?.length??0) > Math.max(2,text.length/50);
      if (hasImages || garbled || text.replace(/\s/g, "").length < 20) {
        if (process.env.OCR_ENABLED === "false") throw new Error(`第 ${pageNo} 页需要 OCR，请启用本地 OCR 后重试`);
        if (!worker) {
          const cachePath = process.env.OCR_CACHE_PATH ?? join(process.env.STORAGE_ROOT ?? join(process.cwd(), "data"), "ocr-cache");
          await prepareOcr(cachePath);
          worker = await createWorker("chi_sim+eng", 1, { cachePath, langPath: cachePath, gzip: false, errorHandler: () => undefined });
          await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
        }
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: Math.min(3, 4500 / Math.max(base.width, base.height)) });
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        await page.render({ canvas: canvas as never, canvasContext: canvas.getContext("2d") as never, viewport }).promise;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await Promise.race([
            (async () => {
              const image = canvas.toBuffer("image/png");
              const first = await worker!.recognize(image);
              if (first.data.text.trim().length >= 20) return first;
              await worker!.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
              try { return await worker!.recognize(image); }
              finally { await worker!.setParameters({ tessedit_pageseg_mode: PSM.AUTO }); }
            })(),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`第 ${pageNo} 页 OCR 超时，请重试`)), 120000); }),
          ]);
          const recognized = result.data.text.trim().replace(/(?<=[\p{Script=Han}]) +(?=[\p{Script=Han}])/gu, "");
          const originalLength=text.replace(/\s/g, "").length;
          // Preserve the original text layer as well as recognized image text.
          if(recognized && !text.includes(recognized)) text = recognized.includes(text) ? recognized : `${text}\n${recognized}`.trim();
          extractionMethod = "OCR";
          if(!recognized || result.data.confidence < 50 || (hasImages && recognized.replace(/\s/g, "").length <= originalLength + 10)){ qualityStatus="REVIEW_REQUIRED";qualityMessage=`第 ${pageNo} 页 OCR 结果不可靠，可能遗漏正文，请核对原页或上传更清晰版本`; }
        } finally { if (timer) clearTimeout(timer); }
      }
      // Some PDF text layers contain NUL characters, which PostgreSQL rejects
      // in UTF-8 text fields. Remove them before storing pages or chunks.
      text = text.replace(/\u0000/g, "");
      if(!text.trim()){qualityStatus="UNREADABLE";qualityMessage=`第 ${pageNo} 页未识别到文字，请核对是否为空白或模糊页面`;}
      pages.push({ pageNo, text, extractionMethod, qualityStatus, qualityMessage });
      page.cleanup();
      await progress?.(pageNo, document.numPages);
    }
    if (!pages.some(page => page.text.length > 20)) throw new Error("PDF 未识别到有效文字，请上传更清晰的资料");
    return pages;
  } finally { await worker?.terminate(); await document.destroy(); }
}
