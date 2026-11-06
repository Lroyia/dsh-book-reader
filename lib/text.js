/**
 * Plain-text book handling: byte decoding and chapter segmentation.
 *
 * Chinese books are frequently distributed as GB18030 text, and a few
 * files carry a UTF-16 byte order mark, so the decoder probes the encoding
 * instead of assuming UTF-8.
 */

/**
 * A chapter heading line: `第 12 章`, `第一百回`, `Chapter 3`, `楔子`, `番外一`…
 *
 * The pattern is deliberately generous — a heading that is missed only costs
 * the reader a single long chapter, while a false positive would split a
 * paragraph in half.
 */
const CHAPTER_HEADING = /^\s*(?:第\s*[0-9０-９零一二三四五六七八九十百千万两壹贰叁肆伍陆柒捌玖拾佰仟]+\s*[章节節回卷篇集部幕折话話]|Chapter\s+[0-9IVXLCDM]+|chapter\s+[0-9]+|序章|序言|序幕|楔子|引子|前言|后记|後記|尾声|尾聲|终章|終章|番外|外传|外傳|完本感言|完结感言)/i;

/** Longest chapter a heading-less text file is cut into. */
const CHUNK_CHARS = 2600;

/**
 * Decode a text file's bytes.
 *
 * The order is: byte order mark, strict UTF-8, GB18030 (the usual Chinese
 * legacy encoding, a superset of GBK), then UTF-16 without a mark.
 * @param {Buffer} buffer - the file bytes.
 * @returns {{ text: string, encoding: string }} the decoded text and the encoding that produced it.
 */
export function decodeText(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(buffer.subarray(3)), encoding: 'utf-8' };
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(buffer.subarray(2)), encoding: 'utf-16le' };
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(buffer.subarray(2)), encoding: 'utf-16be' };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer), encoding: 'utf-8' };
  } catch {
    // Not valid UTF-8: fall through to the legacy Chinese encoding.
  }
  try {
    return { text: new TextDecoder('gb18030').decode(buffer), encoding: 'gb18030' };
  } catch {
    // The runtime has no gb18030 decoder: fall through to a lossy UTF-8 read.
  }
  const zeros = buffer.subarray(0, Math.min(buffer.length, 4096)).filter((byte) => byte === 0).length;
  if (zeros > buffer.subarray(0, Math.min(buffer.length, 4096)).length / 4) {
    return { text: new TextDecoder('utf-16le').decode(buffer), encoding: 'utf-16le' };
  }
  return { text: new TextDecoder('utf-8').decode(buffer), encoding: 'utf-8' };
}

/**
 * Normalize line endings and collapse runs of blank lines.
 * @param {string} text - the raw text.
 * @returns {string} the normalized text.
 */
export function normalizeText(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n');
}

/**
 * Cut a text into chapters.
 *
 * A file with headings keeps its own structure; a file without one is cut
 * into fixed-size chunks at paragraph boundaries, so the reader always has
 * somewhere to jump to.
 * @param {string} text - the normalized text.
 * @returns {{ title: string, text: string }[]} the chapters.
 */
export function splitChapters(text) {
  const lines = text.split('\n');
  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (CHAPTER_HEADING.test(lines[index])) starts.push(index);
  }
  if (starts.length === 0) return chunkText(text);

  const chapters = [];
  for (let index = 0; index < starts.length; index += 1) {
    const from = starts[index];
    const to = index + 1 < starts.length ? starts[index + 1] : lines.length;
    const title = lines[from].trim();
    const body = lines.slice(from + 1, to).join('\n').trim();
    if (title === '' && body === '') continue;
    chapters.push({ title: title === '' ? `第 ${chapters.length + 1} 节` : title, text: body });
  }
  const leading = lines.slice(0, starts[0]).join('\n').trim();
  if (leading !== '') chapters.unshift({ title: '前言', text: leading });
  return chapters.length > 0 ? chapters : chunkText(text);
}

/**
 * Cut a text into even chunks at paragraph boundaries.
 * @param {string} text - the normalized text.
 * @returns {{ title: string, text: string }[]} the chunks.
 */
function chunkText(text) {
  const paragraphs = text.split(/\n{2,}/).map((part) => part.trim()).filter((part) => part !== '');
  if (paragraphs.length === 0) return [{ title: '正文', text: text.trim() }];
  const chunks = [];
  let current = [];
  let length = 0;
  for (const paragraph of paragraphs) {
    current.push(paragraph);
    length += paragraph.length;
    if (length >= CHUNK_CHARS) {
      chunks.push({ title: `第 ${chunks.length + 1} 节`, text: current.join('\n\n') });
      current = [];
      length = 0;
    }
  }
  if (current.length > 0) chunks.push({ title: `第 ${chunks.length + 1} 节`, text: current.join('\n\n') });
  return chunks;
}

/**
 * Split a chapter's body into paragraphs for rendering.
 * @param {string} text - the chapter body.
 * @returns {string[]} the paragraphs.
 */
export function toParagraphs(text) {
  return text
    .split(/\n{1,}/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * Turn a chapter's body into reader blocks.
 *
 * A plain-text book has no illustrations, so every block is a paragraph; the
 * reader then treats a text book and an EPUB the same way.
 * @param {string} text - the chapter body.
 * @returns {{ t: 'p', text: string }[]} the blocks.
 */
export function toBlocks(text) {
  return toParagraphs(text).map((paragraph) => ({ t: 'p', text: paragraph }));
}
