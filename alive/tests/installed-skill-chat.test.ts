import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { buildSkill, initMemory, installSkillTo, repoRootFromHere } from '../scripts/host/install';

function runInstalled(skillDir: string, args: string[], env: NodeJS.ProcessEnv, stdin?: string) {
  const chatJs = path.join(skillDir, 'scripts', 'host', 'chat.js');
  return spawnSync(process.execPath, [chatJs, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    input: stdin,
  });
}

describe('installed skill chat.js (what the host actually runs)', () => {
  it('load → save → load keeps 水瀬 memory on the installed copy', () => { // buildSkill() runs tsc
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alive-installed-'));
    const home = path.join(root, 'home');
    const aliveHome = path.join(root, 'alive-home');
    const skillDir = path.join(home, '.agents', 'skills', 'alive');
    fs.mkdirSync(home, { recursive: true });
    buildSkill();
    initMemory(aliveHome, 'minase', repoRootFromHere());
    installSkillTo(skillDir, repoRootFromHere());

    expect(fs.existsSync(path.join(skillDir, 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(skillDir, 'scripts', 'host', 'chat.js'))).toBe(true);
    const skill = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
    expect(skill).toContain('chat.js load');
    expect(skill).toContain('chat.js save');
    expect(skill).toContain('Do not edit diary');

    const env = { HOME: home, ALIVE_HOME: aliveHome };
    const first = runInstalled(skillDir, ['load'], env);
    expect(first.status, first.stderr || first.stdout).toBe(0);
    expect(first.stdout).toContain('水瀬');
    expect(first.stdout).toContain('first meeting');

    const saved = runInstalled(
      skillDir,
      ['save'],
      env,
      JSON.stringify({ user: '今天去咖啡馆了吗', reply: '去了啦！光线超好' }),
    );
    expect(saved.status).toBe(0);
    expect(saved.stdout).toContain('saved diary');

    const second = runInstalled(skillDir, ['load'], env);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('今天去咖啡馆了吗');
    expect(second.stdout).toContain('intimacy=1');
    expect(second.stdout).toContain('对话:');

    fs.rmSync(root, { recursive: true, force: true });
  });
});
