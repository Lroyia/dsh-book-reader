/**
 * EPUB parsing: container metadata, the reading order, the plain text of
 * every chapter, and the illustrations those chapters point at.
 *
 * The parser walks the standard EPUB structure — `META-INF/container.xml`
 * names the package document, the package document lists the manifest and the
 * spine — and reads the navigation document when the book has one, so chapter
 * names come from the book's own table of contents.
 *
 * A chapter is returned as a list of blocks rather than one string: a
 * paragraph is a text block and an illustration is an image block, so the
 * reader can show the pictures where the book puts them.
 */
import { open } from 'node:fs/promises';
import {
  findEndOfCentralDirectory,
  parseZipDirectory,
  readZipDirectory,
  readZipEntryData,
  readZipEntryDataAt,
  resolveArchivePath,
} from './zip.js';
import { normalizeText } from './text.js';

/** Bytes read from the end of a book to find its ZIP directory. */
const TAIL_BYTES = 128 * 1024;
/** Smallest file that can hold a ZIP end-of-central-directory record. */
const EOCD_SIZE_FLOOR = 22;
/** Private-use marker that carries an image through the text extractor. */
const IMAGE_MARK = '\uE000';
const IMAGE_MARK_END = '\uE001';

/** Image types the reader can show, by file extension. */
export const IMAGE_MIME_TYPES = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  avif: 'image/avif',
};

/**
 * The media type of an archive entry, by its extension.
 * @param {string} name - the archive path.
 * @returns {string|undefined} the media type, when the extension names one.
 */
export function imageMimeType(name) {
  const match = /\.([a-z0-9]+)$/i.exec(name);
  if (match === null) return undefined;
  return IMAGE_MIME_TYPES[match[1].toLowerCase()];
}

/**
 * Decode the HTML entities of a text run.
 * @param {string} text - the raw text.
 * @returns {string} the decoded text.
 */
export function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const named = ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

/** Named HTML entities an EPUB chapter may carry. */
const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  laquo: '«',
  raquo: '»',
  middot: '·',
  times: '×',
  copy: '©',
  reg: '®',
  deg: '°',
  bull: '•',
  dagger: '†',
};

/**
 * Read one attribute of an XML tag.
 * @param {string} tag - the tag source.
 * @param {string} name - the attribute name.
 * @returns {string|undefined} the attribute value, when present.
 */
function attribute(tag, name) {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
  if (match === null) return undefined;
  return decodeEntities(match[2] ?? match[3] ?? '');
}

/**
 * Collect every element with the given tag name.
 * @param {string} xml - the document.
 * @param {string} tag - the tag name.
 * @returns {string[]} the tag sources, in document order.
 */
function tagsOf(xml, tag) {
  const pattern = new RegExp(`<${tag}\\b[^>]*?(?:/>|>)`, 'gi');
  return xml.match(pattern) ?? [];
}

/**
 * Read the text of the first element with the given tag name.
 * @param {string} xml - the document.
 * @param {string} tag - the tag name.
 * @returns {string|undefined} the element's text, when present.
 */
function textOfTag(xml, tag) {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  if (match === null) return undefined;
  const text = decodeEntities(match[1].replace(/<[^>]+>/g, '')).trim();
  return text === '' ? undefined : text;
}

/**
 * Turn an XHTML document into plain text lines.
 * @param {string} html - the document source.
 * @returns {string[]} the text lines.
 */
export function htmlToLines(html) {
  return htmlToBlocks(html, () => undefined).blocks
    .filter((block) => block.t === 'p')
    .map((block) => block.text);
}

/**
 * Turn an XHTML document into reader blocks.
 *
 * A paragraph becomes a text block and an illustration becomes an image block
 * that carries the image's place in the book's image list, so the host can
 * hand the reader a URL for it.
 * @param {string} html - the document source.
 * @param {(src: string, alt: string) => object|undefined} resolveImage - builds the image block for one source.
 * @returns {{ blocks: object[], images: {src: string, alt: string}[] }} the blocks and the images they reference.
 */
