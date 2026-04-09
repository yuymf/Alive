import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setBasePaths, resetBasePaths } from '../../scripts/utils/file-utils';
import {
  loadFormulaStore,
  saveFormulaStore,
  mergeAccountFormulas,
  queryFormulasByMode,
} from '../../scripts/ops/formula-store';
import type { FormulaStore, HookFormula } from '../../scripts/utils/types';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

const tmpDir = path.join(os.tmpdir(), 'alive-formula-store-test-' + Date.now());

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  setBasePaths(tmpDir, tmpDir);
});

afterEach(() => {
  resetBasePaths();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const makeFormula = (formula: string, frequency: '高' | '中' | '低' = '中', account = 'acc:xhs'): HookFormula => ({
  formula,
  examples: ['例子A', '例子B'],
  frequency,
  source_account: account,
  source_platform: 'xhs',
  last_analyzed: '2026-04-01T00:00:00.000Z',
});

describe('loadFormulaStore', () => {
  it('returns empty store when file does not exist', () => {
    const store = loadFormulaStore();
    expect(store.version).toBe(1);
    expect(store.formulas).toEqual({});
  });
});

describe('saveFormulaStore + loadFormulaStore', () => {
  it('round-trips a store to disk', () => {
    const f = makeFormula('[数字]个技巧');
    const store: FormulaStore = {
      version: 1,
      formulas: { esports: { 'acc:xhs': [f] } },
      last_updated: '2026-04-01T00:00:00.000Z',
    };
    saveFormulaStore(store);
    const loaded = loadFormulaStore();
    expect(loaded.formulas.esports?.['acc:xhs']).toHaveLength(1);
    expect(loaded.formulas.esports?.['acc:xhs']?.[0].formula).toBe('[数字]个技巧');
  });
});

describe('mergeAccountFormulas', () => {
  it('adds formulas under a new mode', () => {
    const empty = loadFormulaStore();
    const f = makeFormula('[数字]条建议', '高');
    const result = mergeAccountFormulas(empty, ['esports'], 'acc:xhs', [f]);
    expect(result.formulas.esports?.['acc:xhs']).toHaveLength(1);
    expect(result.formulas.esports?.['acc:xhs']?.[0].formula).toBe('[数字]条建议');
  });

  it('overwrites existing formulas for the same accountKey', () => {
    const empty = loadFormulaStore();
    const f1 = makeFormula('旧句式');
    const store1 = mergeAccountFormulas(empty, ['singer'], 'acc:xhs', [f1]);
    const f2 = makeFormula('新句式');
    const store2 = mergeAccountFormulas(store1, ['singer'], 'acc:xhs', [f2]);
    expect(store2.formulas.singer?.['acc:xhs']).toHaveLength(1);
    expect(store2.formulas.singer?.['acc:xhs']?.[0].formula).toBe('新句式');
  });

  it('preserves formulas for other accounts under the same mode', () => {
    const empty = loadFormulaStore();
    const fA = makeFormula('句式A', '高', 'accA:xhs');
    const store1 = mergeAccountFormulas(empty, ['racer'], 'accA:xhs', [fA]);
    const fB = makeFormula('句式B', '中', 'accB:xhs');
    const store2 = mergeAccountFormulas(store1, ['racer'], 'accB:xhs', [fB]);
    expect(store2.formulas.racer?.['accA:xhs']).toHaveLength(1);
    expect(store2.formulas.racer?.['accB:xhs']).toHaveLength(1);
  });

  it('writes to all provided modes for AI虚拟偶像 cross-mode accounts', () => {
    const empty = loadFormulaStore();
    const f = makeFormula('跨赛道句式', '高');
    const modes: Array<'esports' | 'singer' | 'racer' | 'daily'> = ['esports', 'singer', 'racer', 'daily'];
    const result = mergeAccountFormulas(empty, modes, 'vtuber:xhs', [f]);
    for (const mode of modes) {
      expect(result.formulas[mode]?.['vtuber:xhs']).toHaveLength(1);
    }
  });

  it('does not mutate the input store', () => {
    const empty = loadFormulaStore();
    const original = JSON.stringify(empty);
    const f = makeFormula('不变');
    mergeAccountFormulas(empty, ['daily'], 'acc:xhs', [f]);
    expect(JSON.stringify(empty)).toBe(original);
  });

  it('deep-clones examples arrays so mutations do not bleed', () => {
    const empty = loadFormulaStore();
    const f = makeFormula('句式X', '中');
    const result = mergeAccountFormulas(empty, ['esports'], 'acc:xhs', [f]);
    // Mutate original examples — should not affect stored copy
    (f as { examples: string[] }).examples.push('追加的例子');
    expect(result.formulas.esports?.['acc:xhs']?.[0].examples).toHaveLength(2);
  });

  it('updates last_updated timestamp', () => {
    const empty = loadFormulaStore();
    const before = new Date(empty.last_updated).getTime();
    const f = makeFormula('新句式');
    const result = mergeAccountFormulas(empty, ['esports'], 'acc:xhs', [f]);
    expect(new Date(result.last_updated).getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe('queryFormulasByMode', () => {
  it('returns empty array for unknown mode', () => {
    const store = loadFormulaStore();
    expect(queryFormulasByMode(store, 'esports')).toEqual([]);
  });

  it('aggregates formulas across multiple accounts', () => {
    const empty = loadFormulaStore();
    const fA = makeFormula('句式A', '高', 'accA:xhs');
    const fB = makeFormula('句式B', '低', 'accB:xhs');
    const store = mergeAccountFormulas(
      mergeAccountFormulas(empty, ['esports'], 'accA:xhs', [fA]),
      ['esports'], 'accB:xhs', [fB],
    );
    const results = queryFormulasByMode(store, 'esports');
    expect(results).toHaveLength(2);
  });

  it('deduplicates by formula string, keeping highest-frequency version', () => {
    const empty = loadFormulaStore();
    const fLow = makeFormula('重复句式', '低', 'accA:xhs');
    const fHigh = makeFormula('重复句式', '高', 'accB:xhs');
    const store = mergeAccountFormulas(
      mergeAccountFormulas(empty, ['singer'], 'accA:xhs', [fLow]),
      ['singer'], 'accB:xhs', [fHigh],
    );
    const results = queryFormulasByMode(store, 'singer');
    expect(results).toHaveLength(1);
    expect(results[0].frequency).toBe('高');
  });

  it('sorts results: 高 first, then 中, then 低', () => {
    const empty = loadFormulaStore();
    const formulas: HookFormula[] = [
      makeFormula('低频句式', '低', 'accA:xhs'),
      makeFormula('中频句式', '中', 'accA:xhs'),
      makeFormula('高频句式', '高', 'accA:xhs'),
    ];
    const store = mergeAccountFormulas(empty, ['racer'], 'accA:xhs', formulas);
    const results = queryFormulasByMode(store, 'racer');
    expect(results[0].frequency).toBe('高');
    expect(results[1].frequency).toBe('中');
    expect(results[2].frequency).toBe('低');
  });
});
