/**
 * dailyhot-client.ts
 * Unified DailyHot API client with retry, content-type validation,
 * and structured diagnostics. Used by both adapter providers and test helpers.
 */

const DAILYHOT_DEFAULT_URL = 'https://hot.imsyy.top';
const FETCH_TIMEOUT = 10_000;
const RETRY_DELAY_MS = 2_000;

export interface DailyHotItem {
  id: number | string;
  title: string;
  url: string;
  hot: number;
  mobileUrl?: string;
}

export interface DailyHotFetchResult {
  platform: string;
  sourceUrl: string;
  items: DailyHotItem[];
  status: 'ok' | 'retry_ok' | 'fallback_ok' | 'failed';
  detail: string;
}

export interface DailyHotClientOptions {
  apiUrl?: string;
  /** Max retry attempts for transient errors (default: 1) */
  maxRetries?: number;
  /** Timeout per request in ms (default: 10_000) */
  timeout?: number;
}

/**
 * Resolve the DailyHot API base URL.
 * Priority: explicit option > DAILYHOT_API_URL env > default.
 */
export function resolveDailyHotUrl(explicitUrl?: string): string {
  return (explicitUrl
    ?? process.env.DAILYHOT_API_URL
    ?? DAILYHOT_DEFAULT_URL
  ).replace(/\/+$/, '');
}

/**
 * Fetch trending data for a single platform from the DailyHot API.
 * Validates content-type, HTTP status, and response structure.
 * Retries once on 5xx before reporting failure.
 */
export async function fetchDailyHotPlatform(
  platform: string,
  options?: DailyHotClientOptions,
): Promise<DailyHotFetchResult> {
  const baseUrl = resolveDailyHotUrl(options?.apiUrl);
  const maxRetries = options?.maxRetries ?? 1;
  const timeout = options?.timeout ?? FETCH_TIMEOUT;
  const url = `${baseUrl}/${platform}`;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(timeout),
      });

      // Reject non-2xx
      if (!res.ok) {
        const detail = `HTTP ${res.status} from ${url}`;
        if (attempt < maxRetries && res.status >= 500) {
          console.warn(`[dailyhot-client] ${detail}, retrying in ${RETRY_DELAY_MS}ms...`);
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
          continue;
        }
        return { platform, sourceUrl: url, items: [], status: 'failed', detail };
      }

      // Validate content-type — reject HTML responses
      const contentType = res.headers.get('content-type') ?? '';
      if (!contentType.includes('application/json') && !contentType.includes('text/json')) {
        // Some APIs return JSON without proper content-type; try to parse anyway
        // but if it starts with '<', it's definitely HTML
        const text = await res.text();
        if (text.trimStart().startsWith('<')) {
          const detail = `Non-JSON response (content-type: ${contentType}) from ${url}`;
          return { platform, sourceUrl: url, items: [], status: 'failed', detail };
        }
        // Try parsing the text as JSON
        try {
          const json = JSON.parse(text) as { code?: number; data?: DailyHotItem[] };
          if (json.code !== 200 || !Array.isArray(json.data)) {
            return { platform, sourceUrl: url, items: [], status: 'failed', detail: `Invalid DailyHot response structure from ${url}` };
          }
          return {
            platform,
            sourceUrl: url,
            items: json.data,
            status: attempt > 0 ? 'retry_ok' : 'ok',
            detail: `${json.data.length} items (parsed from text)`,
          };
        } catch {
          return { platform, sourceUrl: url, items: [], status: 'failed', detail: `Unparseable response from ${url}` };
        }
      }

      // Standard JSON path
      const json = await res.json() as { code?: number; data?: DailyHotItem[] };
      if (json.code !== 200 || !Array.isArray(json.data)) {
        return { platform, sourceUrl: url, items: [], status: 'failed', detail: `Invalid DailyHot response structure (code=${json.code}) from ${url}` };
      }

      return {
        platform,
        sourceUrl: url,
        items: json.data,
        status: attempt > 0 ? 'retry_ok' : 'ok',
        detail: `${json.data.length} items`,
      };
    } catch (err) {
      const detail = `${(err as Error).message} from ${url}`;
      if (attempt < maxRetries) {
        console.warn(`[dailyhot-client] ${detail}, retrying in ${RETRY_DELAY_MS}ms...`);
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      return { platform, sourceUrl: url, items: [], status: 'failed', detail };
    }
  }

  // Should not reach here, but TypeScript needs it
  return { platform, sourceUrl: url, items: [], status: 'failed', detail: 'exhausted retries' };
}
