/**
 * The local bookshelf: a small JSON document beside the user's other plugin
 * data, holding one record per book (its path, its title, and how far the
 * reader got).
 *
 * The document is the single source of truth for the shelf. It is written
 * atomically (unique temporary file, then rename), so an interrupted write
 * can never leave a half-written shelf behind.
 *
 * The reader saves its position often, and a shelf that is read and written
 * at the same time is a shelf that can lose books. Three rules keep it safe:
 *
 *  - Only one write runs at a time. The writes are chained, so a save never
 *    overlaps another save. On Windows an overlapping rename fails with a
 *    sharing violation, and a file that is read while it is being replaced
 *    can come back as missing for a moment.
 *  - A shelf that holds books is never replaced by an empty one. A file that
 *    is momentarily missing during a replace must not be read as an empty
 *    shelf, and an empty shelf must never be written over a full one.
 *  - A read that cannot see the file falls back to the copy this process
 *    already holds, so the reader's own traffic never empties the shelf.
 */
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Schema version of the stored document. */
const DOCUMENT_VERSION = 1;
/** Largest number of books one shelf holds. */
const MAX_BOOKS = 2000;
/** Counter that keeps every temporary file name of this process unique. */
let temporaryCounter = 0;

/**
 * The shelves this process has loaded, by their file path.
 *
 * The loaded copy is the one the routes work on: a read that cannot reach the
 * file (it is being replaced at that very moment) answers from here instead
 * of reporting an empty shelf.
 * @type {Map<string, {version: number, books: object[]}>}
 */
const loadedShelves = new Map();

/**
 * The chain of writes that have not finished yet.
 *
 * Every write waits for the one before it, so two writes never touch the
 * same file at the same time.
 * @type {Promise<void>}
 */
let writeChain = Promise.resolve();

/**
 * The directory holding the plugin's own data.
 * @param {string|undefined} override - a configured directory, when the user set one.
 * @returns {string} the absolute data directory.
 */
export function dataDirectory(override) {
  if (typeof override === 'string' && override.trim() !== '') return override.trim();
  return join(homedir(), '.dsh-book-reader');
}

/**
 * The path of the shelf document.
 * @param {string|undefined} override - a configured data directory.
 * @returns {string} the absolute file path.
 */
export function libraryPath(override) {
  return join(dataDirectory(override), 'library.json');
}

/**
 * The stable identity of one book file.
 *
 * The identity is derived from the absolute path, so re-importing the same
 * file updates its record instead of adding a second copy.
 * @param {string} path - the absolute file path.
 * @returns {string} the identity.
 */
export function bookId(path) {
  return createHash('sha1').update(path).digest('hex').slice(0, 12);
}

/**
 * A shelf with no books.
 * @returns {{ version: number, books: object[] }} the empty document.
 */
function emptyDocument() {
  return { version: DOCUMENT_VERSION, books: [] };
}

/**
 * Copy one shelf document.
 *
 * The routes hand the document out and then change it, so every caller gets
 * its own copy and nobody can change the loaded shelf by accident.
 * @param {{ version: number, books: object[] }} document - the document to copy.
 * @returns {{ version: number, books: object[] }} the copy.
 */
function copyDocument(document) {
  return {
    version: document.version,
    books: document.books.map((book) => ({
      ...book,
      progress: book.progress === undefined ? undefined : { ...book.progress },
    })),
  };
}

/**
 * Read the shelf document.
 *
 * A missing document reads as an empty shelf, so that a fresh install
 * behaves like an empty one. A document that cannot be read or understood
 * is an error, though: pretending the shelf is empty would let the next
 * write put that emptiness on disk and lose every book on it.
 *
 * When this process has already loaded the shelf, that copy answers the
 * read. A file that is being replaced right now can come back as missing
 * for a moment, and a shelf that read as empty at that moment would be
 * written back as empty.
 * @param {string|undefined} override - a configured data directory.
 * @returns {Promise<{ version: number, books: object[] }>} the document.
 */
