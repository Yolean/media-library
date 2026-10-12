// A media library: one EU R2 bucket of files named by their content. What both Workers
// share - the public one serving files, the admin one behind Cloudflare Access managing them.
// Each project deploys its own pair, on its own account (README.md).
import { z } from '@hono/zod-openapi';

export interface Bindings {
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

export const MediaItem = z.object({
  name: MediaName,
  url: z.string().url().describe('The public address to use in the site\'s src attributes'),
  contentType: z.enum(Object.keys(TYPES) as [ContentType, ...ContentType[]]),
  size: z.number().int(),
  sha256: Sha256,
  uploadedBy: z.string().describe('Email of the person who uploaded it, from their Access login'),
  uploadedAt: z.string().datetime(),
  filename: z.string().describe('The file\'s name on the uploader\'s machine'),
  alt: z.string().describe('Suggested alt text, empty if none was given'),
}).openapi('MediaItem');
export type MediaItem = z.infer<typeof MediaItem>;

/** What is kept as the object's customMetadata */
interface Stored {
  sha256: string;
  uploadedBy: string;
  uploadedAt: string;
  filename: string;
  alt: string;
}
export const storedMetadata = (m: Stored): Record<string, string> => ({ ...m });

export function itemOf(object: R2Object, publicBaseUrl: string): MediaItem {
  const meta = object.customMetadata ?? {};
  const ext = NAME.exec(object.key)?.[2] ?? '';
  return {
    name: object.key,
    url: `${publicBaseUrl.replace(/\/$/, '')}/${object.key}`,
    contentType: TYPE_BY_EXT[ext],
    size: object.size,
    sha256: meta.sha256 ?? '',
    uploadedBy: meta.uploadedBy ?? '',
    uploadedAt: meta.uploadedAt ?? object.uploaded.toISOString(),
    filename: meta.filename ?? '',
    alt: meta.alt ?? '',
  };
}
