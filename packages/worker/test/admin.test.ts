import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAdminApp } from '../src/admin.ts';
import type { Bindings } from '../src/media.ts';
import { fakeR2 } from './fake-r2.ts';

const ISSUER = 'https://yolean-homepage.cloudflareaccess.com';
const AUD = 'aud-of-media-admin';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

async function setup(envOverrides: Partial<Bindings> = {}) {
  const r2 = fakeR2();
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k', alg: 'RS256' };
  // A second passes per call, so uploads have an order
  let t = Date.parse('2026-10-12T08:00:00Z');
  const app = createAdminApp({ jwks: () => createLocalJWKSet({ keys: [jwk] }), now: () => new Date((t += 1000) - 1000) });
  const env: Bindings = {
    MEDIA: r2.bucket, PUBLIC_BASE_URL: 'https://media.example', ACCESS_ISSUER: ISSUER, ACCESS_AUD: AUD, ACCESS_ALLOW: '@yolean.com, Partner@Place.example',
    ...envOverrides,
  };
  const token = (claims: Record<string, unknown> = { email: 'erica@yolean.com' }, opts: { aud?: string; iss?: string; exp?: string; key?: CryptoKey } = {}) =>
    new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k' })
      .setIssuer(opts.iss ?? ISSUER).setAudience(opts.aud ?? AUD).setIssuedAt().setExpirationTime(opts.exp ?? '5m')
      .sign(opts.key ?? privateKey);
  const call = async (path: string, init: RequestInit & { as?: string | null } = {}) => {
    const headers = new Headers(init.headers);
    const jwt = init.as === undefined ? await token() : init.as;
    if (jwt) headers.set('cf-access-jwt-assertion', jwt);
    return app.request(path, { ...init, headers }, env);
  };
  const upload = (body: Uint8Array, opts: { type?: string; sha256?: string; filename?: string; length?: string | null; labels?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { 'content-type': opts.type ?? 'image/png' };
    if (opts.length !== null) headers['content-length'] = opts.length ?? String(body.length);
    const q = new URLSearchParams({ sha256: opts.sha256 ?? sha(body), filename: opts.filename ?? 'logo.png', ...opts.labels });
    return call(`/api/v1/media?${q}`, { method: 'PUT', headers, body });
  };
  return { app, env, r2, token, call, upload };
}

describe('who may call', () => {
  it('takes the email from this application\'s Access token', async () => {
    const { call } = await setup();
    const res = await call('/api/v1/me');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { email: 'erica@yolean.com' });
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
  });

  it('refuses no token, another application\'s token, another issuer, an expired token, another key, no email, another domain', async () => {
    const { call, token } = await setup();
    const other = await generateKeyPair('RS256');
    const cases: Array<[string, string | null]> = [
      ['none', null],
      ['other aud', await token(undefined, { aud: 'another-app' })],
      ['other iss', await token(undefined, { iss: 'https://evil.cloudflareaccess.com' })],
      ['expired', await token(undefined, { exp: '-1m' })],
      ['other key', await token(undefined, { key: other.privateKey })],
      ['service token', await token({ common_name: 'svc.access' })],
      ['other domain', await token({ email: 'someone@example.com' })],
    ];
    for (const [name, jwt] of cases) {
      const res = await call('/api/v1/media', { as: jwt });
      assert.equal(res.status, 401, name);
    }
  });

  it('admits a domain, and exact addresses outside it, in any case', async () => {
    const { call, token } = await setup();
    for (const [email, status] of [
      ['ERICA@yolean.com', 200],
      ['partner@place.example', 200],
      ['other@place.example', 401],
      ['someone@notyolean.com', 401],
    ] as const) {
      const res = await call('/api/v1/me', { as: await token({ email }) });
      assert.equal(res.status, status, email);
    }
  });

  it('admits nobody until Access is configured', async () => {
    for (const missing of [{ ACCESS_AUD: '' }, { ACCESS_ISSUER: '' }, { ACCESS_ALLOW: ' , ' }]) {
      const { call } = await setup(missing);
      assert.equal((await call('/api/v1/me')).status, 401, JSON.stringify(missing));
    }
  });

  it('serves the OpenAPI document without a login, with every operation', async () => {
    const { call } = await setup();
    const res = await call('/api/v1/openapi.json', { as: null });
    assert.equal(res.status, 200);
    const doc = (await res.json()) as { paths: Record<string, Record<string, { operationId: string }>> };
    const ops = Object.values(doc.paths).flatMap((p) => Object.values(p).map((o) => o.operationId)).sort();
    assert.deepEqual(ops, ['deleteMedia', 'getMe', 'getMedia', 'labelMedia', 'listMedia', 'uploadMedia']);
  });
});

