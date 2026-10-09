import { describe, expect, it } from "vitest";
import { presentationSchema } from "@nbboss/contracts";
import { designPresentation } from "../src/modules/presentations/presentation-design.js";

describe("presentation visual design", () => {
  it("creates distinct editable layouts and retains full reviewed text in notes", () => {
    const long = "完整的来源核对段落，包含研究方法、限制和背景。".repeat(8);
    const document = presentationSchema.parse({ title: "研究汇报", slides: Array.from({ length: 8 }, (_, index) => ({
      id: `slide-${index}`, title: `第 ${index + 1} 页：研究要点`, notes: "核对原文：来源内容", elements: [
        { id: "heading", type: "text", text: `第 ${index + 1} 页：研究要点`, x: 1, y: 0.5, w: 10, h: 0.7, fontSize: 28, color: "17324D", bold: true },
        ...Array.from({ length: 4 }, (_, bullet) => ({ id: `bullet-${bullet}`, type: "text", text: long, x: 1, y: 1.4 + bullet, w: 10, h: 0.8, fontSize: 18, color: "17324D", bold: false })),
      ],
    })) });
    designPresentation(document);
    expect(() => presentationSchema.parse(document)).not.toThrow();
    expect(document.slides.every(slide => slide.elements.filter(element => element.type === "shape").length >= 8)).toBe(true);
    expect(document.slides[0].elements[0].fill).toBe("102A43");
    expect(document.slides[1].elements.some(element => element.id === "lead-surface")).toBe(true);
    expect(document.slides[2].elements.some(element => element.id === "grid-0-surface")).toBe(true);
    expect(document.slides[3].elements.some(element => element.id === "step-0-surface")).toBe(true);
    expect(document.slides[4].elements.some(element => element.id === "compare-0-surface")).toBe(true);
    expect(document.slides.at(-1)?.elements[0].fill).toBe("102A43");
    for (const slide of document.slides) {
      expect(slide.notes).toContain(long);
      expect(slide.elements.filter(element => element.type === "text").every(element => element.text.length < long.length)).toBe(true);
    }
  });
});
