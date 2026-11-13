/**
 * The shelf must survive the reader's own traffic.
 *
 * The reader reports its place on every scroll, and the host writes that
 * place to the shelf. These tests cover the three ways a shelf used to lose
 * its books: a save that overlapped another save, a read that caught the
 * shelf while it was being replaced, and a write that stored an empty shelf
 * by mistake.
 *
 * Run with: node --test test/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLibrary, writeLibrary } from '../lib/store.js';

/**
 * Wait until the shelf on disk stops changing.
 *
 * The test must run against the old store code as well, so it cannot use
 * the settle helper the new one offers.
 * @param {string} dir - the shelf directory.
 * @returns {Promise<void>} resolves once the shelf is quiet.
 */
async function settle(dir) {
  let previous = '';
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    let raw = '';
    try {
      raw = await readFile(join(dir, 'library.json'), 'utf8');
    } catch {
      continue;
    }
    if (raw === previous) return;
    previous = raw;
  }
}

/**
 * A shelf with the given number of books.
 * @param {number} count - how many books the shelf holds.
 * @returns {{version: number, books: object[]}} the shelf.
 */
function shelf(count) {
  return {
    version: 1,
    books: Array.from({ length: count }, (_, index) => ({
      id: `book${String(index).padStart(3, '0')}`,
      path: `D:\\books\\book${index}.epub`,
      title: `Book ${index}`,
      kind: 'epub',
      size: 1000 + index,
      progress: { chapter: 0, percent: 0, updatedAt: 0 },
    })),
  };
}

/**
 * A fresh shelf directory.
 * @returns {Promise<{dir: string, cleanup: () => Promise<void>}>} the directory.
 */
async function shelfDir() {
  const dir = await mkdtemp(join(tmpdir(), 'book-reader-test-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('a shelf that holds books is never replaced by an empty one', async () => {
  const { dir, cleanup } = await shelfDir();
  try {
    await writeLibrary(shelf(5), dir);
    await assert.rejects(
      () => writeLibrary({ version: 1, books: [] }, dir),
      /not emptied/,
      'an empty shelf must be refused',
    );
    const document = await readLibrary(dir);
    assert.equal(document.books.length, 5, 'the books must still be there');
  } finally {
    await cleanup();
  }
});

test('taking the last book off the shelf is allowed when it is asked for', async () => {
  const { dir, cleanup } = await shelfDir();
  try {
    await writeLibrary(shelf(1), dir);
    await writeLibrary({ version: 1, books: [] }, dir, { allowEmpty: true });
    const document = await readLibrary(dir);
    assert.equal(document.books.length, 0);
  } finally {
    await cleanup();
  }
});

test('many saves at the same time keep every book', async () => {
  const { dir, cleanup } = await shelfDir();
  try {
    await writeLibrary(shelf(55), dir);
    // Every save is a full read and a full write, exactly as the reader
    // does when it reports its place.
    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        (async () => {
          const document = await readLibrary(dir);
          const books = document.books.map((book) =>
            book.id === 'book000'
              ? { ...book, progress: { chapter: index, percent: index / 40, updatedAt: Date.now() } }
              : book,
          );
          try {
            await writeLibrary({ version: document.version, books }, dir, { backup: false, sync: false });
          } catch {
            // A save that cannot win the race is allowed to fail; it must
            // not take the shelf with it.
          }
        })(),
      ),
    );
    await settle(dir);
    const document = await readLibrary(dir);
    assert.equal(document.books.length, 55, 'no book may be lost');
    assert.ok(document.books.every((book) => typeof book.path === 'string'));
  } finally {
    await cleanup();
  }
});

test('a shelf that cannot be read for a moment is not read as an empty shelf', async () => {
  const { dir, cleanup } = await shelfDir();
  try {
    await writeLibrary(shelf(3), dir);
    // The file is replaced while a reader comes for it: on Windows the
    // file can be missing for a moment during the rename. The read must
    // answer from the copy the process holds, not with an empty shelf.
    const path = join(dir, 'library.json');
    const moved = join(dir, 'library.json.moved');
    await rename(path, moved);
    const document = await readLibrary(dir);
    assert.equal(document.books.length, 3, 'the books must not vanish');
    await rename(moved, path);
  } finally {
    await cleanup();
  }
});

test('the file on disk is readable JSON after every save', async () => {
  const { dir, cleanup } = await shelfDir();
  try {
    await writeLibrary(shelf(20), dir);
    for (let index = 0; index < 20; index += 1) {
      const document = await readLibrary(dir);
      const books = document.books.map((book, position) =>
        position === 0 ? { ...book, progress: { chapter: index, percent: index / 20, updatedAt: Date.now() } } : book,
      );
      await writeLibrary({ version: document.version, books }, dir, { backup: false, sync: false });
    }
    await settle(dir);
    const raw = await readFile(join(dir, 'library.json'), 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.books.length, 20);
    assert.ok(parsed.books.every((book) => typeof book.id === 'string'));
  } finally {
    await cleanup();
  }
});