describe('upload', () => {
  it('names the file by its content, records who uploaded it, and is idempotent', async () => {
    const { upload, r2 } = await setup();
    const res = await upload(PNG, { filename: 'Logotyp NCC.png' });
    assert.equal(res.status, 201);
    const item = (await res.json()) as Record<string, unknown>;
    const name = `${sha(PNG).slice(0, 20)}.png`;
    assert.equal(item.name, name);
    assert.equal(item.url, `https://media.example/${name}`);
    assert.equal(item.uploadedBy, 'erica@yolean.com');
    assert.equal(item.uploadedAt, '2026-10-12T08:00:00.000Z');
    assert.equal(item.filename, 'Logotyp NCC.png');
    assert.equal(r2.entries.get(name)?.contentType, 'image/png');

    const again = await upload(PNG, { filename: 'other.png' });
    assert.equal(again.status, 200);
    assert.equal(((await again.json()) as Record<string, unknown>).filename, 'Logotyp NCC.png');
  });

  it('refuses a body that does not match its sha256, and stores nothing', async () => {
    const { upload, r2 } = await setup();
    const res = await upload(PNG, { sha256: sha(new Uint8Array([1])) });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, 'checksum-mismatch');
    assert.equal(r2.entries.size, 0);
  });

  it('refuses types that could run as a page, missing or oversized lengths, and a bad sha256', async () => {
    const { upload } = await setup();
    assert.equal((await upload(PNG, { type: 'image/svg+xml' })).status, 415);
    assert.equal((await upload(PNG, { type: 'text/html' })).status, 415);
    assert.equal((await upload(PNG, { length: null })).status, 411);
    assert.equal((await upload(PNG, { length: String(96 * 1024 * 1024) })).status, 413);
    assert.equal((await upload(PNG, { sha256: 'not-hex' })).status, 400);
  });
});

describe('list, get, delete', () => {
  it('lists newest first, gets one, deletes it', async () => {
    const { upload, call } = await setup();
    await upload(PNG);
    const mp4 = new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70]);
    await upload(mp4, { type: 'video/mp4', filename: 'clip.mp4' });

    const list = (await (await call('/api/v1/media')).json()) as { items: Array<{ name: string }>; truncated: boolean };
    assert.equal(list.items.length, 2);
    assert.equal(list.truncated, false);

    const name = `${sha(mp4).slice(0, 20)}.mp4`;
    assert.equal((await call(`/api/v1/media/${name}`)).status, 200);
    assert.equal((await call(`/api/v1/media/${name}`, { method: 'DELETE' })).status, 204);
    assert.equal((await call(`/api/v1/media/${name}`)).status, 404);
    assert.equal((await call(`/api/v1/media/${name}`, { method: 'DELETE' })).status, 404);
    assert.equal((await call('/api/v1/media/../../etc', { method: 'DELETE' })).status, 404);
  });
});

const bytes = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, n]);
const nameOf = (b: Uint8Array, ext = 'png') => `${sha(b).slice(0, 20)}.${ext}`;

