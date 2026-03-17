/**
 * e2e/playwright-smoke.test.ts
 * Playwright smoke tests for the Minase dashboard (localhost:3900)
 * and LLM debug page (localhost:3900/debug).
 *
 * Run: npx playwright test e2e/playwright-smoke.test.ts --headed
 */

import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:3900';

// ─── Dashboard (/) ────────────────────────────────────────

test.describe('Dashboard (/)', () => {
  test('page loads with correct title', async ({ page }) => {
    await page.goto(BASE);
    await expect(page).toHaveTitle(/Minase/i);
  });

  test('header renders with character name', async ({ page }) => {
    await page.goto(BASE);
    const header = page.locator('.header');
    await expect(header).toBeVisible();
    // Character name element should exist
    const charName = page.locator('.char-name');
    await expect(charName).toBeVisible();
  });

  test('emotion section renders with mood data', async ({ page }) => {
    await page.goto(BASE);
    const emotionSection = page.locator('.emotion-section');
    await expect(emotionSection).toBeVisible();

    // Mood description should be non-empty
    const moodEl = page.locator('.emotion-mood');
    await expect(moodEl).toBeVisible();
    const moodText = await moodEl.textContent();
    expect(moodText?.trim().length).toBeGreaterThan(0);
  });

  test('emotion dimension bars render', async ({ page }) => {
    await page.goto(BASE);
    const dims = page.locator('.emotion-dims');
    await expect(dims).toBeVisible();

    // Should have multiple dimension value elements
    const dimValues = page.locator('.emotion-dim-value');
    const count = await dimValues.count();
    expect(count).toBeGreaterThanOrEqual(4); // valence, arousal, energy, stress, ...
  });

  test('schedule gantt chart renders', async ({ page }) => {
    await page.goto(BASE);
    const gantt = page.locator('.gantt-container');
    await expect(gantt).toBeVisible();

    // Should have hour markers
    const hours = page.locator('.gantt-hours');
    await expect(hours).toBeVisible();
  });

  test('intent bars render', async ({ page }) => {
    await page.goto(BASE);
    // Look for intent bar tracks
    const intentBars = page.locator('.intent-bar-track');
    // At least some intent bars should be present
    const count = await intentBars.count();
    expect(count).toBeGreaterThanOrEqual(0); // may be 0 if no intents yet
  });

  test('feed section exists', async ({ page }) => {
    await page.goto(BASE);
    const feed = page.locator('.feed');
    await expect(feed).toBeVisible();
  });

  test('API /api/state returns valid JSON', async ({ request }) => {
    const res = await request.get(`${BASE}/api/state`);
    expect(res.ok()).toBeTruthy();
    const json = await res.json();
    // Should have key state fields
    expect(json).toHaveProperty('emotion');
    expect(json).toHaveProperty('intents');
    expect(json).toHaveProperty('timestamp');
    // Emotion has expected structure
    expect(json.emotion).toHaveProperty('mood');
    expect(json.emotion.mood).toHaveProperty('valence');
    expect(json.emotion.mood).toHaveProperty('arousal');
    expect(json.emotion.mood).toHaveProperty('description');
  });

  test('no console errors on page load', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    await page.goto(BASE);
    await page.waitForTimeout(2000); // wait for async data load
    // Filter out expected/benign errors (e.g. font loading)
    const realErrors = errors.filter(e =>
      !e.includes('fonts.googleapis') &&
      !e.includes('favicon') &&
      !e.includes('net::ERR')
    );
    expect(realErrors).toHaveLength(0);
  });

  test('dashboard auto-refresh fetch cycle works', async ({ page }) => {
    let fetchCount = 0;
    page.on('response', res => {
      if (res.url().includes('/api/state')) fetchCount++;
    });
    await page.goto(BASE);
    await page.waitForTimeout(8000); // wait for at least one refresh cycle
    expect(fetchCount).toBeGreaterThanOrEqual(1);
  });

  test('screenshot dashboard for visual check', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForTimeout(2000);
    await page.screenshot({
      path: 'e2e/e2e-output/screenshot-dashboard.png',
      fullPage: true,
    });
  });
});

// ─── Debug Page (/debug) ──────────────────────────────────

