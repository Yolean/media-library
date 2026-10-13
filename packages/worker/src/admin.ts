// The admin API, a Worker behind Cloudflare Access, described with zod so the document at
// /api/v1/openapi.json is what clients (bin/media-library) can rely on. Every call acts as
// the person signed in to Access; there are no shared keys.
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { JWTVerifyGetKey } from 'jose';
import { AccessError, accessEmail, accessJwks, accessToken, parseAllow } from './access.ts';
import { MAX_LIST, listLibrary, matches, versionsOf } from './library.ts';
import {
  Alt, AssetId, type Bindings, Category, type ContentType, LABELS, type Labels, MAX_METADATA_BYTES, MAX_UPLOAD_BYTES,
  MediaItem, MediaName, NAME, Note, Sha256, TYPES, itemOf, metadataBytes, nameFor, storedMetadata,
} from './media.ts';
import { filePage, listPage, uiCsp } from './ui.ts';
import { type Usage, readUsage, usesOf } from './usage.ts';

const Filter = z.object({
  category: Category.optional().describe('Only this category and those below it'),
  asset: AssetId.optional().describe('Only this asset\'s versions'),
});

const ErrorBody = z.object({ error: z.string(), message: z.string().optional() }).openapi('Error');
const error = (description: string) => ({ description, content: { 'application/json': { schema: ErrorBody } } });
const unauthenticated = { 401: error('No valid Access login') };
const security = [{ access: [] }];

const meRoute = createRoute({
  operationId: 'getMe',
  method: 'get',
  path: '/api/v1/me',
  summary: 'Who the API takes the caller to be; how the CLI checks a login works',
  security,
  responses: {
    200: { description: 'Signed in', content: { 'application/json': { schema: z.object({ email: z.string() }).openapi('Me') } } },
    ...unauthenticated,
  },
});

const UsageInfo = z.object({
  site: z.string(), revision: z.string().nullable(), builtAt: z.string(),
}).nullable().describe('The build the uses come from; null when the site provides no index or it could not be read').openapi('UsageInfo');

const listRoute = createRoute({
  operationId: 'listMedia',
  method: 'get',
  path: '/api/v1/media',
  summary: 'Every file in the library, newest first',
  security,
  request: { query: Filter },
  responses: {
    200: {
      description: 'The library',
      content: { 'application/json': { schema: z.object({
        items: z.array(MediaItem),
        truncated: z.boolean().describe(`More than ${MAX_LIST} files; only the first ${MAX_LIST} by name were read`),
        usage: UsageInfo,
      }).openapi('MediaList') } },
    },
    ...unauthenticated,
  },
});

const getRoute = createRoute({
  operationId: 'getMedia',
  method: 'get',
  path: '/api/v1/media/{name}',
  summary: 'One file\'s metadata',
  security,
  request: { params: z.object({ name: MediaName }) },
  responses: {
    200: { description: 'Found', content: { 'application/json': { schema: MediaItem } } },
    404: error('No such file'),
    ...unauthenticated,
  },
});

const uploadRoute = createRoute({
  operationId: 'uploadMedia',
  method: 'put',
  path: '/api/v1/media',
  summary: 'Add a file. Its name comes from its content, so uploading the same file again changes nothing.',
  description: `The body is the file, with Content-Type one of ${Object.keys(TYPES).join(', ')} and a `
    + `Content-Length of at most ${MAX_UPLOAD_BYTES} bytes. R2 checks the body against sha256 as it stores it.`,
  security,
  request: {
    query: z.object({
      sha256: Sha256,
      filename: z.string().max(200).optional().describe('The file\'s name on the uploader\'s machine, if known: a label, never the name'),
      alt: Alt.optional(),
      category: Category.optional(),
      asset: AssetId.optional().describe('Makes this file the asset\'s newest version; it records the previous one as supersedes'),
      note: Note.optional(),
    }),
    body: {
      required: true,
      content: Object.fromEntries(Object.keys(TYPES).map((t) => [t, { schema: z.string().openapi({ format: 'binary' }) }])),
    },
  },
  responses: {
    201: { description: 'Added', content: { 'application/json': { schema: MediaItem } } },
    200: { description: 'Already in the library; its labels are unchanged (change them with PATCH)', content: { 'application/json': { schema: MediaItem } } },
    400: error('Empty, labels too long for R2\'s metadata limit, or the body does not match sha256'),
    411: error('No Content-Length'),
    413: error('Too large'),
    415: error('Not an allowed type'),
    ...unauthenticated,
  },
});

