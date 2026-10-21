import path from 'node:path';
import crypto from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { cleanTemplateName, isTemplateId, parseTemplateIndex, sortTemplates, type ProjectTemplate, type TemplateIndex } from '@shared/templates';
import { readBytes, readTextSync, writeFileAtomic, isFile } from '../system/files';

export type TemplateFacts = Pick<ProjectTemplate, 'bpm' | 'timeSig' | 'channels' | 'patterns'>;

export class TemplateError extends Error {}

export class TemplateStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    readonly dir: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private get indexPath(): string {
    return path.join(this.dir, 'templates.json');
  }

  fileOf(id: string): string {
    if (!isTemplateId(id)) throw new TemplateError(`"${String(id).slice(0, 40)}" isn't a template id`);
    return path.join(this.dir, `${id}.kstudio`);
  }

  private readIndex(): TemplateIndex {
    return parseTemplateIndex(readTextSync(this.indexPath));
  }

  private async writeIndex(ix: TemplateIndex): Promise<void> {
    await writeFileAtomic(this.indexPath, JSON.stringify({ version: 1, templates: ix.templates }, null, 2));
  }

  private serialize<T>(job: () => Promise<T>): Promise<T> {
    const run = this.chain.then(job, job);
    this.chain = run.catch(() => {});
    return run;
  }

  list(): ProjectTemplate[] {
    return sortTemplates(this.readIndex().templates.filter((t) => isFile(this.fileOf(t.id))));
  }

  get(id: string): ProjectTemplate | null {
    if (!isTemplateId(id)) return null;
    return this.list().find((t) => t.id === id) ?? null;
  }

  save(name: string, bytes: Uint8Array, facts: TemplateFacts): Promise<{ template: ProjectTemplate; replaced: boolean }> {
    return this.serialize(async () => {
      const clean = cleanTemplateName(name);
      if (!clean.ok) throw new TemplateError(clean.message);
      const ix = this.readIndex();
      const at = this.now().toISOString();
      const old = ix.templates.find((t) => t.name.toLowerCase() === clean.name.toLowerCase());
      const id = old?.id ?? `tpl-${crypto.randomBytes(6).toString('hex')}`;
      const template: ProjectTemplate = { id, name: clean.name, createdAt: old?.createdAt ?? at, updatedAt: at, ...facts };
      await writeFileAtomic(this.fileOf(id), bytes);
      await this.writeIndex({ version: 1, templates: [...ix.templates.filter((t) => t.id !== id), template] });
      return { template, replaced: !!old };
    });
  }

  async read(id: string): Promise<{ template: ProjectTemplate; bytes: Uint8Array; file: string }> {
    const template = this.get(id);
    if (!template) throw new TemplateError("That template doesn't exist any more");
    const file = this.fileOf(id);
    return { template, bytes: await readBytes(file), file };
  }

  rename(id: string, name: string): Promise<ProjectTemplate> {
    return this.serialize(async () => {
      const clean = cleanTemplateName(name);
      if (!clean.ok) throw new TemplateError(clean.message);
      const ix = this.readIndex();
      const t = isTemplateId(id) ? ix.templates.find((x) => x.id === id) : undefined;
      if (!t) throw new TemplateError("That template doesn't exist any more");
      if (ix.templates.some((x) => x.id !== id && x.name.toLowerCase() === clean.name.toLowerCase())) throw new TemplateError(`There already is a template called "${clean.name}"`);
      const next = { ...t, name: clean.name, updatedAt: this.now().toISOString() };
      await this.writeIndex({ version: 1, templates: ix.templates.map((x) => (x.id === id ? next : x)) });
      return next;
    });
  }

  remove(id: string): Promise<ProjectTemplate> {
    return this.serialize(async () => {
      const ix = this.readIndex();
      const t = isTemplateId(id) ? ix.templates.find((x) => x.id === id) : undefined;
      if (!t) throw new TemplateError("That template doesn't exist any more");
      await this.writeIndex({ version: 1, templates: ix.templates.filter((x) => x.id !== id) });
      await fsp.rm(this.fileOf(id), { force: true });
      return t;
    });
  }
}
