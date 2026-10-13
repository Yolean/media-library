// Both Workers of the example deployment in workerd (wrangler dev) on one local R2, a
// stand-in for the Access team's signing keys, and the CLI driving the admin API as a
// signed-in person.
// What the unit tests' fake bucket can't show: R2's own sha256 check on put, its Range and
// conditional reads, and list with customMetadata.
//
//   pnpm run e2e   (from the repository root)
//
// The two Workers take turns: workerd locks its local storage, so two wrangler dev processes
// can't share it at once.
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import url from 'node:url';
import assert from 'node:assert/strict';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

const ROOT = path.dirname(url.fileURLToPath(import.meta.url));
const WRANGLER = path.join(ROOT, 'node_modules', '.bin', 'wrangler');
const AUD = 'e2e-media-admin';
const ADMIN_PORT = 8791;
const PUBLIC_PORT = 8792;
const persist = mkdtempSync(path.join(tmpdir(), 'media-e2e-'));
// The CLI as a project gets it: a copy under node_modules, where Node strips no TypeScript
// types, rather than the workspace link, which points outside node_modules
const installed = path.join(persist, 'node_modules', '@yolean', 'media-library-cli');
cpSync(path.join(ROOT, '..', 'cli'), installed, { recursive: true, filter: (f) => !f.includes('node_modules') });
const CLI = path.join(installed, 'bin', 'media-library');
const children: ChildProcess[] = [];

