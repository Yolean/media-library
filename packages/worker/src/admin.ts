// The admin API, a Worker behind Cloudflare Access, described with zod so the document at
// /api/v1/openapi.json is what clients (bin/media-library) can rely on. Every call acts as
// the person signed in to Access; there are no shared keys.
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { JWTVerifyGetKey } from 'jose';
import { AccessError, accessEmail, accessJwks, accessToken, parseAllow } from './access.ts';
import {
  type Bindings, type ContentType, MAX_UPLOAD_BYTES, MediaItem, MediaName, NAME, Sha256, TYPES,
  itemOf, nameFor, storedMetadata,
} from './media.ts';

/** More than a homepage will ever hold; listing stops here and says so */
const MAX_LIST = 5000;

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

const listRoute = createRoute({
  operationId: 'listMedia',
  method: 'get',
  path: '/api/v1/media',
  summary: 'Every file in the library, newest first',
  security,
  responses: {
    200: {
      description: 'The library',
      content: { 'application/json': { schema: z.object({
        items: z.array(MediaItem),
        truncated: z.boolean().describe(`More than ${MAX_LIST} files; only the first ${MAX_LIST} by name were read`),
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
      filename: z.string().min(1).max(200).describe('The file\'s name on the uploader\'s machine, for people browsing the library'),
      alt: z.string().max(500).optional().describe('Suggested alt text'),
    }),
    body: {
      required: true,
      content: Object.fromEntries(Object.keys(TYPES).map((t) => [t, { schema: z.string().openapi({ format: 'binary' }) }])),
    },
  },
  responses: {
    201: { description: 'Added', content: { 'application/json': { schema: MediaItem } } },
    200: { description: 'Already in the library; its metadata is unchanged', content: { 'application/json': { schema: MediaItem } } },
    400: error('Empty, or the body does not match sha256'),
    411: error('No Content-Length'),
    413: error('Too large'),
    415: error('Not an allowed type'),
    ...unauthenticated,
  },
});

const deleteRoute = createRoute({
  operationId: 'deleteMedia',
  method: 'delete',
  path: '/api/v1/media/{name}',
  summary: 'Remove a file. Pages that still use it break, and there is no undo.',
  security,
  request: { params: z.object({ name: MediaName }) },
  responses: {
    204: { description: 'Removed' },
    404: error('No such file'),
    ...unauthenticated,
  },
});

export interface AdminDeps {
  jwks: (issuer: string) => JWTVerifyGetKey;
  now: () => Date;
}

type Env = { Bindings: Bindings; Variables: { email: string } };

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

  app.use('/api/v1/*', async (c, next) => {
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
    const objects: R2Object[] = [];
    let cursor: string | undefined;
    do {
      const page = await c.env.MEDIA.list({ cursor, limit: 1000, include: ['customMetadata'] });
      objects.push(...page.objects.filter((o) => NAME.test(o.key)));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor && objects.length < MAX_LIST);
    const items = objects.map((o) => itemOf(o, c.env.PUBLIC_BASE_URL))
      .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
    return c.json({ items, truncated: !!cursor }, 200);
  });

  app.openapi(getRoute, async (c) => {
    const object = await c.env.MEDIA.head(c.req.valid('param').name);
    if (!object) return c.json({ error: 'not-found' }, 404);
    return c.json(itemOf(object, c.env.PUBLIC_BASE_URL), 200);
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

    const { sha256, filename, alt } = c.req.valid('query');
    const name = nameFor(sha256, type as ContentType);
    const existing = await c.env.MEDIA.head(name);
    if (existing) return c.json(itemOf(existing, c.env.PUBLIC_BASE_URL), 200);

    let stored: R2Object;
    try {
      stored = await c.env.MEDIA.put(name, c.req.raw.body, {
        sha256,
        httpMetadata: { contentType: type },
        customMetadata: storedMetadata({ sha256, uploadedBy: c.var.email, uploadedAt: now().toISOString(), filename, alt: alt ?? '' }),
      });
    } catch (err) {
      if (isChecksumMismatch(err)) return c.json({ error: 'checksum-mismatch', message: 'the body does not match sha256' }, 400);
      throw err;
    }
    console.log(JSON.stringify({ msg: 'media uploaded', name, by: c.var.email, size: stored.size, filename }));
    return c.json(itemOf(stored, c.env.PUBLIC_BASE_URL), 201);
  });

  app.openapi(deleteRoute, async (c) => {
    const { name } = c.req.valid('param');
    if (!(await c.env.MEDIA.head(name))) return c.json({ error: 'not-found' }, 404);
    await c.env.MEDIA.delete(name);
    console.log(JSON.stringify({ msg: 'media deleted', name, by: c.var.email }));
    return c.body(null, 204);
  });

  app.doc('/api/v1/openapi.json', {
    openapi: '3.0.3',
    info: { title: 'Media library', version: '1', description: 'Images, videos and PDFs in EU R2, served by the public Worker (github.com/Yolean/media-library)' },
  });

  return app;
}

export default createAdminApp();