export function htmlToBlocks(html, resolveImage) {
  const images = [];
  let text = html;
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/<head\b[\s\S]*?<\/head>/gi, '');
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');

  // Illustrations become markers before the tags are stripped, so the picture
  // keeps its place in the text.
  const marker = (tag) => {
    const src = attribute(tag, 'src') ?? attribute(tag, 'href') ?? attribute(tag, 'xlink:href');
    if (src === undefined || src === '' || /^data:/i.test(src) || /^https?:/i.test(src)) return '';
    const alt = attribute(tag, 'alt') ?? '';
    const index = images.push({ src, alt }) - 1;
    return `${IMAGE_MARK}${index}${IMAGE_MARK_END}`;
  };
  text = text.replace(/<img\b[^>]*>/gi, marker);
  text = text.replace(/<image\b[^>]*>/gi, marker);

  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|blockquote|pre|section|article|figcaption)\s*>/gi, '\n');
  text = text.replace(/<(p|div|h[1-6]|li|tr|blockquote|pre|section|article|figcaption)\b[^>]*>/gi, '\n');
  text = text.replace(/<[^>]+>/g, '');
  text = decodeEntities(text);

  const blocks = [];
  const pattern = new RegExp(`${IMAGE_MARK}(\\d+)${IMAGE_MARK_END}`, 'g');
  for (const line of normalizeText(text).split('\n')) {
    const trimmed = line.replace(/[ \t]+/g, ' ').trim();
    if (trimmed === '') continue;
    let lastIndex = 0;
    let match;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(trimmed)) !== null) {
      const before = trimmed.slice(lastIndex, match.index).trim();
      if (before !== '') blocks.push({ t: 'p', text: before });
      const image = images[Number(match[1])];
      const block = image === undefined ? undefined : resolveImage(image.src, image.alt);
      if (block !== undefined) blocks.push(block);
      lastIndex = match.index + match[0].length;
    }
    const after = trimmed.slice(lastIndex).trim();
    if (after !== '') blocks.push({ t: 'p', text: after });
  }
  return { blocks, images };
}

/**
 * Read the navigation labels of a book.
 *
 * EPUB 3 keeps the table of contents in a navigation document, EPUB 2 in an
 * NCX file; both map a document path to a chapter name.
 * @param {Map<string, import('./zip.js').ZipEntry>} directory - the archive directory.
 * @param {string} opfPath - the package document path.
 * @param {Map<string, object>} manifest - the manifest, id to item.
 * @param {(entry: import('./zip.js').ZipEntry) => Buffer} readEntry - reads one entry.
 * @returns {Map<string, string>} the document path to chapter name map.
 */
function readNavigation(directory, opfPath, manifest, readEntry) {
  const labels = new Map();
  for (const item of manifest.values()) {
    const path = resolveArchivePath(opfPath, item.href);
    const isNav = (item.properties ?? '').split(/\s+/).includes('nav');
    const isNcx = (item.mediaType ?? '').includes('dtbncx');
    if (!isNav && !isNcx) continue;
    const entry = directory.get(path);
    if (entry === undefined) continue;
    let xml;
    try {
      xml = readEntry(entry).toString('utf8');
    } catch {
      continue;
    }
    if (isNav) {
      for (const anchor of xml.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) ?? []) {
        const href = attribute(anchor, 'href');
        if (href === undefined || href.includes('#')) continue;
        const label = decodeEntities(anchor.replace(/<[^>]+>/g, '')).trim();
        if (label === '') continue;
        const target = resolveArchivePath(path, decodeEntities(href.split('#')[0]));
        if (!labels.has(target)) labels.set(target, label);
      }
      continue;
    }
    for (const point of xml.match(/<navPoint\b[\s\S]*?<\/navPoint>/gi) ?? []) {
      const source = /<content\b[^>]*\bsrc\s*=\s*("([^"]*)"|'([^']*)')/i.exec(point);
      const label = textOfTag(point, 'text');
      if (source === null || label === undefined) continue;
      const target = resolveArchivePath(path, decodeEntities(source[2] ?? source[3] ?? ''));
      if (!labels.has(target)) labels.set(target, label);
    }
  }
  return labels;
}

