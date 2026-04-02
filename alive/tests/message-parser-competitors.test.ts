import { describe, it, expect } from 'vitest';
import { parseSlashCommand } from '../sub-skills/ops-desk/scripts/message-parser';

describe('new slash commands', () => {
  it('should parse /competitors command', () => {
    const result = parseSlashCommand('/competitors');
    expect(result).not.toBeNull();
    expect(result!.command).toBe('competitors');
    expect(result!.args).toEqual([]);
  });

  it('should parse /positioning command', () => {
    const result = parseSlashCommand('/positioning');
    expect(result).not.toBeNull();
    expect(result!.command).toBe('positioning');
    expect(result!.args).toEqual([]);
  });

  it('should parse /competitors with filter arg', () => {
    const result = parseSlashCommand('/competitors esports');
    expect(result).not.toBeNull();
    expect(result!.command).toBe('competitors');
    expect(result!.args).toEqual(['esports']);
  });
});
