/**
 * The single seam between "where data comes from" and "how it is drawn".
 *
 * Renderers and UI panels must never read files directly - they receive a
 * `SimulationDataProvider`. Replacing placeholder data with real simulation
 * output means adding one provider implementation and pointing `config.ts` at
 * it; nothing else changes.
 */

import type {
  DisruptionVM,
  NetworkGraph,
  StatBundle,
  TimeRange,
  VesselTrackSet,
} from './types';

export interface ProviderContext {
  /** Absolute or relative base URL for `public/data`. */
  baseUrl: string;
  signal?: AbortSignal;
}

export interface SimulationDataProvider {
  readonly id: string;
  init(ctx: ProviderContext): Promise<void>;
  getStaticGraph(): Promise<NetworkGraph>;
  getMotion(range: TimeRange): Promise<VesselTrackSet>;
  getDisruptions(): Promise<DisruptionVM[]>;
  getStats(): Promise<StatBundle>;
  dispose?(): void;
}

/** Minimal CSV reader: handles quoted fields and thousands separators. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ''));
}

/** "1,234" | "6.97%" | "-" -> number (NaN when not numeric). */
export function toNumber(raw: string | undefined): number {
  if (raw === undefined) return NaN;
  const cleaned = raw.replace(/,/g, '').replace(/%/g, '').trim();
  if (cleaned === '' || cleaned === '-') return NaN;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : NaN;
}

/**
 * A missing asset on a static host usually comes back as the SPA fallback:
 * HTTP 200 with `index.html`. `response.ok` is true, and `response.json()`
 * then fails with the famously unhelpful "Unexpected token '<'". Detect the
 * HTML case and say what actually happened.
 */
function assertAssetResponse(
  url: string,
  response: Response,
  expected: 'JSON' | 'CSV',
): void {
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('text/html')) return;

  throw new Error(
    `Expected ${expected} from ${url} but received an HTML page. ` +
      `The file is probably missing on the server (the SPA fallback returned index.html). ` +
      `Deploy the *contents* of dist/ so that data/ sits next to index.html, ` +
      `or point the app at the right directory with ?data=/your/data. ` +
      `Run "npm run check:dist" before deploying to catch this.`,
  );
}

export async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Failed to load ${url}: HTTP ${response.status}`);
  }
  assertAssetResponse(response.url || url, response, 'JSON');
  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new Error(
      `Failed to parse JSON from ${response.url || url}: ${describe(error)}. ` +
        `If this file exists, check that it is valid JSON and not an HTML error page.`,
    );
  }
}

export async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Failed to load ${url}: HTTP ${response.status}`);
  }
  assertAssetResponse(response.url || url, response, 'CSV');
  return await response.text();
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