/**
 * Parse the package document of an archive.
 * @param {string} opfXml - the package document.
 * @param {string} opfPath - the package document path.
 * @returns {{ title: string|undefined, author: string|undefined, manifest: Map<string, object>, spine: object[], coverId: string|undefined }} the package facts.
 */
function parsePackage(opfXml, opfPath) {
  const title = textOfTag(opfXml, 'dc:title') ?? textOfTag(opfXml, 'title');
  const author = textOfTag(opfXml, 'dc:creator') ?? textOfTag(opfXml, 'creator');

  const manifest = new Map();
  for (const tag of tagsOf(opfXml, 'item')) {
    const id = attribute(tag, 'id');
    const href = attribute(tag, 'href');
    if (id === undefined || href === undefined) continue;
    manifest.set(id, {
      id,
      href: decodeEntities(href.split('#')[0]),
      mediaType: attribute(tag, 'media-type') ?? '',
      properties: attribute(tag, 'properties') ?? '',
    });
  }

  const spine = [];
  for (const tag of tagsOf(opfXml, 'itemref')) {
    const idref = attribute(tag, 'idref');
    if (idref === undefined) continue;
    if (!manifest.has(idref)) continue;
    spine.push(manifest.get(idref));
  }

  // The cover is declared in three different ways across the books in the
  // wild. Each of them names a manifest item, but only some of them name the
  // cover *image* — a guide reference usually points at the cover page — so
  // the declarations are kept as candidates and the image is picked from them.
  const coverCandidates = [];
  for (const tag of tagsOf(opfXml, 'meta')) {
    if ((attribute(tag, 'name') ?? '').toLowerCase() !== 'cover') continue;
    const content = attribute(tag, 'content');
    if (content !== undefined) coverCandidates.push(content);
  }
  for (const item of manifest.values()) {
    if ((item.properties ?? '').split(/\s+/).includes('cover-image')) coverCandidates.push(item.id);
  }
  for (const reference of tagsOf(opfXml, 'reference')) {
    if ((attribute(reference, 'type') ?? '').toLowerCase() !== 'cover') continue;
    const href = attribute(reference, 'href');
    if (href === undefined) continue;
    const target = decodeEntities(href.split('#')[0]);
    for (const item of manifest.values()) {
      if (item.href === target) coverCandidates.push(item.id);
    }
  }
  return { title, author, manifest, spine, coverCandidates };
}

/**
 * Find the cover image of a package.
 *
 * The first candidate that names an actual image wins, so a book whose guide
 * points at its cover *page* still gets the image the metadata declares.
 * @param {object} facts - the package facts.
 * @param {string} opfPath - the package document path.
 * @returns {string|undefined} the cover's archive path.
 */
function coverPathOf(facts, opfPath) {
  const seen = new Set();
  for (const candidate of facts.coverCandidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const item = facts.manifest.get(candidate) ?? [...facts.manifest.values()].find((entry) => entry.href.endsWith(candidate));
    if (item === undefined) continue;
    const path = resolveArchivePath(opfPath, item.href);
    if (imageMimeType(path) === undefined) continue;
    return path;
  }
  return undefined;
}

/**
 * Parse an EPUB file that is already in memory.
 * @param {Buffer} buffer - the file bytes.
 * @returns {{ title: string, author: string|undefined, chapters: { title: string, blocks: object[] }[], images: { path: string, alt: string }[], warnings: string[] }} the parsed book.
 * @throws when the file is not a readable EPUB container.
 */
