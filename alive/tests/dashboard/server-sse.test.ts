import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';

const {
  safeKillChildProcess,
  attachSseChildCleanup,
} = require('../../dashboard/server.js');

describe('dashboard server SSE child cleanup', () => {
  it('safeKillChildProcess only kills active child process', () => {
    const child = {
      exitCode: null as number | null,
      killed: false,
      kill: vi.fn(function kill(this: { killed: boolean }) {
        this.killed = true;
      }),
    };

    expect(safeKillChildProcess(child)).toBe(true);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(safeKillChildProcess(child)).toBe(false);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('attachSseChildCleanup does not kill child on request close', () => {
    const req = new EventEmitter();
    const res = new EventEmitter();
    const child = {
      exitCode: null as number | null,
      killed: false,
      kill: vi.fn(function kill(this: { killed: boolean }) {
        this.killed = true;
      }),
    };

    attachSseChildCleanup(req, res, child);

    req.emit('close');
    expect(child.kill).not.toHaveBeenCalled();

    res.emit('close');
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
});
