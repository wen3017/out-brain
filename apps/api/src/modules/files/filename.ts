/** Multipart filename headers may arrive as UTF-8 bytes decoded as Latin-1. */
export function readableFileName(name: string): string {
  if (!/[\u00c0-\u00ff]/.test(name) || [...name].some(char => char.codePointAt(0)! > 255)) return name;
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(name, "latin1"));
    return /[\u3400-\u9fff]/.test(decoded) ? decoded : name;
  } catch { return name; }
}
