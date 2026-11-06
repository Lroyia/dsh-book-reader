/**
 * Minimal ZIP container reader.
 *
 * An EPUB file is a ZIP archive, so reading one means reading ZIP. The reader
 * here understands the two storage methods real EPUB writers use (stored and
 * deflate) and reads the central directory, which is the only place that
 * always carries the true entry sizes (a streamed entry defers them to a data
 * descriptor the local header does not have).
 *
 * The directory and the entry data can be read either from one buffer (the
 * whole file in memory) or straight from an open file handle, one positioned
 * read at a time. The second mode matters for books on a network share: the
 * title of a book then costs a few kilobytes instead of the whole archive.
 *
 * `node:zlib` supplies the inflate step, so the archive needs no third-party
 * dependency.
 */
import { inflateRawSync } from 'node:zlib';

/** End-of-central-directory record signature. */
const EOCD_SIGNATURE = 0x06054b50;
/** Central directory file header signature. */
const CENTRAL_SIGNATURE = 0x02014b50;
/** Local file header signature. */
const LOCAL_SIGNATURE = 0x04034b50;
/** The 32-bit escape value that defers a size or offset to the ZIP64 record. */
const ZIP64_MARKER = 0xffffffff;
/** Size of the end-of-central-directory record itself. */
const EOCD_SIZE = 22;
/** Largest trailing comment a ZIP archive may carry. */
const MAX_COMMENT = 0xffff;
/** ZIP64 extra field header id. */
const ZIP64_EXTRA_ID = 0x0001;

/**
 * One archive entry, as the central directory describes it.
 * @typedef {object} ZipEntry
 * @property {string} name - the slash-separated archive path.
 * @property {number} method - the storage method (0 stored, 8 deflate).
 * @property {number} compressedSize - the stored size in bytes.
 * @property {number} uncompressedSize - the original size in bytes.
 * @property {number} localOffset - the offset of the entry's local header.
 */

/**
 * Locate the end-of-central-directory record.
 *
 * The record sits at the very end of the archive unless a comment follows it,
 * so the search scans backwards over at most the comment length. The returned
 * offset is relative to the buffer that was searched.
 * @param {Buffer} buffer - the archive bytes.
 * @returns {number} the record's offset, or -1 when it is absent.
 */
export function findEndOfCentralDirectory(buffer) {
  const last = buffer.length - EOCD_SIZE;
  if (last < 0) return -1;
  const first = Math.max(0, last - MAX_COMMENT);
  for (let offset = last; offset >= first; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

/**
 * Read the ZIP64 sizes an entry deferred.
 *
 * A ZIP64 entry stores the values it could not fit in the 32-bit fields inside
 * an extra field, in a fixed order, and only for the fields that overflowed.
 * @param {Buffer} extra - the central directory extra field.
 * @param {{ uncompressed: {value: number}|null, compressed: {value: number}|null, offset: {value: number}|null }} needs - the fields to fill.
 */
function applyZip64Extra(extra, needs) {
  let cursor = 0;
  while (cursor + 4 <= extra.length) {
    const id = extra.readUInt16LE(cursor);
    const size = extra.readUInt16LE(cursor + 2);
    if (cursor + 4 + size > extra.length) return;
    if (id === ZIP64_EXTRA_ID) {
      const body = extra.subarray(cursor + 4, cursor + 4 + size);
      let read = 0;
      if (needs.uncompressed !== null && read + 8 <= body.length) {
        needs.uncompressed.value = Number(body.readBigUInt64LE(read));
        read += 8;
      }
      if (needs.compressed !== null && read + 8 <= body.length) {
        needs.compressed.value = Number(body.readBigUInt64LE(read));
        read += 8;
      }
      if (needs.offset !== null && read + 8 <= body.length) {
        needs.offset.value = Number(body.readBigUInt64LE(read));
        read += 8;
      }
      return;
    }
    cursor += 4 + size;
  }
}

/**
 * Parse a central directory.
 *
 * The buffer must start exactly at the central directory: the offsets it
 * carries are absolute in the archive, but every field of the directory
 * itself is relative to its own start.
 * @param {Buffer} buffer - the central directory bytes.
 * @param {number} entryCount - the number of entries the record declares.
 * @returns {{ entries: Map<string, ZipEntry>, warnings: string[] }} the entries and the notes about what was skipped.
 */
export function parseZipDirectory(buffer, entryCount) {
  const entries = new Map();
  const warnings = [];
  let cursor = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buffer.length) {
      warnings.push('truncated central directory');
      break;
    }
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      warnings.push('bad central directory entry');
      break;
    }
    const method = buffer.readUInt16LE(cursor + 10);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const headerStart = cursor;
    const nameStart = headerStart + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > buffer.length) {
      warnings.push('truncated entry name');
      break;
    }
    const rawName = buffer.toString('utf8', nameStart, nameEnd);
    const extra = buffer.subarray(nameEnd, nameEnd + extraLength);
    cursor = nameEnd + extraLength + commentLength;

    const uncompressed = { value: buffer.readUInt32LE(headerStart + 24) };
    const compressed = { value: buffer.readUInt32LE(headerStart + 20) };
    const localOffset = { value: buffer.readUInt32LE(headerStart + 42) };
    if (uncompressed.value === ZIP64_MARKER || compressed.value === ZIP64_MARKER || localOffset.value === ZIP64_MARKER) {
      applyZip64Extra(extra, { uncompressed, compressed, offset: localOffset });
    }
    // A few writers store the separator as a backslash; the archive paths
    // this reader resolves are always slash-separated.
    const name = rawName.replace(/\\/g, '/');
    entries.set(name, {
      name,
      method,
      compressedSize: compressed.value,
      uncompressedSize: uncompressed.value,
      localOffset: localOffset.value,
    });
  }
  return { entries, warnings };
}

