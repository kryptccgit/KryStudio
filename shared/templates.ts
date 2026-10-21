export interface ProjectTemplate {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  bpm: number;
  timeSig: string;
  channels: number;
  patterns: number;
}

export interface TemplateIndex {
  version: 1;
  templates: ProjectTemplate[];
}

export const TEMPLATE_NAME_MAX = 64;
export const TEMPLATE_ID_RE = /^tpl-[a-z0-9]{6,24}$/;

export function cleanTemplateName(name: unknown): { ok: true; name: string } | { ok: false; message: string } {
  if (typeof name !== 'string') return { ok: false, message: 'Give the template a name' };
  const t = name.replace(/\s+/g, ' ').trim();
  if (!t) return { ok: false, message: 'Give the template a name' };
  if (t.length > TEMPLATE_NAME_MAX) return { ok: false, message: `Template names are at most ${TEMPLATE_NAME_MAX} characters` };
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(t)) return { ok: false, message: "Template names can't contain control characters" };
  return { ok: true, name: t };
}

export function isTemplateId(id: unknown): id is string {
  return typeof id === 'string' && TEMPLATE_ID_RE.test(id);
}

const isEntry = (x: unknown): x is ProjectTemplate => {
  const t = x as ProjectTemplate;
  return !!t && isTemplateId(t.id) && typeof t.name === 'string' && typeof t.createdAt === 'string';
};

export function parseTemplateIndex(text: string | null): TemplateIndex {
  if (!text) return { version: 1, templates: [] };
  try {
    const j = JSON.parse(text) as Partial<TemplateIndex>;
    const seen = new Set<string>();
    const templates = (Array.isArray(j?.templates) ? j.templates : []).filter(isEntry).filter((t) => !seen.has(t.id) && !!seen.add(t.id));
    return {
      version: 1,
      templates: templates.map((t) => ({
        id: t.id,
        name: cleanTemplateName(t.name).ok ? (cleanTemplateName(t.name) as { name: string }).name : 'Template',
        createdAt: t.createdAt,
        updatedAt: typeof t.updatedAt === 'string' ? t.updatedAt : t.createdAt,
        bpm: Number.isFinite(t.bpm) ? t.bpm : 0,
        timeSig: typeof t.timeSig === 'string' ? t.timeSig : '4/4',
        channels: Number.isFinite(t.channels) ? t.channels : 0,
        patterns: Number.isFinite(t.patterns) ? t.patterns : 0,
      })),
    };
  } catch {
    return { version: 1, templates: [] };
  }
}

export function sortTemplates(list: readonly ProjectTemplate[]): ProjectTemplate[] {
  return [...list].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || b.updatedAt.localeCompare(a.updatedAt));
}

export function findTemplate(list: readonly ProjectTemplate[], ref: string): ProjectTemplate | null {
  const t = ref.trim();
  return list.find((x) => x.id === t) ?? list.find((x) => x.name.toLowerCase() === t.toLowerCase()) ?? null;
}

export function describeTemplate(t: ProjectTemplate): string {
  return [t.bpm ? `${Math.round(t.bpm * 100) / 100} bpm` : null, t.timeSig, `${t.channels} channel${t.channels === 1 ? '' : 's'}`, `${t.patterns} pattern${t.patterns === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
}
