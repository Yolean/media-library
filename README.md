# media-library

A media library for a website on Cloudflare: images, videos and PDFs in one R2 bucket in
Cloudflare's EU jurisdiction, served publicly by one Worker and managed through another,
behind Cloudflare Access. People and their agents use the same command line tool, signed in
as themselves; browsing is the Cloudflare dashboard's R2 view.

Built for Yolean's homepage (`Yolean/homepage`, `cloudflare/`) and the pull planning workshop
(`Yolean/pull-planning-workshop`). Each project deploys its own pair of Workers, on its own
Cloudflare account, from the packages here.

| Package | What |
|---|---|
| [`packages/worker`](packages/worker) `@yolean/media-library-worker` | `./public` and `./admin`: the two Workers, Hono with `@hono/zod-openapi` |
| [`packages/cli`](packages/cli) `@yolean/media-library-cli` | `media-library`: ls, upload, info, rm, whoami, through `cloudflared` |
| [`packages/e2e`](packages/e2e) (private) | the example deployment, its EU storage test, and the end-to-end test |

## How it works

| Worker | Serves | Login |
|---|---|---|
| public (e.g. `media`) | `GET`/`HEAD /<name>`, with Range and If-None-Match; `/openapi.json` | none |
| admin (e.g. `media-admin`) | `/api/v1/me`, `/api/v1/media` (list, upload), `/api/v1/media/{name}` (get, delete); `/api/v1/openapi.json` | Cloudflare Access |

- **Names come from content**: the first 20 hex of the file's sha256 and the extension for
  its type (`3fab80933e4cbe1806e0.mp4`). A file is never replaced, so it is served with
  `Cache-Control: immutable`, and uploading the same file twice is a no-op that returns the
  same URL. The client sends the sha256 and R2 checks the body against it while storing, so
  the Worker never hashes (the Workers Free plan has 10 ms CPU per request).
- **Types**: jpg, png, webp, avif, gif, mp4, webm, pdf, up to 95 MiB (the Free plan's request
  body limit is 100 MB). No SVG or HTML: nothing that could run as a document on the media
  origin. The public Worker sends the type for the extension, never a stored one, with
  `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`
  (no `sandbox` for PDF, which Chrome's viewer refuses).
- **Who**: the admin Worker verifies the Access token itself - issuer, this application's
  audience, RS256 signature, expiry - so a token Access issued for another application of the
  same team is refused, and so is a request that reaches the Worker without Access. The email
  must match `ACCESS_ALLOW` (domains like `@yolean.com`, or exact addresses), it is stored on
  each upload as `uploadedBy`, and deletions are logged with it. Unconfigured, it admits
  nobody. Access service tokens carry no email and are refused: media is always managed on
  behalf of a person.
- **Two Workers, not one**: the public one contains no write path at all, and the admin one
  can sit behind Access as a whole (the workers.dev Access toggle is per Worker).
- **Storage**: one R2 binding, `MEDIA`, `jurisdiction: "eu"`. Nothing else: no KV (which may
  cache outside its jurisdiction), no D1, no state of its own beyond the objects and their
  `customMetadata`.

## The command line

`media-library` runs `cloudflared` (Cloudflare's CLI) to sign the person in through Access -
a browser window, once per session lifetime - and sends their token with every call. On macOS
it downloads a pinned `cloudflared` into `~/.cache/yolean-media-library/` and checks both
sha256s Cloudflare publishes: the archive's (GitHub's asset digest) and the binary's (the
release notes hash the binary inside the `.tgz`, not the `.tgz`). Elsewhere it uses
`cloudflared` from `PATH`.

```
media-library ls [--json]                         every file, newest first, with who uploaded it
media-library upload <file> [--alt <text>] [--json]   prints the public URL
media-library info <name> [--json]
media-library rm <name> [--force]                 refused while a project file still uses it
media-library whoami
media-library login
```

## Using it in a project

1. Dependencies, pinned to a tag (no npm registry involved; the repository is public):
   ```bash
   pnpm add 'github:Yolean/media-library#v0.1.2&path:/packages/worker'
   pnpm add -D 'github:Yolean/media-library#v0.1.2&path:/packages/cli'
   ```
2. Two entry files:
   ```ts
   // public.ts
   export { default } from '@yolean/media-library-worker/public';
   // admin.ts
   export { default } from '@yolean/media-library-worker/admin';
   ```