/**
 * Read the central directory of an archive held in memory.
 * @param {Buffer} buffer - the whole archive.
 * @returns {{ entries: Map<string, ZipEntry>, warnings: string[] }} the entries.
 * @throws when the archive is not a readable ZIP container.
 */
export function readZipDirectory(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new Error('not a zip archive: expected a Buffer');
  if (buffer.length < EOCD_SIZE) throw new Error('not a zip archive: too short');
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) throw new Error('not a zip archive: no end-of-central-directory record');
  const total = buffer.readUInt16LE(eocd + 10);
  const directorySize = buffer.readUInt32LE(eocd + 12);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  if (directoryOffset === ZIP64_MARKER || directorySize === ZIP64_MARKER || total === 0xffff) {
    throw new Error('unsupported zip archive: zip64 containers are not supported');
  }
  if (directoryOffset > buffer.length || directoryOffset + directorySize > buffer.length) {
    throw new Error('corrupt zip archive: central directory is out of range');
  }
  return parseZipDirectory(buffer.subarray(directoryOffset, directoryOffset + directorySize), total);
}

/**
 * Read one entry's data from an archive held in memory.
 * @param {Buffer} buffer - the whole archive.
 * @param {ZipEntry} entry - the entry to read.
 * @returns {Buffer} the entry's bytes.
 */
export function readZipEntryData(buffer, entry) {
  if (entry.localOffset + 30 > buffer.length || buffer.readUInt32LE(entry.localOffset) !== LOCAL_SIGNATURE) {
    throw new Error(`corrupt zip archive: bad local header for ${entry.name}`);
  }
  const nameLength = buffer.readUInt16LE(entry.localOffset + 26);
  const extraLength = buffer.readUInt16LE(entry.localOffset + 28);
  const dataStart = entry.localOffset + 30 + nameLength + extraLength;
  const raw = buffer.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(raw);
  return inflateRawSync(raw);
}

/**
 * Read one entry's data straight from an open file.
 *
 * Only the entry's own bytes are read, so a book on a network share costs the
 * size of the part that is actually wanted.
 * @param {import('node:fs/promises').FileHandle} handle - the open file.
 * @param {ZipEntry} entry - the entry to read.
 * @returns {Promise<Buffer>} the entry's bytes.
 */
export async function readZipEntryDataAt(handle, entry) {
  const header = Buffer.alloc(30);
  const headerRead = await handle.read(header, 0, 30, entry.localOffset);
  if (headerRead.bytesRead < 30 || header.readUInt32LE(0) !== LOCAL_SIGNATURE) {
    throw new Error(`corrupt zip archive: bad local header for ${entry.name}`);
  }
  const nameLength = header.readUInt16LE(26);
  const extraLength = header.readUInt16LE(28);
  const dataStart = entry.localOffset + 30 + nameLength + extraLength;
  const raw = Buffer.alloc(entry.compressedSize);
  let read = 0;
  while (read < entry.compressedSize) {
    const chunk = await handle.read(raw, read, entry.compressedSize - read, dataStart + read);
    if (chunk.bytesRead === 0) throw new Error(`corrupt zip archive: truncated data for ${entry.name}`);
    read += chunk.bytesRead;
  }
  if (entry.method === 0) return raw;
  return inflateRawSync(raw);
}

/**
 * Decode every file entry of a ZIP archive held in memory.
 *
 * Directory entries are skipped, encrypted entries are reported instead of
 * being guessed at, and an unknown compression method fails loudly rather
 * than yielding a half-decoded book.
 * @param {Buffer} buffer - the archive bytes.
 * @returns {{ entries: Map<string, Buffer>, warnings: string[] }} the decoded entries and the notes about what was skipped.
 * @throws when the archive is not a readable ZIP container.
 */
export function readZipEntries(buffer) {
  const { entries: directory, warnings } = readZipDirectory(buffer);
  const entries = new Map();
  for (const entry of directory.values()) {
    if (entry.name.endsWith('/')) continue;
    if (entry.method !== 0 && entry.method !== 8) {
      warnings.push(`unsupported compression method ${entry.method}: ${entry.name}`);
      continue;
    }
    try {
      entries.set(entry.name, readZipEntryData(buffer, entry));
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { entries, warnings };
}

/**
 * Resolve an archive-relative path against the directory of a base path.
 *
 * EPUB references are relative to the document that carries them, and they may
 * climb out of their own directory (`../Text/ch1.xhtml`).
 * @param {string} basePath - the path of the referring document.
 * @param {string} relative - the referenced path.
 * @returns {string} the archive path of the reference.
 */
export function resolveArchivePath(basePath, relative) {
  const baseSegments = basePath.split('/').slice(0, -1);
  const segments = [];
  for (const segment of `${relative}`.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      baseSegments.pop();
      continue;
    }
    segments.push(segment);
  }
  return [...baseSegments, ...segments].join('/');
}
