import { SCHEMA_VERSION, checkIntegrity, zProject, type Project } from '@shared/schema/project';
import { ProjectFileError } from './container';

type Migration = (raw: Record<string, unknown>) => Record<string, unknown>;

export const MIGRATIONS: Record<number, Migration> = {};

export function migrate(raw: Record<string, unknown>, fromVersion: number): Record<string, unknown> {
  let doc = raw;
  for (let v = fromVersion; v < SCHEMA_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (!step) throw new ProjectFileError(`Can't upgrade this project from schema ${v} (no migration available).`);
    doc = step(doc);
    doc.schemaVersion = v + 1;
  }
  return doc;
}

export function validateProject(raw: unknown, metaSchemaVersion?: number): Project {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ProjectFileError("The project file doesn't contain a project.");
  const obj = raw as Record<string, unknown>;
  const version = typeof obj.schemaVersion === 'number' ? obj.schemaVersion : metaSchemaVersion ?? NaN;
  if (!Number.isInteger(version) || version < 1) throw new ProjectFileError('The project file has no valid schemaVersion.');
  if (version > SCHEMA_VERSION) {
    throw new ProjectFileError(`This project was saved by a newer version of Krypt Studio (schema ${version}; this app reads up to ${SCHEMA_VERSION}). Update the app to open it.`);
  }
  const migrated = migrate(obj, version);
  const parsed = zProject.safeParse(migrated);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path?.length ? ` at ${issue.path.join('.')}` : '';
    throw new ProjectFileError(`The project file is damaged: ${issue?.message ?? 'invalid data'}${where}.`);
  }
  const project = parsed.data as Project;
  const errs = checkIntegrity(project);
  if (errs.length) throw new ProjectFileError(`The project file is damaged: ${errs[0]}${errs.length > 1 ? ` (+${errs.length - 1} more problems)` : ''}.`);
  return project;
}