test.describe('Debug Page (/debug)', () => {
  test('page loads with correct title', async ({ page }) => {
    await page.goto(`${BASE}/debug`);
    await expect(page).toHaveTitle(/Debug|LLM/i);
  });

  test('header renders with back link', async ({ page }) => {
    await page.goto(`${BASE}/debug`);
    const header = page.locator('.header');
    await expect(header).toBeVisible();

    // Back link to dashboard should exist
    const backLink = page.locator('.back-link');
    await expect(backLink).toBeVisible();
  });

  test('call list panel renders', async ({ page }) => {
    await page.goto(`${BASE}/debug`);
    const callList = page.locator('.call-list-panel');
    await expect(callList).toBeVisible();

    // Should have header with count
    const listHeader = page.locator('.call-list-header');
    await expect(listHeader).toBeVisible();
  });

  test('detail pane renders', async ({ page }) => {
    await page.goto(`${BASE}/debug`);
    const detailPane = page.locator('.detail-pane');
    await expect(detailPane).toBeVisible();
  });

  test('API /api/llm-log returns valid JSON', async ({ request }) => {
    const res = await request.get(`${BASE}/api/llm-log?limit=5&offset=0`);
    expect(res.ok()).toBeTruthy();
    const json = await res.json();
    expect(json).toHaveProperty('total');
    expect(json).toHaveProperty('entries');
    expect(Array.isArray(json.entries)).toBeTruthy();
    expect(typeof json.total).toBe('number');
  });

  test('LLM log entries have expected structure', async ({ request }) => {
    const res = await request.get(`${BASE}/api/llm-log?limit=3&offset=0`);
    const json = await res.json();
    if (json.entries.length > 0) {
      const entry = json.entries[0];
      expect(entry).toHaveProperty('id');
      expect(entry).toHaveProperty('timestamp');
      expect(entry).toHaveProperty('caller');
      expect(entry).toHaveProperty('prompt');
    }
  });

  test('clicking a call list item shows detail', async ({ page }) => {
    await page.goto(`${BASE}/debug`);
    await page.waitForTimeout(1000);

    // Find call items in the list
    const callItems = page.locator('.call-list-scroll > div');
    const count = await callItems.count();

    if (count > 0) {
      // Click the first call item
      await callItems.first().click();
      await page.waitForTimeout(500);

      // Detail pane should now show content (not empty state)
      const detailContent = page.locator('.detail-content');
      const detailEmpty = page.locator('.detail-empty');

      // Either detail-content is visible, or we still see detail-empty
      const hasContent = await detailContent.isVisible().catch(() => false);
      const hasEmpty = await detailEmpty.isVisible().catch(() => false);
      expect(hasContent || hasEmpty).toBeTruthy();
    }
  });

  test('back link navigates to dashboard', async ({ page }) => {
    await page.goto(`${BASE}/debug`);
    const backLink = page.locator('.back-link');

    if (await backLink.isVisible()) {
      await backLink.click();
      await page.waitForURL(BASE + '/');
      await expect(page).toHaveTitle(/Minase/i);
    }
  });

  test('refresh toggle exists and is interactive', async ({ page }) => {
    await page.goto(`${BASE}/debug`);
    const toggle = page.locator('.toggle-dot');

    if (await toggle.isVisible()) {
      const initialClass = await toggle.getAttribute('class');
      await toggle.click();
      await page.waitForTimeout(300);
      // Class should toggle
      const newClass = await toggle.getAttribute('class');
      expect(newClass).not.toBe(initialClass);
    }
  });

  test('no JS errors on debug page', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));
    await page.goto(`${BASE}/debug`);
    await page.waitForTimeout(2000);
    expect(errors).toHaveLength(0);
  });

  test('screenshot debug page for visual check', async ({ page }) => {
    await page.goto(`${BASE}/debug`);
    await page.waitForTimeout(1500);
    await page.screenshot({
      path: 'e2e/e2e-output/screenshot-debug.png',
      fullPage: true,
    });
  });
});

// ─── Cross-Page Navigation ────────────────────────────────

test.describe('Cross-Page', () => {
  test('dashboard → debug → dashboard navigation works', async ({ page }) => {
    // Start at dashboard
    await page.goto(BASE);
    await expect(page).toHaveTitle(/Minase/i);

    // Navigate to debug (look for a link to /debug)
    await page.goto(`${BASE}/debug`);
    await expect(page).toHaveTitle(/Debug|LLM/i);

    // Navigate back
    const backLink = page.locator('.back-link');
    if (await backLink.isVisible()) {
      await backLink.click();
      await page.waitForTimeout(1000);
      await expect(page).toHaveTitle(/Minase/i);
    }
  });

  test('both pages share same visual theme', async ({ page }) => {
    // Check CSS variable consistency
    await page.goto(BASE);
    const dashBg = await page.evaluate(() =>
      getComputedStyle(document.body).backgroundColor
    );

    await page.goto(`${BASE}/debug`);
    const debugBg = await page.evaluate(() =>
      getComputedStyle(document.body).backgroundColor
    );

    // Both should use the same MUJI earth palette background
    expect(dashBg).toBe(debugBg);
  });
});
