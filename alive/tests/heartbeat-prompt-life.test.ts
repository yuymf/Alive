import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

describe('heartbeat prompt life loop', () => {
  const prompt = fs.readFileSync(
    path.join(__dirname, '..', 'templates', 'heartbeat-prompt.md'),
    'utf8',
  );

  it('routes selfie, social, and call to real skills', () => {
    expect(prompt).toContain('skill=`gallery`');
    expect(prompt).toContain('skill=`instagram`');
    expect(prompt).toContain('skill=`voice-call`');
    expect(prompt).toContain('自拍');
  });
});
