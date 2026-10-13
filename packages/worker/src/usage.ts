// Where a site uses the library's files, as its own build saw it. A project's build writes a
// media usage index (the format below) into what it deploys; the admin Worker reads it through
// a service binding to that site's Worker (USAGE), so no credentials are involved and Access
// is not in the way. It knows only what the deployed build references: a file with no known
// use may still be used by a branch, a preview or another site.
import { z } from '@hono/zod-openapi';

export const MediaUsageIndex = z.object({
  v: z.literal(1),
  site: z.string().url().describe('The site the build was for, e.g. https://next.yolean.workers.dev'),
  revision: z.string().nullable().describe('The commit the build was made from'),
  builtAt: z.string().datetime(),
  pages: z.record(z.string(), z.object({ title: z.string() })).describe('Page id (its path or #/route) → title'),
  uses: z.record(z.string(), z.array(z.string())).describe('Media file name → the page ids that use it: a path or #/route, '
    + '"shared" for site-wide parts, or another id the site defines in pages (e.g. "script": referenced, but no page shows it)'),
}).openapi('MediaUsageIndex');
export type MediaUsageIndex = z.infer<typeof MediaUsageIndex>;

export const Use = z.object({
  page: z.string().describe('Page id, e.g. #/priser, or "shared" for site-wide parts such as the header'),
  title: z.string(),
  url: z.string().describe('Where to see it'),
}).openapi('Use');
export type Use = z.infer<typeof Use>;

export interface UsageBindings {
  /** Service binding to the site's Worker; unset means no usage is known */
  USAGE?: Fetcher;
  /** Where the site serves its index; default /media-usage.json */
  USAGE_PATH?: string;
}

export type Usage =
  | { state: 'none' }
  | { state: 'unavailable'; reason: string }
  | { state: 'ok'; index: MediaUsageIndex };

const CACHE_MS = 60_000;
let cached: { at: number; usage: Usage } | null = null;

/** The deployed site's index, re-read at most once a minute per isolate */
export async function readUsage(env: UsageBindings, now = Date.now()): Promise<Usage> {
  if (!env.USAGE) return { state: 'none' };
  if (cached && now - cached.at < CACHE_MS) return cached.usage;
  let usage: Usage;
  try {
    const res = await env.USAGE.fetch(`https://usage.internal${env.USAGE_PATH ?? '/media-usage.json'}`);
    if (!res.ok) throw new Error(`${res.status}`);
    const parsed = MediaUsageIndex.safeParse(await res.json());
    usage = parsed.success ? { state: 'ok', index: parsed.data } : { state: 'unavailable', reason: 'the index does not match its format' };
  } catch (err) {
    usage = { state: 'unavailable', reason: `the site's index could not be read: ${(err as Error).message}` };
  }
  cached = { at: now, usage };
  return usage;
}

/** For tests: forget the cached index */
export const resetUsageCache = () => { cached = null; };

export function usesOf(usage: Usage, name: string): Use[] {
  if (usage.state !== 'ok') return [];
  const { index } = usage;
  const site = index.site.replace(/\/$/, '');
  return (index.uses[name] ?? []).map((page) => ({
    page,
    title: page === 'shared' ? 'Every page (shared parts)' : (index.pages[page]?.title ?? page),
    // Only paths and #/routes are addresses; anything else links to the site
    url: /^[#/]/.test(page) ? `${site}/${page.replace(/^\//, '')}` : `${site}/`,
  }));
}
