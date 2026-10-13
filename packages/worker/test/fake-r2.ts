// An in-memory R2 bucket with the parts of the binding's behaviour the Workers rely on:
// put verifying sha256, list with customMetadata, get with Range and If-None-Match.
// The real thing is exercised by test/e2e.ts against wrangler dev's local R2.
import { createHash } from 'node:crypto';

interface Entry { body: Uint8Array; contentType?: string; customMetadata: Record<string, string>; uploaded: Date; etag: string }

function object(key: string, e: Entry, range?: { offset: number; length: number; suffix?: number }) {
  return {
    key,
    size: e.body.length,
    etag: e.etag,
    httpEtag: `"${e.etag}"`,
    uploaded: e.uploaded,
    httpMetadata: { contentType: e.contentType },
    customMetadata: e.customMetadata,
    ...(range ? { range } : {}),
  };
}

function parseRange(header: string | null, size: number): { offset: number; length: number } | undefined {
  const m = header && /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m) return undefined;
  if (m[1] === '') return { offset: size - Number(m[2]), length: Number(m[2]) };
  const offset = Number(m[1]);
  // As local R2 does: a range starting past the end is ignored
  if (offset >= size) return { offset: 0, length: size };
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  return { offset, length: end - offset + 1 };
}

export function fakeR2() {
  const entries = new Map<string, Entry>();
  let writes = 0;
  const bucket = {
    async head(key: string) {
      const e = entries.get(key);
      return e ? object(key, e) : null;
    },
    async get(key: string, opts: { onlyIf?: Headers; range?: Headers } = {}) {
      const e = entries.get(key);
      if (!e) return null;
      if (opts.onlyIf?.get('if-none-match') === `"${e.etag}"`) return object(key, e);
      const range = parseRange(opts.range?.get('range') ?? null, e.body.length);
      const bytes = range ? e.body.slice(range.offset, range.offset + range.length) : e.body;
      // As R2 does: all three keys, the unused one undefined
      return { ...object(key, e, range ? { offset: range.offset, length: range.length, suffix: undefined } : undefined), body: new Blob([bytes]).stream() };
    },
    async put(key: string, value: ReadableStream | null, opts: { sha256?: string; httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string>; onlyIf?: { etagMatches?: string } }) {
      const body = new Uint8Array(await new Response(value).arrayBuffer());
      // As R2 does: a failed precondition stores nothing and returns null
      if (opts.onlyIf?.etagMatches && entries.get(key)?.etag !== opts.onlyIf.etagMatches) return null;
      const sha256 = createHash('sha256').update(body).digest('hex');
      if (opts.sha256 && opts.sha256 !== sha256) throw new Error('put: The SHA-256 checksum you specified did not match what we received.');
      // R2's etag changes with every write, metadata included
      const e = { body, contentType: opts.httpMetadata?.contentType, customMetadata: opts.customMetadata ?? {}, uploaded: new Date(), etag: `${sha256.slice(0, 24)}${String(++writes).padStart(8, '0')}` };
      entries.set(key, e);
      return object(key, e);
    },
    async list(opts: { cursor?: string; limit?: number } = {}) {
      const keys = [...entries.keys()].sort();
      const start = opts.cursor ? Number(opts.cursor) : 0;
      const page = keys.slice(start, start + (opts.limit ?? 1000));
      const next = start + page.length;
      return { objects: page.map((k) => object(k, entries.get(k)!)), truncated: next < keys.length, cursor: String(next), delimitedPrefixes: [] };
    },
    async delete(key: string) {
      entries.delete(key);
    },
  };
  return { bucket: bucket as unknown as R2Bucket, entries };
}
