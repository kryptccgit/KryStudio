// Official Krypt links used by the About panel and the title-bar menu.
// [PROTECTION] kryptguidelines §9.1: no clean literals for a rebrander to
// search-and-replace; they're rebuilt at runtime. In a degraded (rebranded)
// build main refuses to open them anyway (electron/system/shell.ts).

const K = 0x37;
const rebuild = (codes: number[]): string => String.fromCharCode(...codes.map((c) => c ^ K).reverse());

export const LINKS = {
  site: rebuild([84, 84, 25, 67, 71, 78, 69, 92, 24, 24, 13, 68, 71, 67, 67, 95]),
  tools: rebuild([68, 91, 88, 88, 67, 24, 84, 84, 25, 67, 71, 78, 69, 92, 24, 24, 13, 68, 71, 67, 67, 95]),
  discord: rebuild([113, 0, 2, 1, 101, 124, 113, 77, 66, 90, 24, 80, 80, 25, 83, 69, 88, 84, 68, 94, 83, 24, 24, 13, 68, 71, 67, 67, 95]),
} as const;
