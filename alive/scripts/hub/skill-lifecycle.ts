// alive/scripts/hub/skill-lifecycle.ts
// Safety constraints for skill installation and lifecycle management.
// Design ref: Safety constraints section

import * as fs from 'fs';
import * as path from 'path';
import { PATHS } from '../utils/file-utils';

/** Maximum skills that can be installed in a single night reflect cycle. */
export const MAX_INSTALL_PER_NIGHT = 2;

/** Maximum total installed skills before blocking new installs. */
export const MAX_TOTAL_SKILLS = 20;

const ARCHIVED_DIR = '.archived';

// ─── Public API ─────────────────────────────────────────

/**
 * Check if more skills can be installed tonight.
 * @param installedTonight - Number of skills already installed this cycle
 */
export function canInstallMore(installedTonight: number): boolean {
  return installedTonight < MAX_INSTALL_PER_NIGHT;
}

/**
 * Check if total installed skill count allows new installations.
 * Returns false if at or above MAX_TOTAL_SKILLS.
 */
export function checkInstallLimit(): boolean {
  return getInstalledSkillCount() < MAX_TOTAL_SKILLS;
}

/**
 * Count the number of installed skill directories in sub-skills/.
 * Excludes .archived and hidden directories.
 */
export function getInstalledSkillCount(): number {
  const subSkillsDir = PATHS.subSkillsDir;
  if (!fs.existsSync(subSkillsDir)) return 0;

  return fs.readdirSync(subSkillsDir)
    .filter(name => {
      if (name.startsWith('.')) return false;
      const fullPath = path.join(subSkillsDir, name);
      return fs.statSync(fullPath).isDirectory();
    })
    .length;
}

/**
 * Archive (soft-delete) a skill by moving it to sub-skills/.archived/.
 * Does not throw if the skill doesn't exist.
 */
export function archiveSkill(skillName: string): void {
  const subSkillsDir = PATHS.subSkillsDir;
  const source = path.join(subSkillsDir, skillName);
  if (!fs.existsSync(source)) return;

  const archiveDir = path.join(subSkillsDir, ARCHIVED_DIR);
  fs.mkdirSync(archiveDir, { recursive: true });

  const dest = path.join(archiveDir, skillName);
  fs.renameSync(source, dest);
}
