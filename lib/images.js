/**
 * The illustration cache.
 *
 * A book's illustrations live inside its EPUB archive, so the reader cannot
 * point a page at them directly. Opening a book therefore extracts its images
 * once into a cache folder beside the shelf, and the browser asks for them by
 * index. The cache is keyed by the book's identity and carries the file's
 * modification time, so a book that changed on disk is extracted again and a
 * book that did not is served from what is already there.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDirectory } from './store.js';

/** Name of the manifest document inside one book's cache folder. */
const MANIFEST_NAME = 'manifest.json';

/**
 * The cache folder of one book.
 * @param {string|undefined} dataDir - the configured data directory.
 * @param {string} bookId - the book's identity.
 * @returns {string} the absolute folder path.
 */
export function cacheDirectory(dataDir, bookId) {
  return join(dataDirectory(dataDir), 'cache', bookId.replace(/[^a-z0-9_-]/gi, ''));
}

/**
 * Write the images of a book into its cache folder.
 *
 * The images and the cover carry their own version stamp: a book that is
 * imported (cover written) and a book that is opened (images written) happen
 * at different times, and one of them must not pretend the other is current.
 * @param {string|undefined} dataDir - the configured data directory.
 * @param {string} bookId - the book's identity.
 * @param {string} stamp - the value that marks this extraction as current.
 * @param {{ path: string, alt: string, data?: Buffer }[]} images - the images the book references.
 * @param {(image: { path: string, alt: string, data?: Buffer }) => Buffer|undefined} readEntry - reads one image out of the archive.
 * @returns {Promise<{ imageStamp: string, images: ({file: string, type: string}|null)[], cover: {file: string, type: string}|null }>} the manifest.
 */
export async function writeImageCache(dataDir, bookId, stamp, images, readEntry) {
  const directory = cacheDirectory(dataDir, bookId);
  await mkdir(directory, { recursive: true });
  // The cover that an import stored lives in the same folder, so the folder
  // is not emptied here; only the manifest decides what is served.
  const previous = await readManifest(dataDir, bookId);
  const manifest = {
    imageStamp: stamp,
    coverStamp: previous?.coverStamp,
    images: [],
    cover: previous?.cover ?? null,
  };
  for (let index = 0; index < images.length; index += 1) {
    const image = images[index];
    let data;
    try {
      data = image.data ?? readEntry(image);
    } catch {
      data = undefined;
    }
    if (data === undefined) {
      manifest.images.push(null);
      continue;
    }
    const extension = /\.[a-z0-9]+$/i.exec(image.path)?.[0].slice(1).toLowerCase() ?? 'bin';
    const type = MIME_TYPES[extension] ?? 'application/octet-stream';
    const file = `${index}.${extension}`;
    await writeFile(join(directory, file), data);
    manifest.images.push({ file, type });
  }
  await writeFile(join(directory, MANIFEST_NAME), `${JSON.stringify(manifest)}\n`, 'utf8');
  return manifest;
}

/**
 * Store one book's cover image in its cache folder.
 *
 * @param {string|undefined} dataDir - the configured data directory.
 * @param {string} bookId - the book's identity.
 * @param {string} stamp - the value that marks this extraction as current.
 * @param {{ data: Buffer, type: string }|undefined} cover - the cover image.
 * @returns {Promise<void>} resolves once the cover is stored.
 */
export async function writeCoverCache(dataDir, bookId, stamp, cover) {
  const directory = cacheDirectory(dataDir, bookId);
  await mkdir(directory, { recursive: true });
  const manifest = await readManifest(dataDir, bookId);
  const next = {
    imageStamp: manifest?.imageStamp,
    coverStamp: stamp,
    images: manifest?.images ?? [],
    cover: null,
  };
  if (cover !== undefined) {
    const extension = cover.type === 'image/png' ? 'png' : cover.type === 'image/webp' ? 'webp' : 'jpg';
    const file = `cover.${extension}`;
    await writeFile(join(directory, file), cover.data);
    next.cover = { file, type: cover.type };
  }
  await writeFile(join(directory, MANIFEST_NAME), `${JSON.stringify(next)}\n`, 'utf8');
}

/**
 * Read one book's cache manifest.
 *
 * A manifest written before the images and the cover carried their own
 * version is read as if its cover were current, so a shelf keeps its covers
 * across the upgrade.
 * @param {string|undefined} dataDir - the configured data directory.
 * @param {string} bookId - the book's identity.
 * @returns {Promise<{imageStamp: string|undefined, coverStamp: string|undefined, images: object[], cover: object|null}|undefined>} the manifest.
 */
export async function readManifest(dataDir, bookId) {
  try {
    const raw = await readFile(join(cacheDirectory(dataDir, bookId), MANIFEST_NAME), 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.images)) return undefined;
    return {
      imageStamp: parsed.imageStamp,
      coverStamp: parsed.coverStamp ?? parsed.stamp,
      images: parsed.images,
      cover: parsed.cover ?? null,
    };
  } catch {
    return undefined;
  }
}

/**
 * Read one cached image.
 * @param {string|undefined} dataDir - the configured data directory.
 * @param {string} bookId - the book's identity.
 * @param {number} index - the image index.
 * @returns {Promise<{ data: Buffer, type: string }|undefined>} the image, when it is cached.
 */
export async function readCachedImage(dataDir, bookId, index) {
  const manifest = await readManifest(dataDir, bookId);
  const entry = manifest?.images?.[index];
  if (entry === undefined || entry === null) return undefined;
  try {
    const data = await readFile(join(cacheDirectory(dataDir, bookId), entry.file));
    return { data, type: entry.type };
  } catch {
    return undefined;
  }
}

/**
 * Read one cached cover image.
 * @param {string|undefined} dataDir - the configured data directory.
 * @param {string} bookId - the book's identity.
 * @returns {Promise<{ data: Buffer, type: string }|undefined>} the cover, when it is cached.
 */
export async function readCachedCover(dataDir, bookId) {
  const manifest = await readManifest(dataDir, bookId);
  const entry = manifest?.cover;
  if (entry === undefined || entry === null) return undefined;
  try {
    const data = await readFile(join(cacheDirectory(dataDir, bookId), entry.file));
    return { data, type: entry.type };
  } catch {
    return undefined;
  }
}

/**
 * The version a cached cover belongs to.
 * @param {string|undefined} dataDir - the configured data directory.
 * @param {string} bookId - the book's identity.
 * @returns {Promise<string|undefined>} the cover's version stamp.
 */
export async function readCoverStamp(dataDir, bookId) {
  const manifest = await readManifest(dataDir, bookId);
  return manifest?.coverStamp;
}

/** Media types of the image files the cache stores, by extension. */
const MIME_TYPES = {
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
