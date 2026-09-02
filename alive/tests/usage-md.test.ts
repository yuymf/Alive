import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

describe('USAGE.md', () => {
  const file = path.join(__dirname, '..', '..', 'USAGE.md');
  const text = fs.readFileSync(file, 'utf8');

  it('walks from a new persona to a live call', () => {
    expect(text).toContain('## 1. 安装 Alive');
    expect(text).toContain('## 2. 做一个新角色');
    expect(text).toContain('alive distill');
    expect(text).toContain('## 3. 先文字聊天');
    expect(text).toContain('alive context');
    expect(text).toContain('## 5. 打电话：LiveKit + VoxCPM');
    expect(text).toContain('livekit-server');
    expect(text).toContain('VOXCPM_URL');
    expect(text).toContain('CARTESIA_API_KEY');
    expect(text).toContain('alive voice --check');
    expect(text).toContain('alive voice --livekit-dev');
    expect(text).toContain('http://127.0.0.1:8766');
    expect(text).toContain('python alive/voice/voxcpm/server.py');
    expect(text).toContain('alive/voice/agent/requirements.txt');
  });
});
