import { describe, expect, it } from 'vitest';
import type { AssistantConfig, WebTransport } from '../src/metadata/assistant/client.js';
import { decodeHtml, extractPageImages } from '../src/metadata/assistant/page-images.js';
import { summarizeToolResult } from '../src/metadata/assistant/agent.js';
import {
  MAX_PAGE_IMAGES_CALLS,
  executeWebTool,
  newWebToolState,
  type WebToolState,
} from '../src/metadata/assistant/web-tools.js';

const config: AssistantConfig = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  apiKey: 'sk-agent-key-1111',
  webSearch: 'deepseek',
  searchApiKey: null,
  googleBooksApiKey: null,
};

/** A trimmed copy of the markup on https://book.douban.com/subject/25869109/. */
const DOUBAN_PAGE = `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="UTF-8">
<title>黑格尔《精神现象学》句读（第一卷） (豆瓣)</title>
<link rel="shortcut icon" href="https://img1.doubanio.com/favicon.ico">
<meta property="og:title" content="黑格尔《精神现象学》句读（第一卷）" />
<meta property="og:image" content="https://img3.doubanio.com/view/subject/l/public/s28305968.jpg" />
<script>var img = '<img src="https://ads.example.com/in-script.jpg">';</script>
</head><body>
<!-- <img src="https://img3.doubanio.com/commented-out.jpg"> -->
<img src="https://img1.doubanio.com/f/shire/logo_db.png" alt="豆瓣读书" class="logo">
<div id="mainpic">
  <a class="nbg" href="https://img3.doubanio.com/view/subject/l/public/s28305968.jpg" title="黑格尔《精神现象学》句读（第一卷）">
    <img src="https://img3.doubanio.com/view/subject/s/public/s28305968.jpg" title="点击看大图" alt="黑格尔《精神现象学》句读（第一卷）" rel="v:photo" style="width: 135px;max-height: 200px;">
  </a>
</div>
<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="">
<img src="/pics/sprite_icons.png">
<img src="https://img9.doubanio.com/icon/u1234-5.jpg" class="avatar" width="48" height="48">
<img src="https://www.douban.com/pixel.gif" width="1" height="1">
<img src="https://img1.doubanio.com/view/subject/s/public/s3315.jpg" alt="喜欢读这本书的人也喜欢">
</body></html>`;

interface Seen {
  url: string;
  headers: Record<string, string>;
  method: string;
  redirect: string | undefined;
}

function pageTransport(handler: (url: URL) => Response, dns: Record<string, string[]> = {}) {
  const seen: Seen[] = [];
  const transport: WebTransport = {
    async fetch(input, init) {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      seen.push({
        url: url.href,
        headers: { ...(init?.headers as Record<string, string>) },
        method: init?.method ?? 'GET',
        redirect: init?.redirect,
      });
      return handler(url);
    },
    async lookup(host) {
      return dns[host] ?? ['93.184.216.34'];
    },
  };
  return { transport, seen };
}

const html = (body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });

function pageImages(url: string, transport: WebTransport, state: WebToolState = newWebToolState(), settings = config) {
  return executeWebTool('page_images', { url }, { config: settings, transport, state });
}

