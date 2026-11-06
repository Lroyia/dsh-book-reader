/**
 * 书架阅读器 —— Host half.
 *
 * Serves the plugin's own route family over the browser HTTP carrier:
 * scanning a local folder for EPUB/TXT files, adding the chosen files to the
 * local bookshelf, reading a book's chapters, and remembering the reading
 * position.
 *
 * The routes are the plugin's own data channel, so they carry a trust fence:
 * only a loopback request that the browser itself made may enter them. A
 * remote page on the same machine cannot drive them, and the files they read
 * are the ones the user added to the shelf.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { decodeText, normalizeText, splitChapters, toBlocks } from './lib/text.js';
import { parseEpub, readEpubCoverFromPath, readEpubMetadataFromPath } from './lib/epub.js';
import { parseDocx } from './lib/docx.js';
import { parsePdf, pdfChapters } from './lib/pdf.js';
import { readCachedCover, readCachedImage, readCoverStamp, readManifest, writeCoverCache, writeImageCache } from './lib/images.js';
import { bookId, mergeBookRecord, readLibrary, upsertBook, writeLibrary } from './lib/store.js';
import { readZipEntryData } from './lib/zip.js';

/** Services this plugin needs before its routes can mount. */
export const inject = ['webServer'];

/** Route paths (the browser half mirrors these literals without the leading slash). */
const ROUTES = {
  scan: '/api/book-reader/scan',
  library: '/api/book-reader/library',
  add: '/api/book-reader/add',
  remove: '/api/book-reader/remove',
  book: '/api/book-reader/book',
  progress: '/api/book-reader/progress',
  image: '/api/book-reader/image',
  cover: '/api/book-reader/cover',
  health: '/api/book-reader/health',
};

/**
 * The document-relative URLs the browser half asks for.
 *
 * The page is served with a relative base, so a URL that starts with a slash
 * would leave the deployment's prefix; the browser half therefore uses these
 * forms and the host serves the matching absolute routes.
 */
const CLIENT_URLS = {
  image: 'api/book-reader/image',
  cover: 'api/book-reader/cover',
};

/** Deepest folder level one scan walks into. */
const MAX_SCAN_DEPTH = 6;
/** Most directory entries one scan looks at. */
const MAX_SCAN_ENTRIES = 20000;
/** Most books one scan reports. */
const MAX_SCAN_BOOKS = 1000;
/** Largest request body the routes read. */
const MAX_BODY_BYTES = 256 * 1024;
/** Longest one file operation may take before the book is given up on. */
const FILE_TIMEOUT_MS = 15000;
/** Longest one import request may spend before it returns what it has. */
const IMPORT_BUDGET_MS = 90000;
/** Longest one book read may take before the request gives up. */
const BOOK_TIMEOUT_MS = 60000;
/** Largest book the reader opens, in bytes. */
const MAX_BOOK_BYTES = 300 * 1024 * 1024;

/**
 * Give up on an operation that takes too long.
 *
 * A network share that stops answering must not hold a request open forever:
 * the operation is abandoned and the caller decides what to do about it.
 * @param {Promise<T>} promise - the operation.
 * @param {number} ms - the budget.
 * @param {string} label - the operation's name, for the failure message.
 * @returns {Promise<T>} the operation's result.
 */
function withTimeout(promise, ms, label) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });
}

/**
 * Whether an address names the loopback range.
 * @param {string|undefined} address - a socket address.
 * @returns {boolean} true for 127/8 and ::1.
 */
function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false;
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === '::1' || normalized === '::ffff:127.0.0.1') return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized);
  if (match === null) return false;
  return match[1] === '127' && match.slice(1).every((part) => Number(part) <= 255);
}

/**
 * The trust fence of the plugin's routes.
 *
 * The socket address is the authority: a request that arrived through a proxy
 * carries forwarding headers and is refused, because such a request did not
 * originate on this machine. The browser's own same-origin markers are the
 * second check, so a foreign page cannot drive the routes even from loopback.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {boolean} whether the request may enter the routes.
 */
