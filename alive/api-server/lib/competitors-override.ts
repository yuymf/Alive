import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CompetitorProfile } from '../../scripts/utils/types';

export interface CompetitorOverrideEntry extends Omit<CompetitorProfile, 'name' | 'platform'> {
  name: string;
  platform: CompetitorProfile['platform'];
  _deleted?: boolean;
  _added_at?: string;
  _updated_at?: string;
}

export interface CompetitorOverrideFile {
  entries: CompetitorOverrideEntry[];
  last_updated: string;
}

const EMPTY: CompetitorOverrideFile = { entries: [], last_updated: '' };

function getOverridePath(): string {
  const home = os.homedir();
  const persona = process.env.ALIVE_PERSONA ?? 'default';
  const base = path.join(home, '.openclaw', 'workspace', 'memory', persona);
  return path.join(base, 'competitors-override.json');
}

export function readOverride(): CompetitorOverrideFile {
  const p = getOverridePath();
  if (!fs.existsSync(p)) return { ...EMPTY };
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as CompetitorOverrideFile;
  } catch {
    return { ...EMPTY };
  }
}

export function writeOverride(file: CompetitorOverrideFile): void {
  const p = getOverridePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const updated = { ...file, last_updated: new Date().toISOString() };
  // Write .bak first (matches Alive's file-utils pattern)
  if (fs.existsSync(p)) fs.copyFileSync(p, p + '.bak');
  fs.writeFileSync(p, JSON.stringify(updated, null, 2), 'utf8');
}

/** Merge persona.yaml base profiles with override entries.
 * Override wins on name+platform key. _deleted entries are excluded. */
export function mergeCompetitors(
  base: readonly CompetitorProfile[],
  override: CompetitorOverrideFile,
): CompetitorProfile[] {
  const map = new Map<string, CompetitorProfile>();
  for (const c of base) {
    map.set(`${c.name}::${c.platform}`, c);
  }
  for (const e of override.entries) {
    const key = `${e.name}::${e.platform}`;
    if (e._deleted) {
      map.delete(key);
    } else {
      const { _deleted: _d, _added_at: _a, _updated_at: _u, ...profile } = e;
      map.set(key, profile as CompetitorProfile);
    }
  }
  return [...map.values()];
}

export function upsertOverride(entry: CompetitorOverrideEntry): CompetitorOverrideFile {
  const file = readOverride();
  const key = `${entry.name}::${entry.platform}`;
  const existing = file.entries.findIndex(e => `${e.name}::${e.platform}` === key);
  const ts = new Date().toISOString();
  const newEntries = existing === -1
    ? [...file.entries, { ...entry, _added_at: ts, _updated_at: ts }]
    : [
        ...file.entries.slice(0, existing),
        { ...file.entries[existing], ...entry, _updated_at: ts }, // preserves _added_at
        ...file.entries.slice(existing + 1),
      ];
  return { ...file, entries: newEntries };
}

export function deleteOverride(name: string, platform: string): CompetitorOverrideFile {
  const file = readOverride();
  const key = `${name}::${platform}`;
  const existing = file.entries.findIndex(e => `${e.name}::${e.platform}` === key);
  const deletionEntry: CompetitorOverrideEntry = {
    name,
    platform: platform as CompetitorProfile['platform'],
    tag: '',
    tag_desc: '',
    reference_type: 'secondary',
    _deleted: true,
    _updated_at: new Date().toISOString(),
  };
  const newEntries = existing === -1
    ? [...file.entries, deletionEntry]
    : [
        ...file.entries.slice(0, existing),
        deletionEntry,
        ...file.entries.slice(existing + 1),
      ];
  return { ...file, entries: newEntries };
}
