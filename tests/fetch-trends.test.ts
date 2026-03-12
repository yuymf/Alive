import { describe, it, expect, vi, beforeEach } from 'vitest';

// We'll test the internal functions by importing the module.
// Since fetch-trends.ts uses global fetch, we mock it.

// First, let's test the output formatting function we'll extract.
// We need to make formatTrendEntry and formatTrendSection exportable for testing.

describe('fetch-trends', () => {
  describe('formatTrendEntry', () => {
    it('should format a post with selftext and comments', async () => {
      // Dynamic import after mocking
      const { formatTrendEntry } = await import('../skill/scripts/fetch-trends');
      const entry = formatTrendEntry({
        title: 'Amazing Yor Forger cosplay',
        score: 1500,
        selftext: 'First time doing Yor! Used real fabric for the dress.',
        subreddit: 'cosplay',
        topComments: [
          'The fabric choice is perfect!',
          'Best Yor I have seen',
        ],
      });
      expect(entry).toContain('**Amazing Yor Forger cosplay**');
      expect(entry).toContain('↑1500');
      expect(entry).toContain('> First time doing Yor!');
      expect(entry).toContain('热评:');
      expect(entry).toContain('The fabric choice is perfect!');
    });

    it('should handle posts with no selftext', async () => {
      const { formatTrendEntry } = await import('../skill/scripts/fetch-trends');
      const entry = formatTrendEntry({
        title: 'My Marin Kitagawa',
        score: 800,
        selftext: '',
        subreddit: 'cosplay',
        topComments: [],
      });
      expect(entry).toContain('**My Marin Kitagawa**');
      expect(entry).toContain('↑800');
      expect(entry).not.toContain('>');
      expect(entry).not.toContain('热评');
    });

    it('should truncate long selftext to 200 chars', async () => {
      const { formatTrendEntry } = await import('../skill/scripts/fetch-trends');
      const longText = 'A'.repeat(300);
      const entry = formatTrendEntry({
        title: 'Test',
        score: 100,
        selftext: longText,
        subreddit: 'cosplay',
        topComments: [],
      });
      // The > line should contain at most ~200 chars of text
      const quoteLine = entry.split('\n').find(l => l.startsWith('   >'));
      expect(quoteLine!.length).toBeLessThanOrEqual(210); // 200 + prefix "   > " + "..."
    });

    it('should truncate comment bodies to 150 chars', async () => {
      const { formatTrendEntry } = await import('../skill/scripts/fetch-trends');
      const longComment = 'B'.repeat(200);
      const entry = formatTrendEntry({
        title: 'Test',
        score: 100,
        selftext: '',
        subreddit: 'cosplay',
        topComments: [longComment],
      });
      const commentLine = entry.split('\n').find(l => l.includes('热评'));
      expect(commentLine!.length).toBeLessThanOrEqual(175); // 150 + prefix + "..."
    });
  });

  describe('formatTrendSection', () => {
    it('should format a section with subreddit header and numbered entries', async () => {
      const { formatTrendSection } = await import('../skill/scripts/fetch-trends');
      const section = formatTrendSection('cosplay', [
        { title: 'Post 1', score: 500, selftext: 'text', subreddit: 'cosplay', topComments: [] },
        { title: 'Post 2', score: 300, selftext: '', subreddit: 'cosplay', topComments: ['nice'] },
      ]);
      expect(section).toContain('### r/cosplay');
      expect(section).toContain('1. **Post 1**');
      expect(section).toContain('2. **Post 2**');
    });
  });
});
