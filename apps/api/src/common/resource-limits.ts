/** Blank optional environment values must not become Number("") === 0. */
export function resourceLimit(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > 1_000_000) {
    throw new Error(`Invalid resource limit: ${name}`);
  }
  return value;
}
