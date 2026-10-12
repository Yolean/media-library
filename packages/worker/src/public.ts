// The public Worker: serves the library's files to anyone, read-only, at
// /<sha256 prefix>.<ext>. Nothing here writes, and nothing here needs a login.
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { type Bindings, IMMUTABLE, MediaName, NAME, TYPE_BY_EXT } from './media.ts';

const fileRoute = createRoute({
  operationId: 'getFile',
  method: 'get',
  path: '/{name}',
  summary: 'A file; HEAD, Range (video seeking) and If-None-Match are supported',
  request: { params: z.object({ name: MediaName }) },
  responses: {
    200: { description: 'The file' },
    206: { description: 'Part of the file' },
    304: { description: 'Not modified' },
    404: { description: 'No such file' },
    416: { description: 'Range not satisfiable' },
  },
});

/** Headers that make a file inert on this origin, whatever its bytes turn out to be */
function fileHeaders(ext: string): Headers {
  const headers = new Headers({
    'content-type': TYPE_BY_EXT[ext],
    'cache-control': IMMUTABLE,
    'accept-ranges': 'bytes',
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'cross-origin',
    'access-control-allow-origin': '*',
    // Chrome's PDF viewer refuses to run in a sandboxed document
    'content-security-policy': ext === 'pdf' ? 'default-src \'none\'' : 'default-src \'none\'; sandbox',
  });
  return headers;
}

const notFound = () => new Response('Not found\n', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });

export function createPublicApp() {
  const app = new OpenAPIHono<{ Bindings: Bindings }>({
    defaultHook: (result) => (result.success ? undefined : notFound()),
  });

  app.openapi(fileRoute, async (c) => {
    const { name } = c.req.valid('param');
    const ext = NAME.exec(name)![2];
    if (!TYPE_BY_EXT[ext]) return notFound();
    const headers = fileHeaders(ext);

    let object: R2Object | R2ObjectBody | null;
    try {
      object = await c.env.MEDIA.get(name, { onlyIf: c.req.raw.headers, range: c.req.raw.headers });
    } catch {
      // R2 rejects a Range header it cannot parse
      const head = await c.env.MEDIA.head(name);
      if (!head) return notFound();
      headers.set('content-range', `bytes */${head.size}`);
      return new Response(null, { status: 416, headers });
    }
    if (!object) return notFound();
    headers.set('etag', object.httpEtag);
    if (!('body' in object)) return new Response(null, { status: c.req.header('if-none-match') ? 304 : 412, headers });

    const rangeHeader = c.req.header('range');
    // R2 ignores a range starting past the end and returns the whole object; RFC 9110 says 416
    const firstByte = /^bytes=(\d+)-/.exec(rangeHeader ?? '')?.[1];
    if (firstByte !== undefined && Number(firstByte) >= object.size) {
      await object.body.cancel();
      headers.set('content-range', `bytes */${object.size}`);
      return new Response(null, { status: 416, headers });
    }
    // R2 returns every key, the unused ones undefined: {offset: 100, length: 100, suffix: undefined}
    const range = rangeHeader ? object.range as { offset?: number; length?: number; suffix?: number } | undefined : undefined;
    const whole = !range || ((range.offset ?? 0) === 0 && range.length === object.size);
    if (whole) {
      headers.set('content-length', String(object.size));
      return new Response(object.body, { status: 200, headers });
    }
    const suffix = typeof range.suffix === 'number' ? range.suffix : null;
    const start = suffix !== null ? Math.max(0, object.size - suffix) : (range.offset ?? 0);
    const length = Math.min(suffix !== null ? suffix : (range.length ?? object.size - start), object.size - start);
    headers.set('content-range', `bytes ${start}-${start + length - 1}/${object.size}`);
    headers.set('content-length', String(length));
    return new Response(object.body, { status: 206, headers });
  });

  app.doc('/openapi.json', {
    openapi: '3.0.3',
    info: { title: 'Media', version: '1', description: 'A media library\'s files, public and read-only (github.com/Yolean/media-library)' },
  });
  app.notFound(notFound);

  return app;
}

export default createPublicApp();
