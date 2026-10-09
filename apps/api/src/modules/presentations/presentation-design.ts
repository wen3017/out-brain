import type { PresentationDocument } from "@nbboss/contracts";

type Slide = PresentationDocument["slides"][number];
type Element = Slide["elements"][number];

const ink = "17324D";
const muted = "53677D";
const navy = "102A43";
const blue = "3177B9";
const teal = "1E8A88";
const gold = "D6A646";
const white = "FFFFFF";

function text(id: string, value: string, x: number, y: number, w: number, h: number, fontSize: number, color = ink, bold = false): Element {
  return { id, type: "text", text: value, x, y, w, h, fontSize, color, bold };
}

function box(id: string, x: number, y: number, w: number, h: number, fill: string): Element {
  return { id, type: "shape", text: "", x, y, w, h, fontSize: 16, color: fill, fill, bold: false };
}

function excerpt(value: string, max = 72): string {
  const cleaned = value.replace(/^\s*[•·\-–]\s*/, "").replace(/\s+/g, " ").trim();
  if ([...cleaned].length <= max) return cleaned;
  const prefix = [...cleaned].slice(0, max - 1).join("");
  const boundary = Math.max(prefix.lastIndexOf("。"), prefix.lastIndexOf("；"), prefix.lastIndexOf(";"), prefix.lastIndexOf(". "));
  return `${(boundary > max * 0.55 ? prefix.slice(0, boundary + 1) : prefix).trimEnd()}…`;
}

function card(slide: Slide, id: string, label: string, content: string, x: number, y: number, w: number, h: number, accent: string, dark = false) {
  const size = w < 5 ? 20 : 22;
  const lines = Math.max(1, Math.floor((h - 1.05) * 72 / (size * 1.28)));
  const perLine = Math.max(9, Math.floor((w - 0.6) * 72 / size));
  const limit = Math.max(18, Math.min(88, lines * perLine - 2));
  slide.elements.push(box(`${id}-surface`, x, y, w, h, dark ? navy : white));
  slide.elements.push(box(`${id}-accent`, x, y, 0.09, h, accent));
  slide.elements.push(text(`${id}-label`, label, x + 0.3, y + 0.25, w - 0.55, 0.4, 15, dark ? "89C5E7" : accent, true));
  slide.elements.push(text(`${id}-content`, excerpt(content, limit), x + 0.3, y + 0.8, w - 0.6, h - 1.05, size, dark ? white : ink));
}

