import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('SKILL.md Agent Skills contract', () => {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'SKILL.md'), 'utf8');
  const match = raw.match(/^---\n([\s\S]*?)\n---/);

  it('has YAML frontmatter', () => {
    expect(match).not.toBeNull();
  });

  it('uses portable name and description', () => {
    const body = match?.[1] ?? '';
    expect(body).toMatch(/^name:\s*alive/m);
    expect(body).toMatch(/^description:/m);
    expect(body).not.toMatch(/openclaw run|~\/\.openclaw/i);
  });

  it('does not tell the agent to use OpenClaw runtime paths', () => {
    expect(raw).not.toMatch(/openclaw run|clawhub|~\/\.openclaw/i);
    expect(raw).toContain('ALIVE_HOME');
    expect(raw).toContain('command-handler.js');
    expect(raw).toContain('boot.js');
    expect(raw).toContain('chat.js load');
    expect(raw).toContain('chat.js save');
    expect(raw).toContain('Do not edit diary');
    expect(raw).toContain('/alive adopt');
    expect(raw).toContain('/alive distill');
    expect(raw).toContain('ALIVE_DISTILL_HOST');
    expect(raw).toContain('/alive call');
    expect(raw).toContain('kind: call');
  });
});