const labelRoute = createRoute({
  operationId: 'labelMedia',
  method: 'patch',
  path: '/api/v1/media/{name}',
  summary: 'Change a file\'s labels; the file itself, and so its name and URL, stay the same',
  description: 'Fields left out are kept; an empty string removes one. Setting asset on a file '
    + 'starts or joins that asset; the next upload with the same asset becomes its newest version.',
  security,
  request: {
    params: z.object({ name: MediaName }),
    body: {
      required: true,
      content: { 'application/json': { schema: z.object({
        alt: Alt.or(z.literal('')).optional(),
        category: Category.or(z.literal('')).optional(),
        asset: AssetId.or(z.literal('')).optional(),
        note: Note.or(z.literal('')).optional(),
      }).openapi('Labels') } },
    },
  },
  responses: {
    200: { description: 'Changed', content: { 'application/json': { schema: MediaItem } } },
    400: error('Labels too long for R2\'s metadata limit'),
    404: error('No such file'),
    409: error('Changed by someone else at the same time; try again'),
    ...unauthenticated,
  },
});

const deleteRoute = createRoute({
  operationId: 'deleteMedia',
  method: 'delete',
  path: '/api/v1/media/{name}',
  summary: 'Remove a file. Pages that still use it break, and there is no undo.',
  description: 'Refused while the deployed site\'s build uses the file, or when that cannot be checked, unless force is set.',
  security,
  request: {
    params: z.object({ name: MediaName }),
    query: z.object({ force: z.enum(['true', 'false']).optional().describe('Remove even if the deployed site uses it') }),
  },
  responses: {
    204: { description: 'Removed' },
    404: error('No such file'),
    409: error('The deployed site uses it'),
    503: error('Whether the deployed site uses it could not be checked'),
    ...unauthenticated,
  },
});

export interface AdminDeps {
  jwks: (issuer: string) => JWTVerifyGetKey;
  now: () => Date;
}

type Env = { Bindings: Bindings; Variables: { email: string } };

const withUses = (usage: Usage) => (item: MediaItem): MediaItem =>
  (usage.state === 'none' ? item : { ...item, uses: usesOf(usage, item.name) });
const usageInfo = (usage: Usage) =>
  (usage.state === 'ok' ? { site: usage.index.site, revision: usage.index.revision, builtAt: usage.index.builtAt } : null);

const tooLarge = (bytes: number) => ({ error: 'labels-too-large', message: `${bytes} bytes of metadata, R2 allows ${MAX_METADATA_BYTES}` });

/** R2 needs a stream of known length to store; workerd provides FixedLengthStream, Node tests don't */
function sized(body: ReadableStream, length: number): ReadableStream {
  const Fixed = (globalThis as { FixedLengthStream?: new (n: number) => TransformStream }).FixedLengthStream;
  return Fixed ? body.pipeThrough(new Fixed(length)) : body;
}

/** R2 reports a body that does not match the given sha256 as an error on put */
const isChecksumMismatch = (err: unknown) => /sha-?256|checksum|digest/i.test((err as Error)?.message ?? '');