describe('labels', () => {
  it('records labels at upload, and an asset\'s versions link back to the one they replaced', async () => {
    const { upload, call } = await setup();
    const [v1, v2, other] = [bytes(1), bytes(2), bytes(3)];
    const first = (await (await upload(v1, { filename: 'ncc.png', labels: { category: 'kundlogotyper', asset: 'ncc-logo', note: 'From NCC\'s press page' } })).json()) as Record<string, string>;
    assert.equal(first.category, 'kundlogotyper');
    assert.equal(first.asset, 'ncc-logo');
    assert.equal(first.supersedes, '');
    await upload(other, { labels: { asset: 'skanska-logo' } });
    const second = (await (await upload(v2, { filename: 'ncc-2026.png', labels: { asset: 'ncc-logo' } })).json()) as Record<string, string>;
    assert.equal(second.supersedes, nameOf(v1));
    assert.equal(second.name, nameOf(v2), 'the name is still the content hash');

    const listed = (await (await call('/api/v1/media?asset=ncc-logo')).json()) as { items: Array<{ name: string }> };
    assert.deepEqual(listed.items.map((i) => i.name), [nameOf(v2), nameOf(v1)], 'newest first');
    const byCategory = (await (await call('/api/v1/media?category=kundlogotyper')).json()) as { items: unknown[] };
    assert.equal(byCategory.items.length, 1);
  });

  it('works without a filename, which stays empty rather than becoming the name', async () => {
    const { call } = await setup();
    const b = bytes(9);
    const res = await call(`/api/v1/media?sha256=${sha(b)}`, { method: 'PUT', body: b, headers: { 'content-type': 'image/png', 'content-length': String(b.length) } });
    assert.equal(res.status, 201);
    assert.equal(((await res.json()) as Record<string, string>).filename, '');
  });

  it('changes labels without changing the file, records who, and removes a label given as empty', async () => {
    const { upload, call, r2 } = await setup();
    const b = bytes(4);
    await upload(b, { labels: { category: 'bilder', note: 'old note' } });
    const name = nameOf(b);
    const res = await call(`/api/v1/media/${name}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ asset: 'tavla-foto', alt: 'Tavlan i byggbaracken', note: '' }),
    });
    assert.equal(res.status, 200, await res.clone().text());
    const item = (await res.json()) as Record<string, string>;
    assert.deepEqual([item.asset, item.alt, item.note, item.category], ['tavla-foto', 'Tavlan i byggbaracken', '', 'bilder']);
    assert.equal(item.updatedBy, 'erica@yolean.com');
    assert.ok(item.updatedAt);
    assert.equal(item.uploadedBy, 'erica@yolean.com');
    assert.deepEqual(r2.entries.get(name)!.body, b, 'same bytes');
    assert.equal(r2.entries.get(name)!.customMetadata.note, undefined, 'an emptied label is not stored');
  });

  it('refuses malformed labels and metadata over R2\'s limit', async () => {
    const { upload, call } = await setup();
    assert.equal((await upload(bytes(5), { labels: { category: 'Kund Logotyper' } })).status, 400);
    assert.equal((await upload(bytes(5), { labels: { asset: 'ncc/logo' } })).status, 400);
    assert.equal((await upload(bytes(5), { labels: { note: 'x'.repeat(301) } })).status, 400);
    // Within each field's limit, too much together: € is one character but three bytes
    await upload(bytes(6), { filename: '€'.repeat(200) });
    const res = await call(`/api/v1/media/${nameOf(bytes(6))}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ alt: '€'.repeat(300), note: '€'.repeat(300) }),
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, 'labels-too-large');
    assert.equal((await call(`/api/v1/media/${nameOf(bytes(99))}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404);
  });
});

describe('the read-only UI', () => {
  it('lists files and shows one with its versions, escaping everything people typed', async () => {
    const { upload, call } = await setup();
    const evil = '<script>alert(1)</script>';
    await upload(bytes(1), { filename: `${evil}.png`, labels: { asset: 'ncc-logo', note: evil } });
    await upload(bytes(2), { labels: { asset: 'ncc-logo', category: 'kundlogotyper' } });

    const list = await call('/');
    assert.equal(list.status, 200);
    assert.match(list.headers.get('content-type')!, /text\/html/);
    assert.match(list.headers.get('content-security-policy')!, /^default-src 'none'; img-src https:\/\/media\.example;/);
    const listHtml = await list.text();
    assert.ok(!listHtml.includes(evil), 'no raw markup from labels');
    assert.ok(listHtml.includes('&lt;script&gt;'));
    assert.ok(listHtml.includes(`/files/${nameOf(bytes(2))}`));
    assert.ok(listHtml.includes('(older version)'));

    const filtered = await (await call('/?category=kundlogotyper')).text();
    assert.ok(filtered.includes(nameOf(bytes(2))) && !filtered.includes(`/files/${nameOf(bytes(1))}`));

    const detail = await (await call(`/files/${nameOf(bytes(1))}`)).text();
    assert.ok(!detail.includes(evil));
    assert.ok(detail.includes('Versions of ncc-logo'));
    assert.ok(detail.includes(`<a href="/files/${nameOf(bytes(2))}">`), 'links to the version that superseded it');
    assert.equal((await call('/files/nope.png')).status, 404);
  });

  it('needs the same login as the API', async () => {
    const { call } = await setup();
    assert.equal((await call('/', { as: null })).status, 401);
    assert.equal((await call(`/files/${nameOf(bytes(1))}`, { as: null })).status, 401);
  });
});
