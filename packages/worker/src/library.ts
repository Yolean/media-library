// Reading the library as a whole: the list behind the API, the UI and asset versions. Every
// label lives in the objects' customMetadata, which R2 returns with a listing, so this is
// one list call per thousand files and no other storage.
import { type MediaItem, NAME, itemOf } from './media.ts';

/** More than a website will ever hold; listing stops here and says so */
export const MAX_LIST = 5000;

export interface Filter { category?: string; asset?: string }

export async function listLibrary(bucket: R2Bucket, publicBaseUrl: string): Promise<{ items: MediaItem[]; truncated: boolean }> {
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ cursor, limit: 1000, include: ['customMetadata'] });
    objects.push(...page.objects.filter((o) => NAME.test(o.key)));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor && objects.length < MAX_LIST);
  const items = objects.map((o) => itemOf(o, publicBaseUrl)).sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  return { items, truncated: !!cursor };
}

/** A category matches itself and everything below it: "guider" matches "guider/pdf" */
export function matches(item: MediaItem, filter: Filter): boolean {
  if (filter.category && item.category !== filter.category && !item.category.startsWith(`${filter.category}/`)) return false;
  if (filter.asset && item.asset !== filter.asset) return false;
  return true;
}

/** An asset's files, newest first; the first is the one a page should use */
export const versionsOf = (items: MediaItem[], asset: string) => (asset ? items.filter((i) => i.asset === asset) : []);