describe('page image extraction', () => {
  it('lists og:image first, then cover-like <img> tags, and skips icons, sprites, pixels, and data URIs', () => {
    const { title, images } = extractPageImages(DOUBAN_PAGE, new URL('https://book.douban.com/subject/25869109/'));
    expect(title).toBe('黑格尔《精神现象学》句读（第一卷） (豆瓣)');
    expect(images).toEqual([
      { url: 'https://img3.doubanio.com/view/subject/l/public/s28305968.jpg', kind: 'og:image' },
      {
        url: 'https://img3.doubanio.com/view/subject/s/public/s28305968.jpg',
        kind: 'img',
        alt: '黑格尔《精神现象学》句读（第一卷）',
      },
      { url: 'https://img1.doubanio.com/view/subject/s/public/s3315.jpg', kind: 'img', alt: '喜欢读这本书的人也喜欢' },
    ]);
  });

  it('reads twitter and image_src tags, og:image sizes, srcset, lazy sources, <base>, and entities', () => {
    const page = `<head><base href="https://cdn.example.com/books/">
      <meta name="twitter:image" content="https://cdn.example.com/t.jpg?a=1&amp;b=2">
      <meta property="og:image" content="/og.jpg"><meta property="og:image:width" content="600"><meta property="og:image:height" content="900">
      <link rel="image_src" href="covers/src.jpg"></head>
      <body><img data-src="lazy-cover.jpg" src="placeholder.png" class="book-cover">
      <img srcset="small.jpg 200w, large.jpg 800w" alt="Cover of the book">
      <img src="https://cdn.example.com/t.jpg?a=1&b=2">
      <img src="photo.svg" alt="cover"><img src="other.webp" width="400" height="600"></body>`;
    const { images } = extractPageImages(page, new URL('https://www.example.com/item/1'));
    expect(images).toEqual([
      { url: 'https://cdn.example.com/t.jpg?a=1&b=2', kind: 'twitter:image' },
      { url: 'https://cdn.example.com/og.jpg', kind: 'og:image', width: 600, height: 900 },
      { url: 'https://cdn.example.com/books/covers/src.jpg', kind: 'image_src' },
      { url: 'https://cdn.example.com/books/lazy-cover.jpg', kind: 'img' },
      { url: 'https://cdn.example.com/books/large.jpg', kind: 'img', alt: 'Cover of the book' },
      { url: 'https://cdn.example.com/books/other.webp', kind: 'img', width: 400, height: 600 },
    ]);
  });

  it('returns at most eight images and only absolute http(s) URLs', () => {
    const tags = Array.from({ length: 12 }, (_, index) => `<img src="https://img.example.com/cover-${index}.jpg">`).join('');
    const { images } = extractPageImages(`${tags}<img src="javascript:alert(1)"><img src="ftp://x.example.com/c.jpg">`, new URL('https://example.com/'));
    expect(images).toHaveLength(8);
    expect(images.every((image) => image.url.startsWith('https://img.example.com/'))).toBe(true);
  });

  it('decodes a GBK page by its declared charset', () => {
    const bytes = Buffer.from([...Buffer.from('<meta charset="gbk"><title>'), 0xb7, 0xe2, 0xc3, 0xe6, ...Buffer.from('</title>')]);
    expect(extractPageImages(decodeHtml(bytes, 'text/html'), new URL('https://example.com/')).title).toBe('封面');
  });
});