function wrangler(args: string[]): ChildProcess {
  const child = spawn(WRANGLER, ['dev', '-c', 'wrangler.jsonc', '--persist-to', persist, '--ip', '127.0.0.1', ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout!.on('data', (d) => { log += d; });
  child.stderr!.on('data', (d) => { log += d; });
  if (process.env.E2E_VERBOSE) { child.stdout!.pipe(process.stderr); child.stderr!.pipe(process.stderr); }
  child.on('exit', (code) => { if (code && code !== 143 && !stopping) console.error(`wrangler ${args.join(' ')} exited ${code}\n${log}`); });
  children.push(child);
  return child;
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  const exited = new Promise((r) => child.once('exit', r));
  child.kill();
  await exited;
}

async function ready(base: string) {
  for (let i = 0; i < 120; i++) {
    try {
      await fetch(base);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`${base} did not start`);
}

let stopping = false;
async function main() {
  // The Access team's certs endpoint, as https://<team>.cloudflareaccess.com/cdn-cgi/access/certs
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'e2e', alg: 'RS256', use: 'sig' };
  const issuerServer = createServer((req, res) => {
    res.writeHead(req.url === '/cdn-cgi/access/certs' ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [jwk] }));
  }).listen(0, '127.0.0.1');
  await new Promise((r) => issuerServer.once('listening', r));
  const issuer = `http://127.0.0.1:${(issuerServer.address() as AddressInfo).port}`;
  const admin = `http://127.0.0.1:${ADMIN_PORT}`;
  const pub = `http://127.0.0.1:${PUBLIC_PORT}`;

  const startAdmin = async () => {
    const child = wrangler(['--env', 'admin', '--port', String(ADMIN_PORT), '--inspector-port', '9291',
      '--var', `ACCESS_ISSUER:${issuer}`, '--var', `ACCESS_AUD:${AUD}`, '--var', `PUBLIC_BASE_URL:${pub}`,
      '--var', 'ACCESS_ALLOW:@yolean.com']);
    await ready(admin);
    return child;
  };
  const startPublic = async () => {
    const child = wrangler(['--port', String(PUBLIC_PORT), '--inspector-port', '9292', '--var', `PUBLIC_BASE_URL:${pub}`]);
    await ready(pub);
    return child;
  };
  let running = await startAdmin();

  const token = await new SignJWT({ email: 'e2e@yolean.com' }).setProtectedHeader({ alg: 'RS256', kid: 'e2e' })
    .setIssuer(issuer).setAudience(AUD).setIssuedAt().setExpirationTime('10m').sign(privateKey);
  // Async: the stand-in certs endpoint above runs in this process and must keep answering
  const media = async (...args: string[]) => (await promisify(execFile)(CLI, args, {
    cwd: persist, encoding: 'utf8', env: { ...process.env, MEDIA_ACCESS_TOKEN: token, MEDIA_ADMIN_URL: admin, CLOUDFLARED: 'unused', MEDIA_REFERENCED_BY: 'page.html' },
  })).stdout;

  // Any bytes will do: the type comes from the extension, and the public Worker serves it inert
  const bytes = randomBytes(40_000);
  const file = path.join(persist, 'clip.mp4');
  writeFileSync(file, bytes);
  const sha = createHash('sha256').update(bytes).digest('hex');

  assert.equal((await media('whoami')).trim(), 'e2e@yolean.com');
  const uploaded = JSON.parse(await media('upload', file, '--alt', 'e2e clip', '--json'));
  assert.equal(uploaded.name, `${sha.slice(0, 20)}.mp4`);
  assert.equal(uploaded.uploadedBy, 'e2e@yolean.com');
  assert.equal(uploaded.alreadyInLibrary, false);
  assert.equal(JSON.parse(await media('upload', file, '--json')).alreadyInLibrary, true);
  console.log(`uploaded ${uploaded.name}, ${bytes.length} bytes`);

  const listed = JSON.parse(await media('ls', '--json'));
  assert.deepEqual(listed.items.map((i: { name: string; alt: string }) => [i.name, i.alt]), [[uploaded.name, 'e2e clip']]);

  // R2 itself refuses a body that does not match the sha256 given
  const wrong = await fetch(`${admin}/api/v1/media?sha256=${'0'.repeat(64)}&filename=x.png`, {
    method: 'PUT', body: new Uint8Array([1, 2, 3]), headers: { 'content-type': 'image/png', 'cf-access-jwt-assertion': token },
  });
  assert.equal(wrong.status, 400, await wrong.clone().text());
  assert.equal(((await wrong.json()) as { error: string }).error, 'checksum-mismatch');

  let v2: { name: string; supersedes: string };
  // Labels, with real R2: a label change writes the same bytes back under an etag condition
  const labelled = JSON.parse(await media('label', uploaded.name, '--asset', 'e2e-clip', '--category', 'film/demo', '--json'));
  assert.deepEqual([labelled.asset, labelled.category, labelled.alt, labelled.updatedBy], ['e2e-clip', 'film/demo', 'e2e clip', 'e2e@yolean.com']);
  assert.equal(labelled.sha256, sha, 'same file');
  const v2bytes = randomBytes(30_000);
  const v2file = path.join(persist, 'clip-v2.mp4');
  writeFileSync(v2file, v2bytes);
  v2 = JSON.parse(await media('upload', v2file, '--asset', 'e2e-clip', '--json'));
  assert.equal(v2.supersedes, uploaded.name);
  const versions = JSON.parse(await media('ls', '--asset', 'e2e-clip', '--json'));
  assert.deepEqual(versions.items.map((i: { name: string }) => i.name), [v2.name, uploaded.name]);
  assert.equal(JSON.parse(await media('ls', '--category', 'film', '--json')).items.length, 1, 'a category includes those below it');
  // The read-only UI, with the same login
  const ui = await fetch(`${admin}/files/${uploaded.name}`, { headers: { 'cf-access-jwt-assertion': token } });
  assert.equal(ui.status, 200);
  const page = await ui.text();
  assert.ok(page.includes('Versions of e2e-clip') && page.includes(`/files/${v2.name}`));
  assert.equal((await fetch(`${admin}/`)).status, 401);
  console.log('labels: label, versions, filters and UI as expected');
  await stop(running);
  running = await startPublic();
  // The label change kept the bytes the public Worker serves
  assert.deepEqual(Buffer.from(await (await fetch(uploaded.url)).arrayBuffer()), bytes);

  const whole = await fetch(uploaded.url);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('content-type'), 'video/mp4');
  assert.deepEqual(Buffer.from(await whole.arrayBuffer()), bytes);
  const part = await fetch(uploaded.url, { headers: { range: 'bytes=100-199' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 100-199/${bytes.length}`);
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), bytes.subarray(100, 200));
  assert.equal((await fetch(uploaded.url, { headers: { 'if-none-match': whole.headers.get('etag')! } })).status, 304);
  assert.equal((await fetch(uploaded.url, { headers: { range: `bytes=${bytes.length + 10}-` } })).status, 416);
  console.log('public: whole, range, 304, 416 as expected');
  await stop(running);

  running = await startAdmin();
  // rm refuses a file the project still uses
  writeFileSync(path.join(persist, 'page.html'), `<video src="${uploaded.url}">`);
  await assert.rejects(media('rm', uploaded.name), /page.html still uses/);
  await media('rm', uploaded.name, '--force');
  await media('rm', v2.name);
  assert.equal((await fetch(`${admin}/api/v1/me`)).status, 401);
  assert.equal((await fetch(`${admin}/api/v1/media/${uploaded.name}`, { headers: { 'cf-access-jwt-assertion': token } })).status, 404);
  await stop(running);

  running = await startPublic();
  assert.equal((await fetch(uploaded.url)).status, 404);
  console.log('e2e: OK');
  issuerServer.close();
}

try {
  await main();
} finally {
  stopping = true;
  await Promise.all(children.map(stop));
  rmSync(persist, { recursive: true, force: true });
}