/** Re-layout reviewed copy. Full source-backed text remains in speaker notes. */
export function designPresentation(document: PresentationDocument): PresentationDocument {
  document.slides.forEach((slide, index) => {
    const original = slide.elements.filter(element => element.type === "text").map(element => element.text.trim()).filter(Boolean);
    const points = original.filter(value => value !== slide.title).slice(0, 4);
    const count = document.slides.length;
    const isCover = index === 0;
    const isLast = index === count - 1 && count > 1;
    slide.notes = [slide.notes, points.length ? `页面完整要点：\n${points.join("\n")}` : ""].filter(Boolean).join("\n\n");
    slide.elements = [];

    if (isCover) {
      slide.elements.push(box("cover-background", 0, 0, 13.333, 7.5, navy));
      slide.elements.push(box("cover-rule", 0.82, 1.15, 0.13, 4.85, teal));
      slide.elements.push(text("cover-kicker", "研究演示  /  RESEARCH BRIEF", 1.25, 1.08, 8.4, 0.45, 16, "88C4E6", true));
      slide.elements.push(text("cover-title", excerpt(slide.title, 48), 1.25, 1.75, 8.2, 2.45, 38, white, true));
      if (points[0]) slide.elements.push(text("cover-subtitle", excerpt(points[0], 88), 1.28, 4.55, 7.8, 1.2, 20, "CFDFEB"));
      // An abstract route/network motif; it encodes no invented measurements.
      [[10.25, 1.45], [11.3, 2.25], [9.72, 3.05], [11.66, 4.55], [10.25, 5.62]].forEach(([x, y], n) => {
        slide.elements.push(box(`cover-node-${n}`, x, y, n % 2 ? 0.55 : 0.36, n % 2 ? 0.55 : 0.36, n % 2 ? teal : "77A9D4"));
      });
      slide.elements.push(box("cover-route-a", 10.3, 2.1, 0.06, 2.85, "527A9A"));
      slide.elements.push(box("cover-route-b", 10.35, 4.86, 1.45, 0.06, "527A9A"));
      return;
    }

    if (isLast) {
      slide.elements.push(box("closing-background", 0, 0, 13.333, 7.5, navy));
      slide.elements.push(box("closing-top", 0.8, 1.0, 1.3, 0.12, teal));
      slide.elements.push(text("closing-title", excerpt(slide.title, 46), 0.85, 1.45, 10.9, 1.25, 36, white, true));
      points.slice(0, 3).forEach((point, n) => card(slide, `closing-${n}`, `0${n + 1}`, point, 0.85 + n * 4.15, 3.35, 3.85, 2.65, teal, true));
      return;
    }

    slide.elements.push(box("page-background", 0, 0, 13.333, 7.5, "F2F6FA"));
    slide.elements.push(box("page-top", 0, 0, 13.333, 0.11, index % 2 ? blue : teal));
    slide.elements.push(text("page-index", `${String(index + 1).padStart(2, "0")} / ${String(count).padStart(2, "0")}`, 0.78, 0.37, 2.1, 0.34, 14, blue, true));
    slide.elements.push(text("page-title", excerpt(slide.title, 48), 0.78, 0.9, 11.75, 0.85, 31, ink, true));
    slide.elements.push(box("page-rule", 0.78, 1.91, 11.75, 0.045, "C8D9E8"));
    const values = points.length ? points : ["相关信息待确认（原始材料未提供依据）"];

    if (index % 4 === 1) {
      card(slide, "lead", "核心观点", values[0], 0.78, 2.35, 7.1, 3.8, teal);
      values.slice(1, 3).forEach((point, n) => card(slide, `side-${n}`, `要点 0${n + 2}`, point, 8.16, 2.35 + n * 1.97, 4.36, 1.83, blue));
      if (values[3]) {
        slide.elements.push(box("foot-rule", 0.78, 6.48, 0.09, 0.48, gold));
        slide.elements.push(text("foot-copy", excerpt(values[3], 94), 1.02, 6.44, 11.4, 0.52, 18, ink));
      }
    } else if (index % 4 === 2) {
      values.slice(0, 4).forEach((point, n) => {
        const x = 0.78 + (n % 2) * 6.0; const y = 2.23 + Math.floor(n / 2) * 2.35;
        card(slide, `grid-${n}`, `0${n + 1}  /  关键要点`, point, x, y, 5.75, 2.12, n % 2 ? blue : teal);
      });
    } else if (index % 4 === 3) {
      values.slice(0, 4).forEach((point, n) => {
        const x = 0.78 + n * 3.03;
        card(slide, `step-${n}`, `STEP 0${n + 1}`, point, x, 2.5, 2.77, 3.7, n % 2 ? blue : teal);
        if (n < Math.min(values.length, 4) - 1) slide.elements.push(box(`connector-${n}`, x + 2.77, 4.27, 0.26, 0.07, "A9C9DF"));
      });
    } else {
      values.slice(0, 4).forEach((point, n) => {
        const x = 0.78 + (n % 2) * 6.0; const y = 2.23 + Math.floor(n / 2) * 2.35;
        card(slide, `compare-${n}`, `机制 0${n + 1}`, point, x, y, 5.75, 2.12, n % 2 ? blue : teal);
      });
    }
    slide.elements.push(text("page-footer", "资料要点 · 完整依据见备注", 0.82, 7.12, 6, 0.2, 10, muted));
  });
  return document;
}