export async function readLibrary(override) {
  const path = libraryPath(override);
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
      const loaded = loadedShelves.get(path);
      // The file is missing because it is being replaced, not because the
      // shelf was emptied: answer from the copy this process holds.
      if (loaded !== undefined && loaded.books.length > 0) return copyDocument(loaded);
      return emptyDocument();
    }
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`the bookshelf file cannot be read: ${error.message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('the bookshelf file is not a bookshelf');
  }
  const books = Array.isArray(parsed.books) ? parsed.books : [];
  const document = {
    version: DOCUMENT_VERSION,
    books: books
      .filter((book) => typeof book === 'object' && book !== null && typeof book.id === 'string' && typeof book.path === 'string')
      .slice(0, MAX_BOOKS),
  };
  loadedShelves.set(path, copyDocument(document));
  return document;
}

/**
 * Write the shelf document to disk.
 *
 * The write is atomic: a unique temporary file is written and flushed, and
 * then renamed over the shelf, so a reader never sees half of it.
 * @param {{ version: number, books: object[] }} document - the document to store.
 * @param {string|undefined} override - a configured data directory.
 * @param {{ backup?: boolean, sync?: boolean }} [options] - what the write may cost.
 * @returns {Promise<void>} resolves once the document is on disk.
 */
async function writeLibraryNow(document, override, options) {
  const path = libraryPath(override);
  await mkdir(dirname(path), { recursive: true });
  // The shelf that is there now is kept as a backup, in case the new one
  // turns out to be wrong.
  const previous = options.backup === false ? undefined : await readFile(path, 'utf8').catch(() => undefined);
  // Every temporary file gets its own name. Two saves in the same
  // millisecond must not write into the same file: one of them would
  // truncate what the other had written.
  temporaryCounter += 1;
  const temporary = `${path}.${process.pid}.${Date.now().toString(36)}.${temporaryCounter.toString(36)}.tmp`;
  try {
    const handle = await open(temporary, 'w');
    try {
      await handle.writeFile(`${JSON.stringify(document, null, 1)}\n`, 'utf8');
      // The flush is what makes the rename durable. A reading position is
      // not worth a disk flush on every save, so the caller may leave it out.
      if (options.sync !== false) await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  if (previous !== undefined) {
    await writeFile(`${path}.bak`, previous, 'utf8').catch(() => {});
  }
}

/**
 * Write the shelf document atomically.
 *
 * The writes are chained, so a save never overlaps another save. The loaded
 * copy is updated first, so a read that happens right afterwards sees the
 * new shelf even before the file is on disk.
 *
 * A shelf that holds books is never replaced by an empty one unless the
 * caller says so: an empty shelf written by mistake would take every book
 * off the shelf, and the backup would go with it.
 * @param {{ version: number, books: object[] }} document - the document to store.
 * @param {string|undefined} override - a configured data directory.
 * @param {{ backup?: boolean, sync?: boolean, allowEmpty?: boolean }} [options] - what the write may cost.
 * @returns {Promise<void>} resolves once the document is on disk.
 */
export function writeLibrary(document, override, options = {}) {
  const path = libraryPath(override);
  const run = async () => {
    if (options.allowEmpty !== true) {
      const current = loadedShelves.get(path);
      if (current !== undefined && current.books.length > 0 && document.books.length === 0) {
        throw new Error('the shelf still holds books, so it is not emptied');
      }
    }
    loadedShelves.set(path, copyDocument(document));
    await writeLibraryNow(document, override, options);
  };
  const result = writeChain.then(run, run);
  // The chain itself must not break when a write fails.
  writeChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * Insert or update one book record.
 * @param {{ version: number, books: object[] }} document - the shelf document.
 * @param {object} record - the book record.
 * @returns {{ version: number, books: object[] }} the updated document.
 */
export function upsertBook(document, record) {
  const books = document.books.filter((book) => book.id !== record.id);
  books.unshift(record);
  books.sort((left, right) => (right.addedAt ?? 0) - (left.addedAt ?? 0));
  return { version: DOCUMENT_VERSION, books: books.slice(0, MAX_BOOKS) };
}

/**
 * Merge one freshly scanned book into an existing shelf record.
 *
 * A re-import must not lose what the reader has learned about a book: its
 * reading position and the moment it was last opened are the shelf's own
 * facts, not the file's.
 * @param {object|undefined} existing - the record already on the shelf.
 * @param {object} record - the record read from the file.
 * @returns {object} the merged record.
 */
export function mergeBookRecord(existing, record) {
  if (existing === undefined) return record;
  return {
    ...record,
    addedAt: existing.addedAt ?? record.addedAt,
    lastReadAt: existing.lastReadAt,
    progress: existing.progress ?? record.progress,
    // A freshly extracted cover wins over an older record that had none.
    cover: record.cover === true ? true : (existing.cover ?? record.cover),
  };
}
