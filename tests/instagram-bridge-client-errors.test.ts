import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'child_process';
import { callInstagramBridge } from '../skill/scripts/instagram-bridge-client';

const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;

describe('instagram-bridge-client error propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.E2E_MOCK_INSTAGRAM;
  });

  it('includes structured error metadata from bridge stdout on process failure', async () => {
    const stdout = JSON.stringify({
      error: 'Failed after 3 retries: Unknown ({})',
      error_type: 'RuntimeError',
      command: 'upload_photo',
      error_repr: "RuntimeError('Failed after 3 retries: Unknown ({})')",
    });

    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(new Error('exit code 1'), stdout, 'python stderr');
    });

    await expect(callInstagramBridge('upload_photo', { image: '/tmp/a.jpg', caption: 'x' }))
      .rejects.toThrow(/RuntimeError/);
  });

  it('treats stdout error payload as failure even when process exits successfully', async () => {
    const stdout = JSON.stringify({
      error: 'Challenge required',
      error_type: 'ChallengeRequired',
      command: 'upload_photo',
    });

    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, stdout, '');
    });

    await expect(callInstagramBridge('upload_photo', { image: '/tmp/a.jpg', caption: 'x' }))
      .rejects.toThrow(/ChallengeRequired/);
  });
});
