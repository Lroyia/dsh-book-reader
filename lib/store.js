/**
 * The local bookshelf: a small JSON document beside the user's other plugin
 * data, holding one record per book (its path, its title, and how far the
 * reader got).
 *
 * The document is the single source of truth for the shelf. It is written
 * atomically (unique temporary file, then rename), so an interrupted write
 * can never leave a half-written shelf behind.
 */
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Schema version of the stored document. */
const DOCUMENT_VERSION = 1;
/** Largest number of books one shelf holds. */
const MAX_BOOKS = 2000;

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
 * Read the shelf document.
 *
 * A missing, unreadable, or malformed document reads as an empty shelf: the
 * plugin then behaves like a fresh install instead of failing to open.
 * @param {string|undefined} override - a configured data directory.
 * @returns {Promise<{ version: number, books: object[] }>} the document.
 */
export async function readLibrary(override) {
  let raw;
  try {
    raw = await readFile(libraryPath(override), 'utf8');
  } catch {
    return emptyDocument();
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyDocument();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return emptyDocument();
  const books = Array.isArray(parsed.books) ? parsed.books : [];
  return {
    version: DOCUMENT_VERSION,
    books: books
      .filter((book) => typeof book === 'object' && book !== null && typeof book.id === 'string' && typeof book.path === 'string')
      .slice(0, MAX_BOOKS),
  };
}

/**
 * Write the shelf document atomically.
 * @param {{ version: number, books: object[] }} document - the document to store.
 * @param {string|undefined} override - a configured data directory.
 * @returns {Promise<void>} resolves once the document is on disk.
 */
export async function writeLibrary(document, override) {
  const target = libraryPath(override);
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    const handle = await open(temporary, 'w');
    try {
      await handle.writeFile(`${JSON.stringify(document, null, 1)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
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
