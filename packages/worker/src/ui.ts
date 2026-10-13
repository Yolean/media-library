// A read-only view of the library for people: the list, and one file's details with its
// asset's versions. Deliberately plain: no styles, no scripts, server-rendered. Every value
// goes through hono/html's escaping template - file names, alt texts and notes are user input.
import { html } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import type { MediaItem } from './media.ts';
import type { Filter } from './library.ts';

type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

/** Only the media origin may supply anything to these pages, and only images and video */
export const uiCsp = (publicBaseUrl: string) => {
  const media = new URL(publicBaseUrl).origin;
  return `default-src 'none'; img-src ${media}; media-src ${media}; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;
};

const size = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MiB` : `${Math.ceil(n / 1024)} KiB`);
const day = (iso: string) => iso.slice(0, 16).replace('T', ' ');
const isImage = (i: MediaItem) => i.contentType.startsWith('image/');
const isVideo = (i: MediaItem) => i.contentType.startsWith('video/');

function page(title: string, email: string, body: Html): Html {
  return html`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head>
<body>
<p><a href="/">Media library</a> · signed in as ${email} · read-only; change files with the CLI (<code>media-library</code>) · <a href="/api/v1/openapi.json">API</a></p>
<hr>
${body}
</body>
</html>`;
}

function preview(i: MediaItem, width: number): Html {
  if (isImage(i)) return html`<img src="${i.url}" alt="${i.alt}" width="${width}" loading="lazy">`;
  if (isVideo(i)) return width > 200 ? html`<video src="${i.url}" controls preload="metadata" width="${width}"></video>` : html`video`;
  return html`<a href="${i.url}">pdf</a>`;
}

export function listPage(items: MediaItem[], all: MediaItem[], filter: Filter, truncated: boolean, email: string): Html {
  const categories = [...new Set(all.map((i) => i.category).filter(Boolean))].sort();
  const assets = [...new Set(all.map((i) => i.asset).filter(Boolean))].sort();
  const newest = new Set(assets.map((a) => all.find((i) => i.asset === a)?.name));
  return page('Media library', email, html`
<h1>Media library</h1>
<form method="get" action="/">
<label>Category <select name="category"><option value="">all</option>${categories.map((c) => html`<option${c === filter.category ? html` selected` : ''}>${c}</option>`)}</select></label>
<label>Asset <select name="asset"><option value="">all</option>${assets.map((a) => html`<option${a === filter.asset ? html` selected` : ''}>${a}</option>`)}</select></label>
<button>Show</button>
</form>
<p>${items.length} of ${all.length} file(s)${truncated ? ', more not listed' : ''}.</p>
<table border="1" cellpadding="4">
<thead><tr><th>Preview</th><th>Name</th><th>Filename</th><th>Category</th><th>Asset</th><th>Size</th><th>Uploaded</th><th>By</th></tr></thead>
<tbody>
${items.map((i) => html`<tr>
<td>${preview(i, 80)}</td>
<td><a href="/files/${i.name}">${i.name}</a></td>
<td>${i.filename}</td>
<td>${i.category ? html`<a href="/?category=${encodeURIComponent(i.category)}">${i.category}</a>` : ''}</td>
<td>${i.asset ? html`<a href="/?asset=${encodeURIComponent(i.asset)}">${i.asset}</a>${newest.has(i.name) ? '' : ' (older version)'}` : ''}</td>
<td>${size(i.size)}</td>
<td>${day(i.uploadedAt)}</td>
<td>${i.uploadedBy}</td>
</tr>`)}
</tbody>
</table>`);
}

export function filePage(i: MediaItem, versions: MediaItem[], supersededBy: MediaItem[], email: string): Html {
  const snippet = isImage(i) ? `<img src="${i.url}" alt="${i.alt}">` : isVideo(i) ? `<video src="${i.url}" controls></video>` : `<a href="${i.url}">${i.filename || i.name}</a>`;
  const row = (label: string, value: unknown) => html`<tr><th align="left">${label}</th><td>${value}</td></tr>`;
  const link = (name: string) => (name ? html`<a href="/files/${name}">${name}</a>` : '');
  return page(i.name, email, html`
<h1>${i.filename || i.name}</h1>
<p>${preview(i, 480)}</p>
<p><label>Public URL<br><input readonly size="80" value="${i.url}"></label></p>
<p><label>HTML<br><textarea readonly rows="2" cols="80">${snippet}</textarea></label></p>
<table border="1" cellpadding="4">
${row('Name', i.name)}
${row('Filename', i.filename)}
${row('Type', i.contentType)}
${row('Size', `${size(i.size)} (${i.size} bytes)`)}
${row('sha256', html`<code>${i.sha256}</code>`)}
${row('Alt text', i.alt)}
${row('Category', i.category ? html`<a href="/?category=${encodeURIComponent(i.category)}">${i.category}</a>` : '')}
${row('Asset', i.asset ? html`<a href="/?asset=${encodeURIComponent(i.asset)}">${i.asset}</a>` : '')}
${row('Supersedes', link(i.supersedes))}
${row('Superseded by', supersededBy.map((s) => html`${link(s.name)} `))}
${row('Note', i.note)}
${row('Uploaded', `${day(i.uploadedAt)} by ${i.uploadedBy}`)}
${row('Labels changed', i.updatedAt ? `${day(i.updatedAt)} by ${i.updatedBy}` : '')}
</table>
${versions.length ? html`
<h2>Versions of ${i.asset}</h2>
<p>Newest first; the newest is the one pages should use.</p>
<ol>${versions.map((v, n) => html`<li>${v.name === i.name ? html`<strong>${v.name}</strong>` : link(v.name)} ${v.filename} · ${day(v.uploadedAt)} · ${v.uploadedBy}${n === 0 ? ' · newest' : ''}</li>`)}</ol>` : ''}
<h2>Change labels</h2>
<pre>media-library label ${i.name} --category &lt;category&gt; --asset &lt;asset-id&gt; --alt "…" --note "…"
media-library upload &lt;new file&gt; --asset ${i.asset || html`&lt;asset-id&gt;`}   (a new version)</pre>`);
}
