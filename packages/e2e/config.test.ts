// The example deployment keeps everything in Cloudflare's EU jurisdiction: R2 buckets bound
// with jurisdiction "eu", and no other storage (KV may cache outside its jurisdiction). A
// project copies this test next to its own wrangler.jsonc. Same rule as my-v1's.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.dirname(url.fileURLToPath(import.meta.url));
const CONFIGS = ['wrangler.jsonc'];
const STORAGE = ['kv_namespaces', 'd1_databases', 'durable_objects', 'queues', 'vectorize', 'hyperdrive', 'analytics_engine_datasets', 'secrets_store_secrets'];

/** JSONC without comments; strings in these files contain no comment markers */
const jsonc = (file: string) => JSON.parse(readFileSync(path.join(ROOT, file), 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'));

describe('storage stays in the EU jurisdiction', () => {
  for (const file of CONFIGS) {
    it(`${file}: R2 only, every bucket with jurisdiction "eu", in every environment`, () => {
      const config = jsonc(file);
      for (const [where, scope] of [['top level', config], ...Object.entries(config.env ?? {})] as Array<[string, Record<string, unknown>]>) {
        for (const key of STORAGE) assert.equal(scope[key], undefined, `${file} ${where}: ${key} is not allowed`);
        for (const b of (scope.r2_buckets ?? []) as Array<{ binding: string; jurisdiction?: string }>) {
          assert.equal(b.jurisdiction, 'eu', `${file} ${where}: bucket ${b.binding} without jurisdiction "eu"`);
        }
      }
    });
  }

  it('the admin Worker is never reachable on a preview URL, which Access may not cover', () => {
    const config = jsonc('wrangler.jsonc');
    assert.equal(config.env.admin.preview_urls, false);
    assert.equal(config.env.admin.name, 'media-admin');
  });
});