function isAllowedRequest(req) {
  const headers = req.headers ?? {};
  if (headers['cf-connecting-ip'] !== undefined) return false;
  if (headers['x-forwarded-for'] !== undefined) return false;
  if (!isLoopbackAddress(req.socket?.remoteAddress)) return false;
  const host = headers.host;
  if (typeof host !== 'string') return false;
  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    return false;
  }
  if (!isLoopbackAddress(hostUrl.hostname) && hostUrl.hostname.toLowerCase() !== 'localhost') return false;
  if (headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = headers.origin;
  if (typeof origin === 'string') {
    try {
      if (new URL(origin).host !== hostUrl.host) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {number} status - the status code.
 * @param {unknown} body - the payload.
 */
function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/**
 * Write one binary response, such as an illustration.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {number} status - the status code.
 * @param {string} type - the media type.
 * @param {Buffer} data - the bytes.
 */
function writeBinary(res, status, type, data) {
  res.writeHead(status, {
    'content-type': type,
    'content-length': data.length,
    'referrer-policy': 'no-referrer',
    'cache-control': 'private, max-age=3600',
  });
  res.end(data);
}

/**
 * Read a bounded JSON request body.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {Promise<object|null>} the parsed body, or null when it is absent or malformed.
 */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      req.destroy();
      return null;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return null;
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Read one query parameter.
 * @param {URL} url - the request URL.
 * @param {string} name - the parameter name.
 * @returns {string|undefined} the value, when present.
 */
function queryParam(url, name) {
  return url.searchParams.get(name) ?? undefined;
}

/**
 * The book kind a file extension names.
 * @param {string} path - the file path.
 * @returns {'epub'|'txt'|'pdf'|'docx'|undefined} the kind.
 */
function kindOf(path) {
  const extension = extname(path).toLowerCase();
  if (extension === '.epub') return 'epub';
  if (extension === '.txt') return 'txt';
  if (extension === '.pdf') return 'pdf';
  if (extension === '.docx') return 'docx';
  return undefined;
}

/**
 * Walk a folder and collect the readable books inside it.
 * @param {string} root - the absolute folder path.
 * @returns {Promise<{ books: object[], warnings: string[], truncated: boolean }>} the scan result.
 */
async function scanFolder(root) {
  const books = [];
  const warnings = [];
  let visited = 0;
  let truncated = false;
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length > 0 && !truncated) {
    const { dir, depth } = queue.shift();
    let entries;
    try {
      entries = await withTimeout(readdir(dir, { withFileTypes: true }), FILE_TIMEOUT_MS, 'listing');
    } catch (error) {
      warnings.push(`${dir}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > MAX_SCAN_ENTRIES) {
        truncated = true;
        break;
      }
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_SCAN_DEPTH) queue.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      const kind = kindOf(entry.name);
      if (kind === undefined) continue;
      const info = await withTimeout(stat(full), FILE_TIMEOUT_MS, 'stat').catch(() => undefined);
      books.push({
        path: full,
        name: entry.name,
        kind,
        size: info?.size ?? 0,
        mtime: info?.mtimeMs ?? 0,
      });
      if (books.length >= MAX_SCAN_BOOKS) {
        truncated = true;
        break;
      }
    }
  }
  return { books, warnings, truncated };
}

/**
 * Read one book's chapters.
 *
 * An EPUB's illustrations are extracted into the cache folder once, and the
 * chapter blocks then point at the cached copies; a plain text book has no
 * illustrations and its chapters are paragraphs.
 * @param {string} path - the absolute file path.
 * @param {string} id - the book's identity.
 * @param {string|undefined} dataDir - the configured data directory.
 * @param {number} mtimeMs - the book's modification time, used as the cache version.
 * @returns {Promise<{ title: string, author: string|undefined, chapters: object[], cover: string|undefined }>} the parsed book.
 */
async function parseBook(path, id, dataDir, mtimeMs) {
  const stamp = String(Math.round(mtimeMs));
  const kind = kindOf(path);
  if (kind === 'pdf') {
    const parsed = parsePdf(await readFile(path));
    const manifest = await readManifest(dataDir, id);
    if (manifest?.imageStamp !== stamp) {
      await writeImageCache(dataDir, id, stamp, parsed.images, (image) => image.data);
    }
    const chapters = pdfChapters(parsed).map((chapter) => ({
      title: chapter.title,
      blocks: chapter.blocks.map((block) =>
        block.t === 'img'
          ? { t: 'img', src: `${CLIENT_URLS.image}?id=${encodeURIComponent(id)}&index=${block.index}&v=${stamp}`, alt: block.alt }
          : block,
      ),
    }));
    const hasText = chapters.some((chapter) => chapter.blocks.length > 0);
    return {
      title: usableTitle(parsed.title) ? parsed.title : '',
      author: parsed.author,
      chapters,
      cover: undefined,
      noText: !hasText,
    };
  }
  if (kind === 'docx') {
    const buffer = await readFile(path);
    const parsed = parseDocx(buffer);
    const manifest = await readManifest(dataDir, id);
    if (manifest?.imageStamp !== stamp) {
      await writeImageCache(dataDir, id, stamp, parsed.images, (image) => image.data);
    }
    const chapters = parsed.chapters.map((chapter) => ({
      title: chapter.title,
      blocks: chapter.blocks.map((block) =>
        block.t === 'img'
          ? { t: 'img', src: `${CLIENT_URLS.image}?id=${encodeURIComponent(id)}&index=${block.index}&v=${stamp}`, alt: block.alt }
          : block,
      ),
    }));
    return { title: parsed.title, author: parsed.author, chapters, cover: undefined };
  }
  if (kind === 'epub') {
    const buffer = await readFile(path);
    const parsed = parseEpub(buffer);
    const manifest = await readManifest(dataDir, id);
    if (manifest?.imageStamp !== stamp) {
      await writeImageCache(dataDir, id, stamp, parsed.images, (image) => {
        const entry = parsed.directory.get(image.path);
        return entry === undefined ? undefined : readZipEntryData(buffer, entry);
      });
    }
    const chapters = parsed.chapters.map((chapter) => ({
      title: chapter.title,
      blocks: chapter.blocks.map((block) =>
        block.t === 'img'
          ? { t: 'img', src: `${CLIENT_URLS.image}?id=${encodeURIComponent(id)}&index=${block.index}&v=${stamp}`, alt: block.alt }
          : block,
      ),
    }));
    return { title: parsed.title, author: parsed.author, chapters, cover: coverUrl(id, stamp) };
  }
  const { text, encoding } = decodeText(await readFile(path));
  const chapters = splitChapters(normalizeText(text)).map((chapter) => ({
    title: chapter.title,
    blocks: toBlocks(chapter.text),
  }));
  return { title: '', author: undefined, chapters, cover: coverUrl(id, stamp) };
}

/**
 * The document titles that name no book.
 *
 * A document exported from a word processor often carries the title of its
 * first page — a table of contents, a cover — which says nothing about the
 * book and must not replace the file name on the shelf.
 */
const MEANINGLESS_TITLES = new Set([
  '目录', '目次', '目录页', '封面', '扉页', '无标题', '未命名', 'untitled', 'unknown', 'document',
  'contents', 'table of contents', 'toc', 'index', 'microsoft word', 'microsoft word 文档',
  'microsoft powerpoint 演示文稿', 'microsoft excel 工作表', 'powerpoint presentation',
]);

/**
 * Whether a document's title is worth putting on the shelf.
 * @param {string|undefined} title - the title.
 * @returns {boolean} true when the title names the book.
 */
function usableTitle(title) {
  if (typeof title !== 'string') return false;
  const trimmed = title.trim().toLowerCase();
  return trimmed !== '' && !MEANINGLESS_TITLES.has(trimmed);
}

/**
 * The URL of one book's cover, when the shelf knows of one.
 * @param {string} id - the book's identity.
 * @param {string} stamp - the cache version.
 * @returns {string} the URL.
 */
function coverUrl(id, stamp) {
  return `${CLIENT_URLS.cover}?id=${encodeURIComponent(id)}&v=${stamp}`;
}

/**
 * Give a book on the shelf the title and the author its document carries.
 *
 * A PDF or a Word document is added under its file name — reading the whole
 * file to learn its title would cost a download on a network share — and the
 * real title replaces it the first time the book is opened.
 * @param {string|undefined} dataDir - the configured data directory.
 * @param {object} record - the book's shelf record.
 * @param {object} book - the parsed book.
 * @returns {Promise<void>} resolves once the shelf is updated.
 */
async function refineRecord(dataDir, record, book) {
  const fileName = basename(record.path, extname(record.path));
  const wantsTitle = usableTitle(book.title) && record.title === fileName;
  const wantsAuthor = typeof book.author === 'string' && book.author.trim() !== '' && !record.author;
  if (!wantsTitle && !wantsAuthor) return;
  const document = await readLibrary(dataDir);
  const books = document.books.map((entry) =>
    entry.id === record.id
      ? {
          ...entry,
          title: wantsTitle ? book.title.trim() : entry.title,
          author: wantsAuthor ? book.author.trim() : entry.author,
        }
      : entry,
  );
  await writeLibrary({ version: document.version, books }, dataDir);
}

/**
 * Build the plugin's route list.
 * @param {object} ctx - the host context.
 * @param {string|undefined} dataDir - the configured data directory.
 * @returns {object[]} the routes for `ctx.webServer.register`.
 */
function makeRoutes(ctx, dataDir) {
  /**
   * The trust fence plus a method check.
   * @param {import('node:http').IncomingMessage} req - the request.
   * @param {import('node:http').ServerResponse} res - the response.
   * @param {string} method - the expected method.
   * @returns {boolean} whether the handler may continue.
   */
  function guard(req, res, method) {
    if (!isAllowedRequest(req)) {
      writeJson(res, 403, { error: 'forbidden: this route only serves the local Harness page' });
      return false;
    }
    if (req.method !== method) {
      writeJson(res, 405, { error: `method not allowed: ${req.method}` });
      return false;
    }
    return true;
  }

  /**
   * Report a failure the user can act on.
   * @param {import('node:http').ServerResponse} res - the response.
   * @param {unknown} error - the failure.
   */
  function fail(res, error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger?.warn?.(`[book-reader] ${message}`);
    writeJson(res, 400, { error: message });
  }

  return [
    {
      kind: 'exact',
      path: ROUTES.health,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return;
        writeJson(res, 200, { ok: true });
      },
    },
    {
      kind: 'exact',
      path: ROUTES.scan,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return;
        try {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const raw = queryParam(url, 'path');
          if (typeof raw !== 'string' || raw.trim() === '') {
            writeJson(res, 400, { error: 'path is required' });
            return;
          }
          const root = resolve(raw.trim());
          const info = await stat(root).catch(() => undefined);
          if (info === undefined || !info.isDirectory()) {
            writeJson(res, 400, { error: `not a folder: ${root}` });
            return;
          }
          const result = await scanFolder(root);
          writeJson(res, 200, { root, ...result });
        } catch (error) {
          fail(res, error);
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.library,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return;
        try {
          const document = await readLibrary(dataDir);
          writeJson(res, 200, { books: document.books });
        } catch (error) {
          fail(res, error);
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.add,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return;
        try {
          const body = await readJsonBody(req);
          const paths = Array.isArray(body?.paths) ? body.paths : [];
          if (paths.length === 0) {
            writeJson(res, 400, { error: 'paths is required' });
            return;
          }
          let document = await readLibrary(dataDir);
          const added = [];
          const skipped = [];
          const startedAt = Date.now();
          let timedOut = false;
          for (const candidate of paths) {
            if (Date.now() - startedAt > IMPORT_BUDGET_MS) {
              timedOut = true;
              break;
            }
            if (typeof candidate !== 'string' || candidate.trim() === '') continue;
            const path = resolve(candidate.trim());
            const kind = kindOf(path);
            if (kind === undefined) {
              skipped.push({ path, reason: 'unsupported file type' });
              continue;
            }
            const info = await withTimeout(stat(path), FILE_TIMEOUT_MS, 'stat').catch(() => undefined);
            if (info === undefined || !info.isFile()) {
              skipped.push({ path, reason: 'file not found' });
              continue;
            }
            let title = basename(path, extname(path));
            let author;
            let hasCover = false;
            const id = bookId(path);
            if (kind === 'epub') {
              let metadata = {};
              try {
                // Only the ZIP directory and the two metadata documents are
                // read, so a book on a network share costs kilobytes, not its
                // whole size.
                metadata = await withTimeout(readEpubMetadataFromPath(path), FILE_TIMEOUT_MS, 'metadata');
              } catch {
                // A book whose package document cannot be read keeps its file name.
                metadata = {};
              }
              if (typeof metadata.title === 'string' && metadata.title.trim() !== '') title = metadata.title.trim();
              if (typeof metadata.author === 'string' && metadata.author.trim() !== '') author = metadata.author.trim();
              // The cover is one image inside the archive; caching it here
              // lets the shelf show it without opening the book.
              const cover = await withTimeout(readEpubCoverFromPath(path), FILE_TIMEOUT_MS, 'cover').catch(() => undefined);
              if (cover !== undefined) {
                try {
                  await writeCoverCache(dataDir, id, String(Math.round(info.mtimeMs)), cover);
                  hasCover = true;
                } catch {
                  hasCover = false;
                }
              }
            }
            const existing = document.books.find((book) => book.id === id);
            const record = mergeBookRecord(existing, {
              id,
              path,
              title,
              author,
              kind,
              size: info.size,
              mtime: info.mtimeMs,
              addedAt: existing?.addedAt ?? Date.now(),
              progress: existing?.progress ?? { chapter: 0, percent: 0, updatedAt: 0 },
              cover: hasCover,
            });
            document = upsertBook(document, record);
            added.push(record);
          }
          await writeLibrary(document, dataDir);
          writeJson(res, 200, { books: document.books, added, skipped, timedOut });
        } catch (error) {
          fail(res, error);
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.remove,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return;
        try {
          const body = await readJsonBody(req);
          const id = typeof body?.id === 'string' ? body.id : '';
          if (id === '') {
            writeJson(res, 400, { error: 'id is required' });
            return;
          }
          const document = await readLibrary(dataDir);
          const books = document.books.filter((book) => book.id !== id);
          await writeLibrary({ version: document.version, books }, dataDir);
          writeJson(res, 200, { books });
        } catch (error) {
          fail(res, error);
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.book,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return;
        try {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const id = queryParam(url, 'id') ?? '';
          const document = await readLibrary(dataDir);
          const record = document.books.find((book) => book.id === id);
          if (record === undefined) {
            writeJson(res, 404, { error: 'this book is not on the shelf' });
            return;
          }
          const info = await withTimeout(stat(record.path), FILE_TIMEOUT_MS, 'stat').catch(() => undefined);
          if (info === undefined || !info.isFile()) {
            writeJson(res, 404, { error: 'the file is no longer on disk' });
            return;
          }
          if (info.size > MAX_BOOK_BYTES) {
            writeJson(res, 400, { error: 'this book is too large to open' });
            return;
          }
          const book = await withTimeout(parseBook(record.path, record.id, dataDir, info.mtimeMs), BOOK_TIMEOUT_MS, 'reading the book');
          await refineRecord(dataDir, record, book);
          writeJson(res, 200, {
            id: record.id,
            title: book.title || record.title,
            author: book.author ?? record.author,
            cover: book.cover,
            noText: book.noText === true,
            chapters: book.chapters,
          });
        } catch (error) {
          fail(res, error);
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.image,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return;
        try {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const id = queryParam(url, 'id') ?? '';
          const index = Number.parseInt(queryParam(url, 'index') ?? '', 10);
          if (id === '' || !Number.isInteger(index) || index < 0) {
            writeJson(res, 400, { error: 'id and index are required' });
            return;
          }
          const version = queryParam(url, 'v');
          const manifest = await readManifest(dataDir, id);
          if (version !== undefined && manifest?.imageStamp !== undefined && version !== manifest.imageStamp) {
            writeJson(res, 404, { error: 'the cached illustration is out of date' });
            return;
          }
          const image = await readCachedImage(dataDir, id, index);
          if (image === undefined) {
            writeJson(res, 404, { error: 'this illustration is not cached' });
            return;
          }
          writeBinary(res, 200, image.type, image.data);
        } catch (error) {
          fail(res, error);
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.cover,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return;
        try {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const id = queryParam(url, 'id') ?? '';
          if (id === '') {
            writeJson(res, 400, { error: 'id is required' });
            return;
          }
          // The version the browser asks for must match the cached cover, so
          // a book that changed on disk does not keep its old picture.
          const version = queryParam(url, 'v');
          const stamp = await readCoverStamp(dataDir, id);
          if (version !== undefined && stamp !== undefined && version !== stamp) {
            writeJson(res, 404, { error: 'the cached cover is out of date' });
            return;
          }
          const cover = await readCachedCover(dataDir, id);
          if (cover === undefined) {
            writeJson(res, 404, { error: 'this book has no cached cover' });
            return;
          }
          writeBinary(res, 200, cover.type, cover.data);
        } catch (error) {
          fail(res, error);
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.progress,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return;
        try {
          const body = await readJsonBody(req);
          const id = typeof body?.id === 'string' ? body.id : '';
          const chapter = Number.isInteger(body?.chapter) && body.chapter >= 0 ? body.chapter : 0;
          const percent = typeof body?.percent === 'number' && Number.isFinite(body.percent)
            ? Math.min(1, Math.max(0, body.percent))
            : 0;
          const document = await readLibrary(dataDir);
          const books = document.books.map((book) => {
            if (book.id !== id) return book;
            return {
              ...book,
              progress: { chapter, percent, updatedAt: Date.now() },
              lastReadAt: Date.now(),
            };
          });
          await writeLibrary({ version: document.version, books }, dataDir);
          writeJson(res, 200, { books });
        } catch (error) {
          fail(res, error);
        }
      },
    },
  ];
}

/**
 * Mount the plugin's routes.
 *
 * The routes are registered inside one effect, so unloading the plugin (or
 * replacing the web server) removes every one of them.
 * @param {object} ctx - the host context.
 * @param {{ dataDir?: string }} [config] - the plugin configuration.
 */
export function apply(ctx, config) {
  const dataDir = typeof config?.dataDir === 'string' && config.dataDir.trim() !== '' ? config.dataDir.trim() : undefined;
  const routes = makeRoutes(ctx, dataDir);
  ctx.effect(() => {
    const disposers = routes.map((route) => ctx.webServer.register(route));
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, 'book-reader: routes');
}

export { ROUTES };
