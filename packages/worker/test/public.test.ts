import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicApp } from '../src/public.ts';
import type { Bindings } from '../src/media.ts';
import { fakeR2 } from './fake-r2.ts';

const BODY = new Uint8Array(Array.from({ length: 100 }, (_, i) => i));
const NAME = '0123456789abcdef0123.mp4';

async function setup() {
  const r2 = fakeR2();
  await r2.bucket.put(NAME, new Blob([BODY]).stream(), { httpMetadata: { contentType: 'text/html' } });
  const env = { MEDIA: r2.bucket, PUBLIC_BASE_URL: 'https://media.example' } as Bindings;
  const app = createPublicApp();
  return { get: (path: string, headers: Record<string, string> = {}, method = 'GET') => app.request(path, { method, headers }, env) };
}

describe('public files', () => {
  it('serves a file with the type of its extension, not the stored one, inert and immutable', async () => {
    const { get } = await setup();
    const res = await get(`/${NAME}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'video/mp4');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-security-policy')!, /sandbox/);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(res.headers.get('content-length'), '100');
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), BODY);
  });

  it('serves ranges, for video seeking', async () => {
    const { get } = await setup();
    const res = await get(`/${NAME}`, { range: 'bytes=10-19' });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('content-range'), 'bytes 10-19/100');
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), BODY.slice(10, 20));
    const suffix = await get(`/${NAME}`, { range: 'bytes=-5' });
    assert.equal(suffix.headers.get('content-range'), 'bytes 95-99/100');
    assert.equal((await get(`/${NAME}`, { range: 'bytes=500-' })).status, 416);
  });

  it('answers If-None-Match with 304', async () => {
    const { get } = await setup();
    const etag = (await get(`/${NAME}`)).headers.get('etag')!;
    assert.equal((await get(`/${NAME}`, { 'if-none-match': etag })).status, 304);
  });

  it('serves its OpenAPI document', async () => {
    const { get } = await setup();
    const res = await get('/openapi.json');
    assert.equal(res.status, 200);
    const doc = (await res.json()) as { paths: Record<string, Record<string, { operationId: string }>> };
    assert.equal(doc.paths['/{name}'].get.operationId, 'getFile');
  });

  it('serves nothing but well-formed names of allowed types', async () => {
    const { get } = await setup();
    for (const path of ['/', '/0123456789abcdef0124.mp4', '/0123456789abcdef0123.html', '/..%2f..%2fx', '/api/v1/media', '/0123456789ABCDEF0123.mp4']) {
      assert.equal((await get(path)).status, 404, path);
    }
    assert.equal((await get(`/${NAME}`, {}, 'PUT')).status, 404);
  });
});