describe('page_images tool', () => {
  it('fetches the page directly with browser headers and no DeepSeek call or key', async () => {
    const { transport, seen } = pageTransport(() => html(DOUBAN_PAGE));
    const result = JSON.parse(await pageImages('https://book.douban.com/subject/25869109/', transport)) as Record<string, unknown>;
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ url: 'https://book.douban.com/subject/25869109/', method: 'GET', redirect: 'manual' });
    expect(seen[0]!.headers['user-agent']).toMatch(/^Mozilla\/5\.0 .*Chrome/);
    expect(seen[0]!.headers.accept).toContain('text/html');
    expect(seen[0]!.headers.authorization).toBeUndefined();
    expect(seen[0]!.headers.referer).toBeUndefined();
    expect(JSON.stringify(seen)).not.toContain(config.apiKey);
    expect(result).toMatchObject({ url: 'https://book.douban.com/subject/25869109/', host: 'book.douban.com' });
    expect((result.images as Array<{ kind: string }>)[0]).toEqual({
      url: 'https://img3.doubanio.com/view/subject/l/public/s28305968.jpg',
      kind: 'og:image',
    });
    expect(summarizeToolResult('page_images', JSON.stringify(result))).toMatchObject({
      count: 3,
      host: 'book.douban.com',
      url: 'https://book.douban.com/subject/25869109/',
    });
  });

  it('applies the fetch_page URL rules before any request', async () => {
    const { transport, seen } = pageTransport(() => html(DOUBAN_PAGE), { 'private.example.com': ['192.168.1.4'], 'mapped.example.com': ['::ffff:127.0.0.1'] });
    for (const url of [
      'http://127.0.0.1/',
      'http://[::1]/',
      'https://user:secret@book.douban.com/',
      'https://private.example.com/',
      'https://mapped.example.com/',
      'https://localhost/',
      'https://book.douban.com:8080/',
      'file:///etc/passwd',
    ]) {
      expect(JSON.parse(await pageImages(url, transport))).toMatchObject({ error: 'url_rejected' });
    }
    expect(seen).toEqual([]);
  });

  it('re-validates each redirect hop and stops after three redirects', async () => {
    const internal = pageTransport(
      (url) =>
        url.hostname === 'book.example.com'
          ? new Response(null, { status: 301, headers: { location: 'https://admin.example.net/' } })
          : html(DOUBAN_PAGE),
      { 'admin.example.net': ['10.1.2.3'] },
    );
    expect(JSON.parse(await pageImages('https://book.example.com/x', internal.transport))).toMatchObject({ error: 'url_rejected' });
    expect(internal.seen.map((item) => item.url)).toEqual(['https://book.example.com/x']);

    let hop = 0;
    const loop = pageTransport(() => new Response(null, { status: 302, headers: { location: `/next-${(hop += 1)}` } }));
    expect(JSON.parse(await pageImages('https://book.example.com/start', loop.transport))).toMatchObject({
      error: 'page_too_many_redirects',
    });
    expect(loop.seen).toHaveLength(4);

    const moved = pageTransport((url) =>
      url.pathname === '/old' ? new Response(null, { status: 302, headers: { location: '/new' } }) : html(DOUBAN_PAGE),
    );
    expect(JSON.parse(await pageImages('https://book.example.com/old', moved.transport))).toMatchObject({
      url: 'https://book.example.com/new',
    });
  });

  it('allows four calls per run and reads only the first 2 MiB of a page', async () => {
    const big = `<meta property="og:image" content="https://img.example.com/cover.jpg">${' '.repeat(3 * 1024 * 1024)}<img src="https://img.example.com/cover-late.jpg">`;
    const { transport, seen } = pageTransport(() => html(big));
    const state = newWebToolState();
    for (let index = 0; index < MAX_PAGE_IMAGES_CALLS; index += 1) {
      const result = JSON.parse(await pageImages(`https://book.example.com/${index}`, transport, state)) as Record<string, unknown>;
      expect(result).toMatchObject({ pageTruncated: true, images: [{ url: 'https://img.example.com/cover.jpg', kind: 'og:image' }] });
      expect(result.images).toHaveLength(1);
    }
    expect(JSON.parse(await pageImages('https://book.example.com/5', transport, state))).toMatchObject({ error: 'limit_reached' });
    expect(seen).toHaveLength(MAX_PAGE_IMAGES_CALLS);
  });

  it('refuses a non-HTML response and reports HTTP errors', async () => {
    const image = pageTransport(() => new Response('x', { status: 200, headers: { 'content-type': 'image/jpeg' } }));
    expect(JSON.parse(await pageImages('https://book.example.com/', image.transport))).toMatchObject({ error: 'not_html' });
    const blocked = pageTransport(() => new Response('no', { status: 403 }));
    expect(JSON.parse(await pageImages('https://book.example.com/', blocked.transport))).toMatchObject({
      error: 'page_http_error',
      status: 403,
    });
  });

  it('is unavailable when web search is off', async () => {
    const { transport, seen } = pageTransport(() => html(DOUBAN_PAGE));
    const off = { ...config, webSearch: 'off' as const };
    expect(JSON.parse(await pageImages('https://book.douban.com/subject/1/', transport, newWebToolState(), off))).toMatchObject({
      error: 'unknown_tool',
    });
    expect(seen).toEqual([]);
  });
});
