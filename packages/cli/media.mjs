// A media library from the command line, for people and their agents; run through
// bin/media-library, which provides cloudflared. Every call is made as the person signed in
// to Cloudflare Access through cloudflared, never with a shared key.
//
// Configured by the project's wrapper script (README.md, "Using it in a project"):
//   MEDIA_ADMIN_URL      the admin Worker, e.g. https://media-admin.yolean.workers.dev (required)
//   MEDIA_REFERENCED_BY  files that use media URLs, comma-separated; rm refuses a file they mention
//   MEDIA_COMMAND        how the person invokes it, for the usage text
//   MEDIA_CWD            where the person ran it, so file arguments resolve as typed
//
// Plain JavaScript, typechecked through JSDoc: Node does not strip TypeScript types in
// node_modules, which is where projects install this.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ADMIN_URL = (process.env.MEDIA_ADMIN_URL ?? '').replace(/\/$/, '');
const CLOUDFLARED = process.env.CLOUDFLARED ?? 'cloudflared';
/** Where the person ran the command, so file arguments resolve as they typed them */
const CWD = process.env.MEDIA_CWD ?? process.cwd();
const REFERENCED_BY = (process.env.MEDIA_REFERENCED_BY ?? '').split(',').map((f) => f.trim()).filter(Boolean)
  .map((f) => path.resolve(CWD, f));
const COMMAND = process.env.MEDIA_COMMAND ?? 'media-library';

/** @type {Record<string, string>} */
const TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif', gif: 'image/gif',
  mp4: 'video/mp4', webm: 'video/webm', pdf: 'application/pdf',
};

/**
 * @typedef {{ name: string, url: string, contentType: string, size: number, sha256: string,
 *   filename: string, alt: string, category: string, asset: string, supersedes: string, note: string,
 *   uploadedBy: string, uploadedAt: string, updatedBy: string, updatedAt: string }} Item
 */

/** The labels: optional, for people browsing and for traceability; the name stays the content hash */
const LABELS = ['alt', 'category', 'asset', 'note'];

const USAGE = `Usage: ${COMMAND} <command>

  ls [--category <c>] [--asset <id>] [--json]
                                    files, newest first; a category includes those below it
  upload <file> [labels] [--no-filename] [--json]
                                    add a file; prints its public URL. --no-filename when the
                                    local name means nothing (generated files)
  label <name> [labels]             change a file's labels; "" removes one
  info <name> [--json]              one file's details
  ui                                the address of the read-only view in the browser
  rm <name> [--force]               remove a file (refused while ${REFERENCED_BY.map((f) => path.basename(f)).join(', ') || 'the project'} uses it, unless --force)
  whoami                            who you are signed in as
  login                             sign in again (opens the browser)

Labels, all optional:
  --alt <text>        suggested alt text
  --category <c>      what it is, instead of a folder: lowercase words, / between levels (kundlogotyper)
  --asset <id>        a stable id across versions (ncc-logo); uploading with it makes the newest version
  --note <text>       source, photographer, rights

Allowed: ${Object.keys(TYPES).join(', ')}. Files are named by their content, so uploading the
same file twice gives the same URL, and a new version of something gets a new URL.`;

/** @param {string} message @returns {never} */
function fail(message) {
  console.error(message);
  process.exit(1);
}

function login() {
  console.error(`Signing in to ${ADMIN_URL}; a browser window opens.`);
  const r = spawnSync(CLOUDFLARED, ['access', 'login', ADMIN_URL], { stdio: ['inherit', 'ignore', 'inherit'] });
  if (r.status !== 0) fail(`Sign-in did not complete. Run \`${COMMAND} login\` and finish it in the browser.`);
}