export function createAdminApp(deps: Partial<AdminDeps> = {}) {
  const { jwks = accessJwks, now = () => new Date() } = deps;
  const app = new OpenAPIHono<Env>();

  app.openAPIRegistry.registerComponent('securitySchemes', 'access', {
    type: 'apiKey', in: 'header', name: 'cf-access-token',
    description: 'A Cloudflare Access login: `cloudflared access token -app=<this origin>`. '
      + 'Access validates it at the edge and forwards it to the Worker as Cf-Access-Jwt-Assertion.',
  });

  // Every page and call but the API document needs the Access login: the UI as much as the API
  app.use('*', async (c, next) => {
    if (c.req.path === '/api/v1/openapi.json') return next();
    const { ACCESS_ISSUER: issuer, ACCESS_AUD: audience } = c.env;
    const allow = parseAllow(c.env.ACCESS_ALLOW);
    if (!issuer || !audience || allow.length === 0) return c.json({ error: 'unauthenticated', message: 'Access is not configured' }, 401);
    try {
      c.set('email', await accessEmail(accessToken(c.req.raw), { issuer, audience, allow }, jwks(issuer)));
    } catch (err) {
      if (err instanceof AccessError) return c.json({ error: 'unauthenticated', message: err.message }, 401);
      throw err;
    }
    c.header('cache-control', 'private, no-store');
    return next();
  });

  app.openapi(meRoute, (c) => c.json({ email: c.var.email }, 200));

  app.openapi(listRoute, async (c) => {
    const filter = c.req.valid('query');
    const [{ items, truncated }, usage] = await Promise.all([listLibrary(c.env.MEDIA, c.env.PUBLIC_BASE_URL), readUsage(c.env)]);
    return c.json({ items: items.filter((i) => matches(i, filter)).map(withUses(usage)), truncated, usage: usageInfo(usage) }, 200);
  });

  app.openapi(getRoute, async (c) => {
    const object = await c.env.MEDIA.head(c.req.valid('param').name);
    if (!object) return c.json({ error: 'not-found' }, 404);
    return c.json(withUses(await readUsage(c.env))(itemOf(object, c.env.PUBLIC_BASE_URL)), 200);
  });

  app.openapi(uploadRoute, async (c) => {
    const type = (c.req.header('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!(type in TYPES)) {
      return c.json({ error: 'unsupported-type', message: `${type || 'no Content-Type'}; allowed: ${Object.keys(TYPES).join(', ')}` }, 415);
    }
    const lengthHeader = c.req.header('content-length');
    if (!lengthHeader) return c.json({ error: 'length-required' }, 411);
    const length = Number(lengthHeader);
    if (!Number.isInteger(length) || length <= 0) return c.json({ error: 'empty', message: 'the body is empty' }, 400);
    if (length > MAX_UPLOAD_BYTES) return c.json({ error: 'too-large', message: `${length} bytes, at most ${MAX_UPLOAD_BYTES}` }, 413);

    const { sha256, filename, alt, category, asset, note } = c.req.valid('query');
    const name = nameFor(sha256, type as ContentType);
    const existing = await c.env.MEDIA.head(name);
    if (existing) return c.json(itemOf(existing, c.env.PUBLIC_BASE_URL), 200);

    // The asset's newest file until now; this upload supersedes it
    const supersedes = asset ? versionsOf((await listLibrary(c.env.MEDIA, c.env.PUBLIC_BASE_URL)).items, asset)[0]?.name : undefined;
    const customMetadata = storedMetadata({
      sha256, uploadedBy: c.var.email, uploadedAt: now().toISOString(), filename, alt, category, asset, supersedes, note,
    });
    const bytes = metadataBytes(customMetadata);
    if (bytes > MAX_METADATA_BYTES) return c.json(tooLarge(bytes), 400);

    let stored: R2Object;
    try {
      stored = await c.env.MEDIA.put(name, c.req.raw.body, { sha256, httpMetadata: { contentType: type }, customMetadata });
    } catch (err) {
      if (isChecksumMismatch(err)) return c.json({ error: 'checksum-mismatch', message: 'the body does not match sha256' }, 400);
      throw err;
    }
    console.log(JSON.stringify({ msg: 'media uploaded', name, by: c.var.email, size: stored.size, filename, category, asset, supersedes }));
    return c.json(itemOf(stored, c.env.PUBLIC_BASE_URL), 201);
  });

  app.openapi(labelRoute, async (c) => {
    const { name } = c.req.valid('param');
    const changes = c.req.valid('json') as Labels;
    const object = await c.env.MEDIA.get(name);
    if (!object) return c.json({ error: 'not-found' }, 404);
    const meta: Record<string, string> = { ...object.customMetadata };
    for (const key of LABELS) if (changes[key] !== undefined) meta[key] = changes[key]!;
    const customMetadata = storedMetadata({ ...meta, updatedBy: c.var.email, updatedAt: now().toISOString() });
    const bytes = metadataBytes(customMetadata);
    if (bytes > MAX_METADATA_BYTES) {
      await object.body.cancel();
      return c.json(tooLarge(bytes), 400);
    }
    // R2 has no metadata-only update: the same bytes are written back, checked against their
    // sha256, and only if nobody changed the object since it was read
    const stored = await c.env.MEDIA.put(name, sized(object.body, object.size), {
      sha256: meta.sha256 || undefined,
      httpMetadata: object.httpMetadata,
      customMetadata,
      onlyIf: { etagMatches: object.etag },
    });
    if (!stored) return c.json({ error: 'conflict', message: 'the file changed while its labels were written; try again' }, 409);
    console.log(JSON.stringify({ msg: 'media labelled', name, by: c.var.email, changes }));
    return c.json(itemOf(stored, c.env.PUBLIC_BASE_URL), 200);
  });

  app.openapi(deleteRoute, async (c) => {
    const { name } = c.req.valid('param');
    const force = c.req.valid('query').force === 'true';
    if (!(await c.env.MEDIA.head(name))) return c.json({ error: 'not-found' }, 404);
    const usage = await readUsage(c.env);
    if (!force && usage.state === 'unavailable') return c.json({ error: 'usage-unavailable', message: `${usage.reason}; force to remove anyway` }, 503);
    const uses = usesOf(usage, name);
    if (!force && uses.length) {
      return c.json({ error: 'in-use', message: `the deployed site uses it on ${uses.map((u) => u.page).join(', ')}; force to remove anyway` }, 409);
    }
    await c.env.MEDIA.delete(name);
    console.log(JSON.stringify({ msg: 'media deleted', name, by: c.var.email, force, uses: uses.map((u) => u.page) }));
    return c.body(null, 204);
  });

  app.get('/', async (c) => {
    const filter = Filter.safeParse(Object.fromEntries(Object.entries(c.req.query()).filter(([, v]) => v !== '')));
    const f = filter.success ? filter.data : {};
    const [{ items, truncated }, usage] = await Promise.all([listLibrary(c.env.MEDIA, c.env.PUBLIC_BASE_URL), readUsage(c.env)]);
    const all = items.map(withUses(usage));
    c.header('content-security-policy', uiCsp(c.env.PUBLIC_BASE_URL));
    return c.html(listPage(all.filter((i) => matches(i, f)), all, f, truncated, usage, c.var.email));
  });

  app.get('/files/:name', async (c) => {
    const name = c.req.param('name');
    if (!NAME.test(name)) return c.notFound();
    const [{ items }, usage] = await Promise.all([listLibrary(c.env.MEDIA, c.env.PUBLIC_BASE_URL), readUsage(c.env)]);
    const all = items.map(withUses(usage));
    const item = all.find((i) => i.name === name);
    if (!item) return c.notFound();
    c.header('content-security-policy', uiCsp(c.env.PUBLIC_BASE_URL));
    return c.html(filePage(item, versionsOf(all, item.asset), all.filter((i) => i.supersedes === name), usage, c.var.email));
  });

  app.doc('/api/v1/openapi.json', {
    openapi: '3.0.3',
    info: { title: 'Media library', version: '1', description: 'Images, videos and PDFs in EU R2, served by the public Worker (github.com/Yolean/media-library)' },
  });

  return app;
}

export default createAdminApp();
