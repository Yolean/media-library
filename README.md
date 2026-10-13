# media-library

A media library for a website on Cloudflare: images, videos and PDFs in one R2 bucket in
Cloudflare's EU jurisdiction, served publicly by one Worker and managed through another,
behind Cloudflare Access. People and their agents use the same command line tool, signed in
as themselves; people also get a plain, read-only view in the browser.

Built for Yolean's homepage (`Yolean/homepage`, `cloudflare/`) and the pull planning workshop
(`Yolean/pull-planning-workshop`). Each project deploys its own pair of Workers, on its own
Cloudflare account, from the packages here.

| Package | What |
|---|---|
| [`packages/worker`](packages/worker) `@yolean/media-library-worker` | `./public` and `./admin`: the two Workers, Hono with `@hono/zod-openapi` |
| [`packages/cli`](packages/cli) `@yolean/media-library-cli` | `media-library`: ls, upload, label, info, rm, ui, whoami, through `cloudflared` |
| [`packages/e2e`](packages/e2e) (private) | the example deployment, its EU storage test, and the end-to-end test |

## How it works

| Worker | Serves | Login |
|---|---|---|
| public (e.g. `media`) | `GET`/`HEAD /<name>`, with Range and If-None-Match; `/openapi.json` | none |
| admin (e.g. `media-admin`) | the API: `/api/v1/me`, `/api/v1/media` (list with filters, upload), `/api/v1/media/{name}` (get, label, delete), `/api/v1/openapi.json`; the read-only view: `/` and `/files/{name}` | Cloudflare Access |

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

## Labels

A non-binding convention, for people browsing the library and for traceability. Every label
is optional, and none of them is ever part of a file's name or URL, which stay its content
hash. They are the object's R2 `customMetadata`, so a listing returns them with no extra reads.

| Label | Set by | Meaning |
|---|---|---|
| `filename` | upload | the file's name on the uploader's machine, when known; recorded once, never changed (`--no-filename` for generated files) |
| `alt` | people | suggested alt text |
| `category` | people | what the file is, instead of a folder: lowercase words and dashes, `/` between levels (`kundlogotyper`, `guider/pdf`); filtering by `guider` includes `guider/pdf` |
| `asset` | people | a stable id across versions (`ncc-logo`): uploading with it makes the file that asset's newest version |
| `supersedes` | upload | the asset's newest file when this one was uploaded, so each version links to the one it replaced |
| `note` | people | where the file came from: source, photographer, rights |
| `uploadedBy`, `uploadedAt` | upload | who added it, from their Access login |
| `updatedBy`, `updatedAt` | label changes | who last changed its labels |

Tracking a file's evolution, even one uploaded without a filename:

```
media-library label 3fab80933e4cbe1806e0.png --asset ncc-logo     # the file you are about to replace
media-library upload ncc-2026.png --asset ncc-logo                 # its next version, with its own URL
media-library ls --asset ncc-logo                                  # newest first
```

The newest version is the one pages should use; older versions stay until someone removes
them, so pages that still use them keep working. R2 has no metadata-only update, so a label
change writes the same bytes back, checked against their sha256 and only if the object is
unchanged since it was read (otherwise 409). Labels are limited by R2's 2,048 bytes of custom
metadata per object; the API refuses more.

## The read-only view

The admin Worker's `/` lists the library, filterable by category and asset, with thumbnails;
`/files/{name}` shows one file: a preview, its public URL and an HTML snippet to copy, every
label, and its asset's versions. Plain HTML, deliberately: no styles, no scripts, nothing that
changes anything (changes go through the CLI). Every value is escaped - file names and notes
are user input - and the pages' CSP allows nothing but images and video from the public
media origin. Same Access login as the API.

## The command line

`media-library` runs `cloudflared` (Cloudflare's CLI) to sign the person in through Access -
a browser window, once per session lifetime - and sends their token with every call. On macOS
it downloads a pinned `cloudflared` into `~/.cache/yolean-media-library/` and checks both
sha256s Cloudflare publishes: the archive's (GitHub's asset digest) and the binary's (the
release notes hash the binary inside the `.tgz`, not the `.tgz`). Elsewhere it uses
`cloudflared` from `PATH`.

```
media-library ls [--category <c>] [--asset <id>] [--json]    newest first, with labels and who uploaded
media-library upload <file> [labels] [--no-filename] [--json]   prints the public URL
media-library label <name> [labels]                           "" removes a label
media-library info <name> [--json]
media-library rm <name> [--force]                 refused while a project file still uses it
media-library ui                                  the read-only view's address
media-library whoami
media-library login

labels: --alt <text> --category <c> --asset <id> --note <text>
```

## Using it in a project

1. Dependencies, pinned to a tag (no npm registry involved; the repository is public):
   ```bash
   pnpm add 'github:Yolean/media-library#v0.2.0&path:/packages/worker'
   pnpm add -D 'github:Yolean/media-library#v0.2.0&path:/packages/cli'
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
| UI | its own dashboard (Vue): browse, upload, edit, share | a read-only list and file page, plain HTML without scripts; changes only through the CLI |
| Organising files | folders (key prefixes), move, copy, rename | names are content hashes and never change; `category` labels instead of folders, `asset` ids for versions with `supersedes` links |
| Access token check | `@hono/cloudflare-access` without an audience: **any** application's token from the team is accepted (the middleware logs a warning) | issuer, audience, signature, expiry; plus `ACCESS_ALLOW` |
| No login configured | API open (read-only by default) | admits nobody |
| Public access | `/share/:id` links, created by any signed-in user, optionally never expiring; share records are ordinary objects in the same bucket, so an uploader can write one | a separate Worker serving only content-addressed names, read-only |
| Which bucket | from the URL, `c.env[bucketName]`: any binding of the Worker can be addressed | one binding, `MEDIA` |
| Upload rules | any key, any content type | allowlisted types, size cap, name from content, R2 verifies sha256 |
| Serving | stored content type, `Content-Disposition: attachment` | type from extension, `nosniff`, sandboxing CSP, Range for video, immutable caching |
| Metadata | free-form custom and HTTP metadata, editable | a fixed set of labels, validated, size-checked against R2's limit |
| Who did what | the signed-in user is known but not stored on uploads | `uploadedBy` on every object, `updatedBy` for label changes, deletions logged |
| Other features | email receive and send, multipart uploads | none |
| Code | Hono, chanfana 2, zod 3; keys as base64 decoded with `escape()` | Hono, `@hono/zod-openapi`, zod 4, jose; about 1,000 lines with the CLI and the view |

R2-Explorer is the better choice for browsing, editing and sharing arbitrary files. For a
website's media, most of its surface is something we would have to switch off or wrap, and its
Access integration would need patching. What we need from a UI is to find a file, see what it
is and copy its URL, which a read-only page does without any of that surface.

## Limits

- No undo: `rm` deletes the object (R2 has no versioning). The CLI refuses while a file
  listed in `MEDIA_REFERENCED_BY` mentions it.
- Listing reads at most 5,000 objects (it says when it stopped); the view and asset uploads
  list the whole library each time, which is fine at a website's scale.
- Two uploads to the same asset at the same moment can both name the same previous version
  as `supersedes`; nothing is lost, the chain just forks.
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