export function parseEpub(buffer) {
  const { entries: directory, warnings } = readZipDirectory(buffer);
  const containerEntry = directory.get('META-INF/container.xml');
  if (containerEntry === undefined) throw new Error('not an epub file: META-INF/container.xml is missing');
  const containerXml = readZipEntryData(buffer, containerEntry).toString('utf8');
  const rootFile = /<rootfile\b[^>]*\bfull-path\s*=\s*("([^"]*)"|'([^']*)')/i.exec(containerXml);
  if (rootFile === null) throw new Error('not an epub file: no rootfile in META-INF/container.xml');
  const opfPath = decodeEntities(rootFile[2] ?? rootFile[3] ?? '').replace(/^\/+/, '');
  const opfEntry = directory.get(opfPath);
  if (opfEntry === undefined) throw new Error(`not an epub file: package document ${opfPath} is missing`);
  const opfXml = readZipEntryData(buffer, opfEntry).toString('utf8');
  const packageFacts = parsePackage(opfXml, opfPath);

  const navigation = readNavigation(directory, opfPath, packageFacts.manifest, (entry) => readZipEntryData(buffer, entry));

  const images = [];
  const imageIndex = new Map();
  const chapters = [];
  for (const item of packageFacts.spine) {
    const path = resolveArchivePath(opfPath, item.href);
    const entry = directory.get(path);
    if (entry === undefined) {
      warnings.push(`missing chapter document: ${path}`);
      continue;
    }
    let html;
    try {
      html = readZipEntryData(buffer, entry).toString('utf8');
    } catch (error) {
      warnings.push(`unreadable chapter ${path}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const heading = /<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(html);
    const headingText = heading === null ? undefined : decodeEntities(heading[1].replace(/<[^>]+>/g, '')).trim();
    const label = navigation.get(path) ?? headingText ?? `第 ${chapters.length + 1} 章`;
    const parsed = htmlToBlocks(html, (src, alt) => {
      const archivePath = resolveArchivePath(path, src);
      if (imageMimeType(archivePath) === undefined) return undefined;
      let index = imageIndex.get(archivePath);
      if (index === undefined) {
        index = images.length;
        images.push({ path: archivePath, alt });
        imageIndex.set(archivePath, index);
      }
      return { t: 'img', index, alt };
    });
    chapters.push({ title: label === '' ? `第 ${chapters.length + 1} 章` : label, blocks: parsed.blocks });
  }

  return {
    title: packageFacts.title ?? '',
    author: packageFacts.author,
    chapters,
    images,
    directory,
    warnings,
  };
}

/**
 * Read the package document of a book without reading the whole file.
 *
 * A book's title, author and cover live in the ZIP directory and in two small
 * documents inside it, so this reader costs a few kilobytes instead of the
 * whole archive — the difference between a quick import and a multi-gigabyte
 * download when the shelf points at a network share.
 * @param {string} path - the absolute file path.
 * @returns {Promise<{ title: string|undefined, author: string|undefined, coverPath: string|undefined, directory: Map<string, import('./zip.js').ZipEntry> }>} the package facts.
 */
async function readEpubPackage(path) {
  const handle = await open(path, 'r');
  try {
    const info = await handle.stat();
    const size = info.size;
    if (size < EOCD_SIZE_FLOOR) throw new Error('not an epub file: too short');

    const tailLength = Math.min(size, TAIL_BYTES);
    const tail = Buffer.alloc(tailLength);
    const tailStart = size - tailLength;
    await handle.read(tail, 0, tailLength, tailStart);

    const eocdInTail = findEndOfCentralDirectory(tail);
    if (eocdInTail < 0) throw new Error('not an epub file: no end-of-central-directory record');
    const total = tail.readUInt16LE(eocdInTail + 10);
    const directorySize = tail.readUInt32LE(eocdInTail + 12);
    const directoryOffset = tail.readUInt32LE(eocdInTail + 16);
    if (directoryOffset === 0xffffffff || directorySize === 0xffffffff || total === 0xffff) {
      throw new Error('unsupported zip archive: zip64 containers are not supported');
    }

    let directoryBytes;
    if (directoryOffset >= tailStart && directoryOffset + directorySize <= size) {
      directoryBytes = tail.subarray(directoryOffset - tailStart, directoryOffset - tailStart + directorySize);
    } else {
      directoryBytes = Buffer.alloc(directorySize);
      const read = await handle.read(directoryBytes, 0, directorySize, directoryOffset);
      if (read.bytesRead < directorySize) throw new Error('corrupt zip archive: central directory is out of range');
    }

    const { entries: directory } = parseZipDirectory(directoryBytes, total);
    const containerEntry = directory.get('META-INF/container.xml');
    if (containerEntry === undefined) throw new Error('not an epub file: META-INF/container.xml is missing');
    const containerXml = (await readZipEntryDataAt(handle, containerEntry)).toString('utf8');
    const rootFile = /<rootfile\b[^>]*\bfull-path\s*=\s*("([^"]*)"|'([^']*)')/i.exec(containerXml);
    if (rootFile === null) throw new Error('not an epub file: no rootfile in META-INF/container.xml');
    const opfPath = decodeEntities(rootFile[2] ?? rootFile[3] ?? '').replace(/^\/+/, '');
    const opfEntry = directory.get(opfPath);
    if (opfEntry === undefined) throw new Error(`not an epub file: package document ${opfPath} is missing`);
    const opfXml = (await readZipEntryDataAt(handle, opfEntry)).toString('utf8');
    const facts = parsePackage(opfXml, opfPath);

    let coverPath;
    if (facts.coverCandidates.length > 0) {
      coverPath = coverPathOf(facts, opfPath);
    }
    return { title: facts.title, author: facts.author, coverPath, directory };
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Read only the metadata of an EPUB file.
 * @param {string} path - the absolute file path.
 * @returns {Promise<{ title: string|undefined, author: string|undefined }>} the metadata.
 */
export async function readEpubMetadataFromPath(path) {
  try {
    const facts = await readEpubPackage(path);
    return { title: facts.title, author: facts.author };
  } catch {
    return { title: undefined, author: undefined };
  }
}

/**
 * Read the cover image of an EPUB file.
 *
 * The cover is one image inside the archive, so it costs one positioned read
 * rather than a download of the whole book.
 * @param {string} path - the absolute file path.
 * @returns {Promise<{ data: Buffer, type: string }|undefined>} the cover, when the book has one.
 */
export async function readEpubCoverFromPath(path) {
  let handle;
  try {
    handle = await open(path, 'r');
    const info = await handle.stat();
    const size = info.size;
    if (size < EOCD_SIZE_FLOOR) return undefined;

    const tailLength = Math.min(size, TAIL_BYTES);
    const tail = Buffer.alloc(tailLength);
    const tailStart = size - tailLength;
    await handle.read(tail, 0, tailLength, tailStart);
    const eocdInTail = findEndOfCentralDirectory(tail);
    if (eocdInTail < 0) return undefined;
    const total = tail.readUInt16LE(eocdInTail + 10);
    const directorySize = tail.readUInt32LE(eocdInTail + 12);
    const directoryOffset = tail.readUInt32LE(eocdInTail + 16);
    let directoryBytes;
    if (directoryOffset >= tailStart && directoryOffset + directorySize <= size) {
      directoryBytes = tail.subarray(directoryOffset - tailStart, directoryOffset - tailStart + directorySize);
    } else {
      directoryBytes = Buffer.alloc(directorySize);
      const read = await handle.read(directoryBytes, 0, directorySize, directoryOffset);
      if (read.bytesRead < directorySize) return undefined;
    }
    const { entries: directory } = parseZipDirectory(directoryBytes, total);
    const containerEntry = directory.get('META-INF/container.xml');
    if (containerEntry === undefined) return undefined;
    const containerXml = (await readZipEntryDataAt(handle, containerEntry)).toString('utf8');
    const rootFile = /<rootfile\b[^>]*\bfull-path\s*=\s*("([^"]*)"|'([^']*)')/i.exec(containerXml);
    if (rootFile === null) return undefined;
    const opfPath = decodeEntities(rootFile[2] ?? rootFile[3] ?? '').replace(/^\/+/, '');
    const opfEntry = directory.get(opfPath);
    if (opfEntry === undefined) return undefined;
    const opfXml = (await readZipEntryDataAt(handle, opfEntry)).toString('utf8');
    const facts = parsePackage(opfXml, opfPath);
    const coverPath = coverPathOf(facts, opfPath);
    if (coverPath === undefined) return undefined;
    const type = imageMimeType(coverPath);
    if (type === undefined) return undefined;
    const entry = directory.get(coverPath);
    if (entry === undefined) return undefined;
    const data = await readZipEntryDataAt(handle, entry);
    return { data, type };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}