3. A `wrangler.jsonc` shaped like [`packages/e2e/wrangler.jsonc`](packages/e2e/wrangler.jsonc):
   the project's `account_id`, bucket name and `PUBLIC_BASE_URL`; copy
   [`config.test.ts`](packages/e2e/config.test.ts) next to it.
4. A wrapper the project's people and agents run, setting the CLI's environment:
   ```bash
   #!/usr/bin/env bash
   export MEDIA_CWD="$PWD"
   cd "$(dirname "$0")/.."
   export MEDIA_ADMIN_URL=https://media-admin.<subdomain>.workers.dev
   export MEDIA_REFERENCED_BY=../index.html     # files whose references rm protects
   export MEDIA_COMMAND=bin/media               # for the usage text
   exec node_modules/.bin/media-library "$@"
   ```
5. On the account:
   ```bash
   wrangler r2 bucket create <bucket> --jurisdiction eu
   wrangler deploy -c wrangler.jsonc && wrangler deploy -c wrangler.jsonc --env admin
   ```
   Then a Zero Trust organization (Free: up to 50 users) with its login methods - Google for
   Yolean accounts, and Access's built-in **One-time PIN** for people without one (a partner's
   employee gets a code by email) - and, on the admin Worker, Settings → Domains & Routes →
   workers.dev → enable Cloudflare Access. In the application it creates: those login methods,
   and an Allow policy matching `ACCESS_ALLOW`. Put its AUD tag in `ACCESS_AUD`, the team's
   `https://<team>.cloudflareaccess.com` in `ACCESS_ISSUER`, and deploy the admin Worker again.
6. Check: `bin/media whoami` prints your email.

## Compared with R2-Explorer

[R2-Explorer](https://github.com/G4brym/R2-Explorer) is the common open-source way to put a
UI on R2 from a Worker, and we considered running it instead. Reviewed at v1.2.0 (commit
`2c09ecb`, 2026-10-12): about 3,300 lines of Worker code plus a Vue dashboard, MIT, since
2022, mostly one maintainer.

| | R2-Explorer 1.2.0 | media-library |
|---|---|---|
| Purpose | general file manager for any R2 bucket | media for one website |
| UI | its own dashboard | none: the Cloudflare dashboard's R2 view, and the CLI |
| Access token check | `@hono/cloudflare-access` without an audience: **any** application's token from the team is accepted (the middleware logs a warning) | issuer, audience, signature, expiry; plus `ACCESS_ALLOW` |
| No login configured | API open (read-only by default) | admits nobody |
| Public access | `/share/:id` links, created by any signed-in user, optionally never expiring; share records are ordinary objects in the same bucket, so an uploader can write one | a separate Worker serving only content-addressed names, read-only |
| Which bucket | from the URL, `c.env[bucketName]`: any binding of the Worker can be addressed | one binding, `MEDIA` |
| Upload rules | any key, any content type | allowlisted types, size cap, name from content, R2 verifies sha256 |
| Serving | stored content type, `Content-Disposition: attachment` | type from extension, `nosniff`, sandboxing CSP, Range for video, immutable caching |
| Who uploaded | known, not stored on uploads | `uploadedBy` on every object, deletions logged |
| Other features | email receive and send, folders, move/copy, multipart, metadata editing | none |
| Code | Hono, chanfana 2, zod 3; keys as base64 decoded with `escape()` | Hono, `@hono/zod-openapi`, zod 4, jose; about 700 lines with the CLI |

R2-Explorer is the better choice for browsing and sharing arbitrary files. For a website's
media, most of its surface is something we would have to switch off or wrap, and its Access
integration would need patching; the Cloudflare dashboard already covers browsing.

## Limits

- No undo: `rm` deletes the object (R2 has no versioning). The CLI refuses while a file
  listed in `MEDIA_REFERENCED_BY` mentions it.
- Listing reads at most 5,000 objects (it says when it stopped).
- No image resizing or format conversion; upload the sizes the page needs.
- The type is the extension the uploader gave; a file that isn't what its extension says is
  served inert and simply fails to render.
- Free plan: every file request runs the public Worker (100,000 requests a day). On a custom
  domain in a Cloudflare zone, the bucket can instead be public through R2 with Cloudflare's
  cache in front.

## Development

```bash
pnpm install
pnpm run checks    # typecheck and unit tests of every package, and the EU storage rule
pnpm run e2e       # both Workers in workerd (local R2), driven by the CLI, with a stand-in for Access
```

Node 24.21+ or 26.10+ (never 25), pnpm 12. Tests run with `node --test` on the TypeScript
sources directly.

## License

Apache License 2.0, see [LICENSE](LICENSE).
