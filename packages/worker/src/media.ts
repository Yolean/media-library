// A media library: one EU R2 bucket of files named by their content. What both Workers
// share - the public one serving files, the admin one behind Cloudflare Access managing them.
// Each project deploys its own pair, on its own account (README.md).
import { z } from '@hono/zod-openapi';
import { Use, type UsageBindings } from './usage.ts';

export interface Bindings extends UsageBindings {
  /** The media bucket, jurisdiction "eu" (wrangler.jsonc) */
  MEDIA: R2Bucket;
  /** Where the public Worker serves files, e.g. https://media.yolean.workers.dev */
  PUBLIC_BASE_URL: string;
  /** The Access team's issuer, https://<team>.cloudflareaccess.com; unset admits nobody */
  ACCESS_ISSUER?: string;
  /** The Access application's AUD tag; unset admits nobody */
  ACCESS_AUD?: string;
  /**
   * Who may manage media, on top of the Access policy: comma-separated domains (@yolean.com)
   * and exact addresses (name@partner.example). Unset or empty admits nobody.
   */
  ACCESS_ALLOW?: string;
}

/**
 * The types a page may show. No SVG or HTML: anything a browser could run as a document on
 * the media origin is refused, and the public Worker sends the type for the extension, never
 * a stored one.
 */
export const TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'application/pdf': 'pdf',
} as const;
export type ContentType = keyof typeof TYPES;
export const TYPE_BY_EXT: Record<string, ContentType> = Object.fromEntries(
  Object.entries(TYPES).map(([type, ext]) => [ext, type as ContentType]),
);

/** Under the Free plan's 100 MB request body limit */
export const MAX_UPLOAD_BYTES = 95 * 1024 * 1024;

/** Same scheme as the build's assets (build/split.mjs): first 20 hex of sha256, then the type's extension */
export const NAME = /^([0-9a-f]{20})\.([a-z0-9]{2,5})$/;
export const nameFor = (sha256: string, type: ContentType) => `${sha256.slice(0, 20)}.${TYPES[type]}`;

/** A file is never replaced, so it may be cached for good */
export const IMMUTABLE = 'public, max-age=31536000, immutable';

export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/).describe('Hex sha256 of the file');
export const MediaName = z.string().regex(NAME).openapi({ example: '3fab80933e4cbe1806e0.mp4' });

/**
 * The labels: a non-binding convention for people browsing the library and for traceability.
 * Every one is optional; the file's name stays its content hash whatever they say.
 */
export const Category = z.string().max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/, 'lowercase words, dashes, and / between levels')
  .describe('What the file is, instead of a folder: lowercase words, / between levels (kundlogotyper, guider/pdf)')
  .openapi({ example: 'kundlogotyper' });
export const AssetId = z.string().max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lowercase words and dashes')
  .describe('A stable id across versions: uploading with an asset id makes the file that asset\'s newest version')
  .openapi({ example: 'ncc-logo' });
export const Alt = z.string().max(300).describe('Suggested alt text');
export const Note = z.string().max(300).describe('Where the file came from: source, photographer, rights');

export const MediaItem = z.object({
  name: MediaName,
  url: z.string().url().describe('The public address to use in the site\'s src attributes'),
  contentType: z.enum(Object.keys(TYPES) as [ContentType, ...ContentType[]]),
  size: z.number().int(),
  sha256: Sha256,
  filename: z.string().describe('The file\'s name on the uploader\'s machine, recorded at upload; empty if unknown'),
  alt: z.string().describe('Suggested alt text; empty if none'),
  category: z.string().describe('Empty if none'),
  asset: z.string().describe('The asset this file is a version of; empty if none'),
  supersedes: z.string().describe('The asset\'s newest file when this one was uploaded; empty if none'),
  note: z.string().describe('Source, photographer, rights; empty if none'),
  uploadedBy: z.string().describe('Email of the person who uploaded it, from their Access login'),
  uploadedAt: z.string().datetime(),
  updatedBy: z.string().describe('Who last changed the labels; empty if never'),
  updatedAt: z.string().describe('When the labels last changed; empty if never'),
  uses: z.array(Use).optional().describe('Where the deployed site\'s build uses the file; absent when the site provides no index'),
}).openapi('MediaItem');
export type MediaItem = z.infer<typeof MediaItem>;

/** The labels a person sets; empty means none */
export interface Labels { alt?: string; category?: string; asset?: string; note?: string }
export const LABELS = ['alt', 'category', 'asset', 'note'] as const;

/** What the Worker records itself */
interface Recorded {
  sha256: string;
  uploadedBy: string;
  uploadedAt: string;
  filename?: string;
  supersedes?: string;
  updatedBy?: string;
  updatedAt?: string;
}

/** R2 allows 2,048 bytes of custom metadata per object, keys and values together */
export const MAX_METADATA_BYTES = 2048;

/** The object's customMetadata: only the fields that have a value */
export function storedMetadata(m: (Recorded & Labels) | Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(m).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== ''));
}

export const metadataBytes = (m: Record<string, string>) =>
  Object.entries(m).reduce((n, [k, v]) => n + new TextEncoder().encode(k + v).length, 0);

export function itemOf(object: R2Object, publicBaseUrl: string): MediaItem {
  const meta = object.customMetadata ?? {};
  const ext = NAME.exec(object.key)?.[2] ?? '';
  return {
    name: object.key,
    url: `${publicBaseUrl.replace(/\/$/, '')}/${object.key}`,
    contentType: TYPE_BY_EXT[ext],
    size: object.size,
    sha256: meta.sha256 ?? '',
    filename: meta.filename ?? '',
    alt: meta.alt ?? '',
    category: meta.category ?? '',
    asset: meta.asset ?? '',
    supersedes: meta.supersedes ?? '',
    note: meta.note ?? '',
    uploadedBy: meta.uploadedBy ?? '',
    uploadedAt: meta.uploadedAt ?? object.uploaded.toISOString(),
    updatedBy: meta.updatedBy ?? '',
    updatedAt: meta.updatedAt ?? '',
  };
}