/** The person's Access token: from cloudflared, signing in first if there is none or it expired */
/** @returns {{ header: string, value: string }} */
function token() {
  // Tests and local runs against wrangler dev, where no Access edge turns cf-access-token into the assertion
  if (process.env.MEDIA_ACCESS_TOKEN) return { header: 'cf-access-jwt-assertion', value: process.env.MEDIA_ACCESS_TOKEN };
  const read = () => {
    try {
      return execFileSync(CLOUDFLARED, ['access', 'token', `-app=${ADMIN_URL}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return '';
    }
  };
  let value = read();
  if (!value) {
    login();
    value = read();
  }
  if (!value) fail('No Access token after signing in.');
  return { header: 'cf-access-token', value };
}

/**
 * @param {string} method @param {string} apiPath
 * @param {{ body?: BodyInit, headers?: Record<string, string> }} [init] @param {boolean} [retried]
 * @returns {Promise<Response>}
 */
async function api(method, apiPath, init = {}, retried = false) {
  const t = token();
  const res = await fetch(`${ADMIN_URL}${apiPath}`, /** @type {RequestInit} */ ({ method, body: init.body, headers: { ...init.headers, [t.header]: t.value }, redirect: 'manual', duplex: 'half' }));
  // Access answers an expired login with a redirect to its login page
  if (!retried && !process.env.MEDIA_ACCESS_TOKEN && (res.status === 401 || res.status === 302 || res.status === 403)) {
    login();
    return api(method, apiPath, init, true);
  }
  return res;
}

/** @param {Response} res @returns {Promise<unknown>} */
async function expectOk(res) {
  if (res.ok) return res.status === 204 ? null : res.json();
  const text = await res.text();
  let message = text;
  try {
    const body = /** @type {{ error?: string, message?: string }} */ (JSON.parse(text));
    message = [body.error, body.message].filter(Boolean).join(': ');
  } catch { /* not JSON */ }
  fail(`${res.status} ${message}`.trim());
}

const size = (/** @type {number} */ n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MiB` : `${Math.ceil(n / 1024)} KiB`);
const show = (/** @type {Item} */ i) => [
  i.url,
  `  ${i.filename || '-'}, ${size(i.size)}, ${i.contentType}, by ${i.uploadedBy || '?'} at ${i.uploadedAt}`,
  ...[['category', i.category], ['asset', i.asset], ['supersedes', i.supersedes], ['alt', i.alt], ['note', i.note]]
    .filter(([, v]) => v).map(([k, v]) => `  ${k}: ${v}`),
  ...(i.updatedAt ? [`  labels changed ${i.updatedAt} by ${i.updatedBy}`] : []),
].join('\n');

/** The label options given, removed from args; "" kept, since it removes a label */
function labels(/** @type {string[]} */ args) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const key of LABELS) {
    const value = option(args, `--${key}`);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** @param {string[]} args @param {string} flag @returns {string | undefined} */
function option(args, flag) {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (value === undefined) fail(`${flag} needs a value`);
  args.splice(i, 2);
  return value;
}

/** @param {string[]} args @param {string} name */
function flag(args, name) {
  const i = args.indexOf(name);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
}

/** @param {string[]} argv */
async function main(argv) {
  const [command, ...args] = argv;
  const json = flag(args, '--json');
  switch (command) {
    case 'ls': {
      const filter = new URLSearchParams();
      for (const key of ['category', 'asset']) {
        const value = option(args, `--${key}`);
        if (value) filter.set(key, value);
      }
      const { items, truncated } = /** @type {{ items: Item[], truncated: boolean }} */ (await expectOk(await api('GET', `/api/v1/media?${filter}`)));
      if (json) return console.log(JSON.stringify({ items, truncated }, null, 2));
      for (const i of items) console.log(show(i));
      console.log(`${items.length} file(s)${truncated ? ', more not listed' : ''}`);
      return;
    }
    case 'upload': {
      const given = Object.fromEntries(Object.entries(labels(args)).filter(([, v]) => v !== ''));
      const noFilename = flag(args, '--no-filename');
      const [file] = args;
      if (!file) fail(USAGE);
      const full = path.resolve(CWD, file);
      if (!existsSync(full) || !statSync(full).isFile()) fail(`No such file: ${full}`);
      const ext = path.extname(full).slice(1).toLowerCase();
      const type = TYPES[ext] ?? fail(`${ext || 'no extension'}: allowed are ${Object.keys(TYPES).join(', ')}`);
      const body = readFileSync(full);
      const sha256 = createHash('sha256').update(body).digest('hex');
      const q = new URLSearchParams({ sha256, ...(noFilename ? {} : { filename: path.basename(full) }), ...given });
      const res = await api('PUT', `/api/v1/media?${q}`, { body, headers: { 'content-type': type, 'content-length': String(body.length) } });
      const item = /** @type {Item} */ (await expectOk(res));
      if (json) return console.log(JSON.stringify({ ...item, alreadyInLibrary: res.status === 200 }, null, 2));
      console.log(item.url);
      if (res.status === 200) console.error(`Already in the library${Object.keys(given).length ? `; labels unchanged, use: ${COMMAND} label ${item.name} …` : '.'}`);
      else console.error(`Uploaded ${size(item.size)} as ${item.uploadedBy}${item.supersedes ? `, the newest version of ${item.asset} (was ${item.supersedes})` : ''}.`);
      return;
    }
    case 'label': {
      const changes = labels(args);
      const [name] = args;
      if (!name || !Object.keys(changes).length) fail(USAGE);
      const item = /** @type {Item} */ (await expectOk(await api('PATCH', `/api/v1/media/${encodeURIComponent(name)}`, {
        body: JSON.stringify(changes), headers: { 'content-type': 'application/json' },
      })));
      return console.log(json ? JSON.stringify(item, null, 2) : show(item));
    }
    case 'ui':
      return console.log(`${ADMIN_URL}/`);
    case 'info': {
      const [name] = args;
      if (!name) fail(USAGE);
      const item = /** @type {Item} */ (await expectOk(await api('GET', `/api/v1/media/${encodeURIComponent(name)}`)));
      return console.log(json ? JSON.stringify(item, null, 2) : show(item));
    }
    case 'rm': {
      const force = flag(args, '--force');
      const [name] = args;
      if (!name) fail(USAGE);
      const user = REFERENCED_BY.find((f) => existsSync(f) && readFileSync(f, 'utf8').includes(name));
      if (!force && user) fail(`${path.relative(CWD, user)} still uses ${name}; remove it there first, or pass --force.`);
      await expectOk(await api('DELETE', `/api/v1/media/${encodeURIComponent(name)}`));
      return console.error(`Removed ${name}.`);
    }
    case 'whoami':
      return console.log(/** @type {{ email: string }} */ (await expectOk(await api('GET', '/api/v1/me'))).email);
    case 'login':
      return login();
    default:
      console.error(USAGE);
      process.exit(command ? 2 : 0);
  }
}

if (!ADMIN_URL) fail('MEDIA_ADMIN_URL is not set: run this through the project\'s wrapper script.');
try {
  await main(process.argv.slice(2));
} catch (err) {
  // fetch failing outright: DNS, connection refused, offline
  const e = /** @type {Error} */ (err);
  fail(`Could not reach ${ADMIN_URL}: ${/** @type {Error | undefined} */ (e.cause)?.message ?? e.message}`);
}
