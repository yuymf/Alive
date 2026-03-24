import { describe, it, expect, vi } from 'vitest';

vi.mock('../sub-skills/platform/instagram-bridge/scripts/bridge-client', () => ({
  callInstagramBridge: vi.fn().mockResolvedValue({ media_pk: '999' }),
  uploadAlbum: vi.fn().mockResolvedValue('999'),
}));

import { uploadAlbum } from '../sub-skills/platform/instagram-bridge/scripts/bridge-client';

describe('uploadAlbum', () => {
  it('returns media_pk on success', async () => {
    const result = await uploadAlbum(['/tmp/a.png', '/tmp/b.png'], 'test caption');
    expect(result).toBe('999');
  });
});
