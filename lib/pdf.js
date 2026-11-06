/**
 * PDF reading.
 *
 * A PDF is a file format built from numbered objects, and a reader that wants
 * its text has to walk that structure: find the pages, decode their content
 * streams, and turn the text-showing operators into characters. This reader
 * does that without any third-party dependency.
 *
 * It reads the text layer — a PDF made of scanned pictures has no text to
 * read, and the caller is told so rather than being handed an empty book.
 *
 * The objects are found by scanning the file for `N G obj` rather than by
 * following the cross-reference table: a damaged table then costs nothing,
 * and the scan is a single pass over the bytes.
 */
import { deflateSync, inflateSync, inflateRawSync } from 'node:zlib';

/** The signature every PNG file starts with. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** The filters that hold an image's own encoding rather than compressing it. */
const IMAGE_CODECS = new Set(['/DCTDecode', '/JPXDecode', '/CCITTFaxDecode', '/JBIG2Decode']);

/** Bytes of whitespace inside a PDF file. */
const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
/** Bytes that end a PDF token. */
const DELIMITERS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20, 0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

/**
 * Whether a byte is PDF whitespace.
 * @param {number|undefined} byte - the byte.
 * @returns {boolean} true for whitespace.
 */
function isWhitespace(byte) {
  return byte !== undefined && WHITESPACE.has(byte);
}

/**
 * Whether a byte is a decimal digit.
 * @param {number|undefined} byte - the byte.
 * @returns {boolean} true for a digit.
 */
function isDigit(byte) {
  return byte !== undefined && byte >= 0x30 && byte <= 0x39;
}

/**
 * A parsed PDF value.
 *
 * Names are strings that start with a slash, strings are byte buffers, and
 * references are `{ref: number}` objects, so every value keeps its kind.
 */

/**
 * A small lexer over PDF syntax.
 */
class Lexer {
  /**
   * @param {string} text - the text to read.
   */
  constructor(text) {
    this.text = text;
    this.pos = 0;
  }

  /**
   * Skip whitespace and comments.
   */
  skip() {
    while (this.pos < this.text.length) {
      const byte = this.text.charCodeAt(this.pos);
      if (isWhitespace(byte)) {
        this.pos += 1;
        continue;
      }
      if (byte === 0x25) {
        while (this.pos < this.text.length && this.text.charCodeAt(this.pos) !== 0x0a && this.text.charCodeAt(this.pos) !== 0x0d) {
          this.pos += 1;
        }
        continue;
      }
      break;
    }
  }

  /**
   * Read the next value.
   * @returns {unknown} the value.
   */
  value() {
    this.skip();
    const char = this.text[this.pos];
    if (char === undefined) return undefined;
    if (char === '<' && this.text[this.pos + 1] === '<') return this.dictionary();
    if (char === '<') return this.hexString();
    if (char === '(') return this.literalString();
    if (char === '[') return this.array();
    if (char === '/') return this.name();
    return this.keyword();
  }

  /**
   * Read a dictionary.
   * @returns {Record<string, unknown>} the dictionary.
   */
  dictionary() {
    const result = {};
    this.pos += 2;
    for (;;) {
      this.skip();
      if (this.pos >= this.text.length) break;
      if (this.text.startsWith('>>', this.pos)) {
        this.pos += 2;
        break;
      }
      const key = this.name();
      if (key === undefined) break;
      const value = this.value();
      result[key.slice(1)] = value;
    }
    return result;
  }

  /**
   * Read an array.
   * @returns {unknown[]} the array.
   */
  array() {
    const result = [];
    this.pos += 1;
    for (;;) {
      this.skip();
      if (this.pos >= this.text.length) break;
      if (this.text[this.pos] === ']') {
        this.pos += 1;
        break;
      }
      const value = this.value();
      if (value === undefined) break;
      result.push(value);
    }
    return result;
  }

  /**
   * Read a name.
   * @returns {string|undefined} the name, with its leading slash.
   */
  name() {
    if (this.text[this.pos] !== '/') return undefined;
    this.pos += 1;
    let out = '';
    while (this.pos < this.text.length) {
      const byte = this.text.charCodeAt(this.pos);
      if (isWhitespace(byte) || DELIMITERS.has(byte)) break;
      if (byte === 0x23 && this.pos + 2 < this.text.length) {
        out += String.fromCharCode(parseInt(this.text.substr(this.pos + 1, 2), 16));
        this.pos += 3;
        continue;
      }
      out += this.text[this.pos];
      this.pos += 1;
    }
    return `/${out}`;
  }

  /**
   * Read a literal string.
   * @returns {Buffer} the string's bytes.
   */
  literalString() {
    this.pos += 1;
    const bytes = [];
    let depth = 1;
    while (this.pos < this.text.length) {
      const char = this.text[this.pos];
      this.pos += 1;
      if (char === '\\') {
        const escape = this.text[this.pos];
        this.pos += 1;
        switch (escape) {
          case 'n': bytes.push(0x0a); break;
          case 'r': bytes.push(0x0d); break;
          case 't': bytes.push(0x09); break;
          case 'b': bytes.push(0x08); break;
          case 'f': bytes.push(0x0c); break;
          case '(': bytes.push(0x28); break;
          case ')': bytes.push(0x29); break;
          case '\\': bytes.push(0x5c); break;
          case '\r':
            if (this.text[this.pos] === '\n') this.pos += 1;
            break;
          case '\n': break;
          default: {
            if (escape >= '0' && escape <= '7') {
              let octal = escape;
              while (octal.length < 3 && this.text[this.pos] >= '0' && this.text[this.pos] <= '7') {
                octal += this.text[this.pos];
                this.pos += 1;
              }
              bytes.push(parseInt(octal, 8) & 0xff);
            } else {
              bytes.push(this.text.charCodeAt(this.pos - 1) & 0xff);
            }
          }
        }
        continue;
      }
      if (char === '(') depth += 1;
      if (char === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
      bytes.push(this.text.charCodeAt(this.pos - 1) & 0xff);
    }
    return Buffer.from(bytes);
  }

  /**
   * Read a hexadecimal string.
   * @returns {Buffer} the string's bytes.
   */
  hexString() {
    this.pos += 1;
    let hex = '';
    while (this.pos < this.text.length && this.text[this.pos] !== '>') {
      const char = this.text[this.pos];
      if (/[0-9a-fA-F]/.test(char)) hex += char;
      this.pos += 1;
    }
    this.pos += 1;
    if (hex.length % 2 === 1) hex += '0';
    return Buffer.from(hex, 'hex');
  }

  /**
   * Read a number, a keyword, or a reference.
   * @returns {unknown} the value.
   */
  keyword() {
    const start = this.pos;
    while (this.pos < this.text.length) {
      const byte = this.text.charCodeAt(this.pos);
      if (isWhitespace(byte) || DELIMITERS.has(byte)) break;
      this.pos += 1;
    }
    const token = this.text.slice(start, this.pos);
    if (token === '') {
      this.pos += 1;
      return undefined;
    }
    if (/^[+-]?[0-9]*\.?[0-9]+$/.test(token)) {
      // A reference looks like `12 0 R`; the generator is already consumed
      // when the next token is read.
      const save = this.pos;
      this.skip();
      const genStart = this.pos;
      while (this.pos < this.text.length && isDigit(this.text.charCodeAt(this.pos))) this.pos += 1;
      const generation = this.text.slice(genStart, this.pos);
      if (generation !== '' && /^\d+$/.test(generation)) {
        this.skip();
        if (this.text[this.pos] === 'R' && (this.pos + 1 >= this.text.length || isWhitespace(this.text.charCodeAt(this.pos + 1)) || DELIMITERS.has(this.text.charCodeAt(this.pos + 1)))) {
          this.pos += 1;
          return { ref: Number(token) };
        }
      }
      this.pos = save;
      return Number(token);
    }
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'null') return null;
    return token;
  }
}

/**
 * Decode a PDF text string into a JavaScript string.
 *
 * A string that starts with a UTF-16 byte order mark holds UTF-16 code
 * units; everything else is read as bytes.
 * @param {Buffer|undefined} bytes - the string's bytes.
 * @returns {string} the text.
 */
export function decodePdfString(bytes) {
  if (bytes === undefined) return '';
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    // The copy matters: swapping in place would change the file's own bytes
    // and garble every second reading of the same string.
    const body = Buffer.from(bytes.subarray(2));
    body.swap16();
    return body.toString('utf16le');
  }
  return bytes.toString('latin1');
}

/**
 * The files of a PDF, indexed by object number.
 *
 * @param {Buffer} buffer - the file bytes.
 * @returns {Map<number, {dict: Record<string, unknown>, streamStart: number, streamEnd: number, end: number}>} the objects.
 */
function scanObjects(buffer) {
  const objects = new Map();
  let position = 0;
  for (;;) {
    const at = buffer.indexOf('obj', position);
    if (at < 0) break;
    position = at + 3;
    let cursor = at - 1;
    while (cursor >= 0 && isWhitespace(buffer[cursor])) cursor -= 1;
    const generationEnd = cursor + 1;
    while (cursor >= 0 && isDigit(buffer[cursor])) cursor -= 1;
    const generationStart = cursor + 1;
    if (generationStart >= generationEnd) continue;
    cursor = generationStart - 1;
    while (cursor >= 0 && isWhitespace(buffer[cursor])) cursor -= 1;
    const numberEnd = cursor + 1;
    while (cursor >= 0 && isDigit(buffer[cursor])) cursor -= 1;
    const numberStart = cursor + 1;
    if (numberStart >= numberEnd) continue;
    const number = Number(buffer.toString('latin1', numberStart, numberEnd));
    if (!Number.isFinite(number)) continue;

    const bodyStart = at + 3;
    // The `stream` keyword follows the dictionary right away, so the search
    // is bounded: an unbounded one would read the rest of the file for every
    // object that has no stream.
    const objectEnd = buffer.indexOf('endobj', bodyStart);
    const limit = objectEnd < 0 ? buffer.length : objectEnd;
    const head = buffer.subarray(bodyStart, Math.min(limit, bodyStart + 65536));
    let streamOffset = head.indexOf('stream');
    while (streamOffset >= 0) {
      // `endstream` ends the previous object and is not a keyword of this one.
      const endsPrevious = streamOffset >= 3 && head[streamOffset - 1] === 0x64 && head[streamOffset - 2] === 0x6e && head[streamOffset - 3] === 0x65;
      if (!endsPrevious) break;
      streamOffset = head.indexOf('stream', streamOffset + 6);
    }
    if (streamOffset >= 0) {
      const streamAt = bodyStart + streamOffset;
      const dictText = buffer.toString('latin1', bodyStart, streamAt);
      const lexer = new Lexer(dictText);
      const dict = lexer.value();
      let dataStart = streamAt + 'stream'.length;
      if (buffer[dataStart] === 0x0d) dataStart += 1;
      if (buffer[dataStart] === 0x0a) dataStart += 1;
      let dataEnd = buffer.indexOf('endstream', dataStart);
      if (dataEnd < 0) dataEnd = buffer.length;
      const end = buffer.indexOf('endobj', dataEnd);
      objects.set(number, {
        dict: typeof dict === 'object' && dict !== null ? dict : {},
        streamStart: dataStart,
        streamEnd: dataEnd,
        end: end < 0 ? buffer.length : end,
      });
      position = dataEnd + 9;
      continue;
    }
    if (objectEnd < 0) break;
    const dictText = buffer.toString('latin1', bodyStart, objectEnd);
    const lexer = new Lexer(dictText);
    const dict = lexer.value();
    objects.set(number, {
      dict: typeof dict === 'object' && dict !== null ? dict : {},
      streamStart: -1,
      streamEnd: -1,
      end: objectEnd,
    });
    position = objectEnd + 6;
  }
  return objects;
}

/**
 * Follow a reference to its object.
 * @param {unknown} value - the value.
 * @param {Map<number, object>} objects - the file's objects.
 * @returns {object|undefined} the object record.
 */
function resolve(value, objects) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (typeof value.ref !== 'number') return undefined;
  return objects.get(value.ref);
}

/**
 * Follow a reference to its dictionary.
 *
 * A dictionary may be written inline instead of being referenced, so both
 * forms are accepted.
 * @param {unknown} value - the value.
 * @param {Map<number, object>} objects - the file's objects.
 * @returns {Record<string, unknown>|undefined} the dictionary.
 */
function dictOf(value, objects) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (typeof value.ref === 'number') {
    const record = objects.get(value.ref);
    return record === undefined ? undefined : record.dict;
  }
  return value;
}

/**
 * The filters of a stream, as a list of names.
 * @param {Record<string, unknown>} dict - the stream's dictionary.
 * @returns {string[]} the filter names.
 */
function filtersOf(dict) {
  const filter = dict.Filter;
  if (typeof filter === 'string') return [filter];
  if (Array.isArray(filter)) return filter.filter((item) => typeof item === 'string');
  return [];
}

/**
 * Decode a stream's bytes.
 * @param {Buffer} raw - the stream's bytes.
 * @param {string[]} filters - the stream's filters.
 * @returns {Buffer|undefined} the decoded bytes, when they could be decoded.
 */
function applyFilters(raw, filters) {
  let data = raw;
  for (const filter of filters) {
    if (filter === '/FlateDecode' || filter === '/Fl') {
      try {
        data = inflateSync(data);
      } catch {
        try {
          data = inflateRawSync(data);
        } catch {
          return undefined;
        }
      }
      continue;
    }
    if (filter === '/ASCIIHexDecode' || filter === '/AHx') {
      const hex = data.toString('latin1').replace(/[^0-9a-fA-F]/g, '');
      data = Buffer.from(hex.length % 2 === 0 ? hex : `${hex}0`, 'hex');
      continue;
    }
    if (filter === '/DCTDecode' || filter === '/JPXDecode' || filter === '/CCITTFaxDecode' || filter === '/JBIG2Decode') {
      // An image, not text.
      return undefined;
    }
    if (filter === '/LZWDecode' || filter === '/ASCII85Decode' || filter === '/RunLengthDecode') {
      return undefined;
    }
  }
  return data;
}

/**
 * Read a stream's decoded bytes.
 * @param {object} object - the object.
 * @param {Map<number, object>} objects - the file's objects.
 * @param {Buffer} buffer - the file bytes.
 * @returns {Buffer|undefined} the decoded bytes.
 */
function streamBytes(object, objects, buffer) {
  if (object.streamStart < 0) return undefined;
  const raw = buffer.subarray(object.streamStart, object.streamEnd);
  return applyFilters(raw, filtersOf(object.dict));
}

/**
 * The character map of a font, read from its ToUnicode CMap.
 * @param {object} font - the font object.
 * @param {Map<number, object>} objects - the file's objects.
 * @param {Buffer} buffer - the file bytes.
 * @returns {{map: Map<string, string>, codeLength: number}|undefined} the character map.
 */
function readCharacterMap(font, objects, buffer) {
  const toUnicode = resolve(font.dict.ToUnicode, objects);
  if (toUnicode === undefined) return undefined;
  const bytes = streamBytes(toUnicode, objects, buffer);
  if (bytes === undefined) return undefined;
  const text = bytes.toString('latin1');
  const map = new Map();
  let codeLength = 1;
  for (const range of text.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/gi)) {
    const hex = /<([0-9a-fA-F]+)>/.exec(range[1]);
    if (hex !== null) codeLength = Math.max(1, Math.floor(hex[1].length / 2));
  }
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/gi)) {
    for (const pair of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      map.set(pair[1].toLowerCase(), hexToText(pair[2]));
    }
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/gi)) {
    for (const range of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([\s\S]*?)\])/g)) {
      const low = Number.parseInt(range[1], 16);
      const high = Number.parseInt(range[2], 16);
      const width = range[1].length;
      if (high - low > 65535) continue;
      if (range[3] !== undefined) {
        const base = Number.parseInt(range[3], 16);
        for (let code = low; code <= high; code += 1) {
          map.set(code.toString(16).padStart(width, '0').toLowerCase(), hexToText((base + (code - low)).toString(16)));
        }
        continue;
      }
      const items = [...(range[4] ?? '').matchAll(/<([0-9a-fA-F]+)>/g)].map((item) => hexToText(item[1]));
      let index = 0;
      for (let code = low; code <= high; code += 1, index += 1) {
        const value = items[index];
        if (value !== undefined) map.set(code.toString(16).padStart(width, '0').toLowerCase(), value);
      }
    }
  }
  return { map, codeLength };
}

/**
 * Decode a hexadecimal Unicode destination.
 * @param {string} hex - the destination's hex digits.
 * @returns {string} the text.
 */
function hexToText(hex) {
  let out = '';
  for (let index = 0; index + 3 < hex.length; index += 4) {
    out += String.fromCharCode(Number.parseInt(hex.substr(index, 4), 16));
  }
  if (hex.length % 4 !== 0 && hex.length >= 2) {
    out += String.fromCharCode(Number.parseInt(hex.substr(hex.length - 2, 2), 16));
  }
  return out;
}

/**
 * Decode the bytes a text-showing operator carries.
 *
 * The glyph widths come along for the ride: they tell how far the text
 * reaches on the page, which is what tells a paragraph from a wrapped line.
 * @param {Buffer} bytes - the bytes.
 * @param {{cmap: object|undefined, metrics: object|undefined}} font - the font.
 * @param {number} spacing - the character spacing in force.
 * @returns {{text: string, em: number}} the text and its width in em.
 */
function decodeShownText(bytes, font, spacing) {
  const cmap = font?.cmap;
  const metrics = font?.metrics;
  const codeLength = cmap?.codeLength ?? (metrics?.composite === true ? 2 : 1);
  let text = '';
  let em = 0;
  let characters = 0;
  for (let index = 0; index < bytes.length; index += codeLength) {
    const chunk = bytes.subarray(index, index + codeLength);
    const hex = chunk.toString('hex');
    const mapped = cmap?.map.get(hex);
    if (mapped !== undefined) {
      text += mapped;
    } else {
      text += chunk.subarray(0, 1).toString('latin1');
    }
    characters += 1;
    if (metrics !== undefined) {
      const code = codeLength === 1 ? chunk[0] : chunk.readUInt16BE(0);
      em += widthOfCode(metrics, code) / 1000;
    }
  }
  if (spacing !== 0 && characters > 1) em += (spacing * (characters - 1)) / 1000;
  return { text, em };
}

/**
 * Whether a character is one of the wide ones, which Chinese text is made of.
 * @param {string|undefined} character - the character.
 * @returns {boolean} true for a wide character.
 */
function isWideCharacter(character) {
  if (character === undefined) return false;
  const code = character.codePointAt(0) ?? 0;
  return (
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0x3000 && code <= 0x303f)
  );
}

/**
 * The first character of the next string in a text array.
 * @param {unknown[]} array - the array.
 * @param {number} index - the index to look at.
 * @param {object|undefined} font - the font.
 * @returns {string|undefined} the character.
 */
function peekText(array, index, font) {
  const item = array[index];
  if (!Buffer.isBuffer(item)) return undefined;
  const text = decodeShownText(item, font, 0).text;
  return text.length === 0 ? undefined : text[0];
}

/**
 * Multiply two transformation matrices.
 * @param {number[]} left - the left matrix.
 * @param {number[]} right - the right matrix.
 * @returns {number[]} the product.
 */
function multiplyMatrix(left, right) {
  return [
    left[0] * right[0] + left[1] * right[2],
    left[0] * right[1] + left[1] * right[3],
    left[2] * right[0] + left[3] * right[2],
    left[2] * right[1] + left[3] * right[3],
    left[4] * right[0] + left[5] * right[2] + right[4],
    left[4] * right[1] + left[5] * right[3] + right[5],
  ];
}

/**
 * The text of one page and the places its pictures are drawn.
 * @param {string} content - the decoded content stream.
 * @param {Map<string, {cmap: object|undefined, metrics: object|undefined}>} fonts - the page's fonts.
 * @param {Map<string, {index: number, alt: string}>} images - the page's pictures, by resource name.
 * @returns {{runs: object[], placements: object[]}} the text runs and the pictures.
 */
function extractPageContent(content, fonts, images) {
  const lexer = new Lexer(content);
  const runs = [];
  const placements = [];
  let font = undefined;
  let size = 12;
  let spacing = 0;
  let x = 0;
  let y = 0;
  let matrix = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const saved = [];

  /**
   * Record a piece of text with the width it takes.
   * @param {Buffer} bytes - the text's bytes.
   */
  const show = (bytes) => {
    const decoded = decodeShownText(bytes, font, spacing);
    if (decoded.text === '') return;
    runs.push({ x, y, size, advance: decoded.em * size, text: decoded.text });
  };

  for (;;) {
    lexer.skip();
    if (lexer.pos >= content.length) break;
    const char = content[lexer.pos];
    if (char === '(' || char === '<' || char === '[' || char === '/') {
      // A value: read it and remember it for the operator that follows.
      const value = lexer.value();
      stack.push(value);
      continue;
    }
    if (/[0-9+\-.]/.test(char)) {
      stack.push(lexer.value());
      continue;
    }
    // An operator.
    const operator = lexer.keyword();
    switch (operator) {
      case 'Tf': {
        // The operands are pushed in order, so the size comes off first.
        const sizeValue = stack.pop();
        const name = stack.pop();
        size = Number(sizeValue) || size;
        font = typeof name === 'string' && name.startsWith('/') ? fonts.get(name) : undefined;
        break;
      }
      case 'Tc': {
        spacing = Number(stack.pop()) || 0;
        break;
      }
      case 'Td': {
        const ty = Number(stack.pop()) || 0;
        const tx = Number(stack.pop()) || 0;
        x += tx;
        y += ty;
        break;
      }
      case 'TD': {
        const ty = Number(stack.pop()) || 0;
        const tx = Number(stack.pop()) || 0;
        x += tx;
        y += ty;
        break;
      }
      case 'Tm': {
        const f = Number(stack.pop()) || 0;
        const e = Number(stack.pop()) || 0;
        x = e;
        y = f;
        break;
      }
      case 'BT': {
        x = 0;
        y = 0;
        break;
      }
      case 'q': {
        saved.push(matrix.slice());
        break;
      }
      case 'Q': {
        const previous = saved.pop();
        if (previous !== undefined) matrix = previous;
        break;
      }
      case 'cm': {
        const f = Number(stack.pop()) || 0;
        const e = Number(stack.pop()) || 0;
        const d = Number(stack.pop()) || 0;
        const c = Number(stack.pop()) || 0;
        const b = Number(stack.pop()) || 0;
        const a = Number(stack.pop()) || 0;
        matrix = multiplyMatrix([a, b, c, d, e, f], matrix);
        break;
      }
      case 'Do': {
        const name = stack.pop();
        if (typeof name === 'string' && images.has(name)) {
          const image = images.get(name);
          placements.push({
            index: image.index,
            alt: image.alt,
            x: matrix[4],
            y: matrix[5] + Math.abs(matrix[3]),
            width: Math.abs(matrix[0]),
            height: Math.abs(matrix[3]),
          });
        }
        break;
      }
      case 'Tj': {
        const value = stack.pop();
        if (Buffer.isBuffer(value)) show(value);
        break;
      }
      case 'TJ': {
        const array = stack.pop();
        if (Array.isArray(array)) {
          let text = '';
          let em = 0;
          for (let index = 0; index < array.length; index += 1) {
            const item = array[index];
            if (Buffer.isBuffer(item)) {
              const decoded = decodeShownText(item, font, spacing);
              text += decoded.text;
              em += decoded.em;
              continue;
            }
            if (typeof item !== 'number' || item > -180) continue;
            // A wide gap between two Chinese characters is letter spacing,
            // not a word space; a gap next to Latin text still is one.
            const before = text[text.length - 1];
            const after = peekText(array, index + 1, font);
            if (before === undefined || after === undefined) continue;
            if (isWideCharacter(before) && isWideCharacter(after)) continue;
            text += ' ';
          }
          if (text !== '') {
            runs.push({ x, y, size, advance: em * size, text });
          }
        }
        break;
      }
      case "'": {
        const value = stack.pop();
        if (Buffer.isBuffer(value)) show(value);
        break;
      }
      case '"': {
        const value = stack.pop();
        if (Buffer.isBuffer(value)) show(value);
        break;
      }
      default:
        break;
    }
    stack.length = 0;
  }
  return { runs, placements };
}

/**
 * Assemble text runs into paragraphs, with the pictures among them.
 *
 * A page's text is a list of runs that each carry their own position. The
 * runs are first gathered into lines, and the lines into paragraphs: a line
 * that starts at the left margin after a line that did not fill the width
 * begins a new paragraph, while a line that continues a full one is joined
 * to it. A picture stands where it is drawn.
 * @param {{x: number, y: number, size: number, text: string}[]} runs - the text runs.
 * @param {{index: number, alt: string, y: number}[]} placements - the pictures.
 * @returns {object[]} the paragraphs and pictures.
 */
function runsToParagraphs(runs, placements = []) {
  const textLines = [];
  for (const run of runs) {
    if (run.text.trim() === '') continue;
    const last = textLines[textLines.length - 1];
    if (last !== undefined && Math.abs(run.y - last.y) <= 0.6) {
      last.items.push(run);
      continue;
    }
    textLines.push({ y: run.y, items: [run] });
  }
  if (textLines.length === 0 && placements.length === 0) return [];

  const texts = textLines.map((line) => {
    line.items.sort((a, b) => a.x - b.x);
    let text = '';
    let end = 0;
    for (const item of line.items) {
      const before = text[text.length - 1];
      const after = item.text[0];
      const advance = item.advance > 0 ? item.advance : textWidth(item.text, item.size);
      // A gap between two Chinese characters is letter spacing, not a word
      // space; a gap next to Latin text still is one.
      if (text !== '' && item.x - end > item.size * 0.3 && !text.endsWith(' ') && !(isWideCharacter(before) && isWideCharacter(after))) {
        text += ' ';
      }
      text += item.text;
      end = item.x + advance;
    }
    return { y: line.y, x: line.items[0].x, end, text: text.trim() };
  });

  let left = 0;
  let right = 0;
  let tolerance = 12;
  let spacing = 12;
  if (texts.length > 0) {
    left = Math.min(...texts.map((line) => line.x));
    const ends = texts.map((line) => line.end).sort((a, b) => a - b);
    // The width of the text column: the lines that fill it end in about the
    // same place, so the place most lines end at is the margin. A page whose
    // lines are mostly short falls back to a high share of the widest ones.
    const buckets = new Map();
    for (const end of ends) {
      const key = Math.round(end / 5) * 5;
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
    let most = 0;
    for (const [key, count] of buckets) {
      if (count > most || (count === most && key > right)) {
        most = count;
        right = key;
      }
    }
    const widest = ends[ends.length - 1];
    if (right < widest * 0.6) right = ends[Math.floor(ends.length * 0.9)] ?? widest;
    const sizes = texts.map((line) => line.size).sort((a, b) => a - b);
    const size = sizes[Math.floor(sizes.length / 2)] ?? 12;
    tolerance = Math.max(8, size * 1.5);
    const gaps = [];
    for (let index = 1; index < texts.length; index += 1) {
      const gap = Math.abs(texts[index - 1].y - texts[index].y);
      if (gap > 0.6) gaps.push(gap);
    }
    gaps.sort((a, b) => a - b);
    spacing = gaps[Math.floor(gaps.length / 2)] ?? 12;
  }

  const events = [
    ...texts.map((line) => ({ y: line.y, line })),
    ...placements.map((placement) => ({ y: placement.y, picture: placement })),
  ];
  events.sort((a, b) => b.y - a.y);

  const blocks = [];
  let current = '';
  let previous;
  for (const event of events) {
    if (event.picture !== undefined) {
      if (current !== '') {
        blocks.push({ t: 'p', text: current });
        current = '';
      }
      blocks.push({ t: 'img', index: event.picture.index, alt: event.picture.alt });
      previous = undefined;
      continue;
    }
    const line = event.line;
    if (current === '') {
      current = line.text;
      previous = line;
      continue;
    }
    const bigGap = previous === undefined || Math.abs(previous.y - line.y) > spacing * 1.7;
    if (bigGap) {
      blocks.push({ t: 'p', text: current });
      blocks.push({ t: 'p', text: '' });
      current = line.text;
      previous = line;
      continue;
    }
    const atMargin = Math.abs(line.x - left) <= 2;
    const indented = line.x > left + 4;
    const previousFull = previous.end >= right - tolerance;
    if (atMargin ? !previousFull : indented) {
      blocks.push({ t: 'p', text: current });
      current = line.text;
      previous = line;
      continue;
    }
    current += line.text;
    previous = line;
  }
  if (current !== '') blocks.push({ t: 'p', text: current });
  return blocks.filter((block, index, all) => {
    if (block.t !== 'p' || block.text !== '') return true;
    const before = all[index - 1];
    return before === undefined || before.t !== 'p' || before.text !== '';
  });
}

/**
 * The page objects of a document, in reading order.
 * @param {object} catalog - the catalog object.
 * @param {Map<number, object>} objects - the file's objects.
 * @returns {object[]} the pages.
 */
function readPages(catalog, objects) {
  const pages = [];
  const seen = new Set();
  const visit = (node) => {
    if (node === undefined || pages.length > 5000) return;
    if (node.dict.Type === '/Page') {
      pages.push(node);
      return;
    }
    const kids = node.dict.Kids;
    if (!Array.isArray(kids)) return;
    for (const kid of kids) {
      const child = resolve(kid, objects);
      if (child === undefined || seen.has(child)) continue;
      seen.add(child);
      visit(child);
    }
  };
  const tree = resolve(catalog.Pages, objects);
  if (tree !== undefined) visit(tree);
  if (pages.length === 0) {
    // Some files have no usable page tree; fall back to the page objects.
    for (const object of objects.values()) {
      if (object.dict.Type === '/Page') pages.push(object);
    }
  }
  return pages;
}

/**
 * The dictionary of a composite font's descendant font.
 *
 * The descendant sits behind two indirections at times: the font names an
 * array, the array names the descendant, and the descendant is where the
 * glyph widths live.
 * @param {object} font - the font object.
 * @param {Map<number, object>} objects - the file's objects.
 * @returns {Record<string, unknown>|undefined} the descendant's dictionary.
 */
function descendantOf(font, objects) {
  let value = font.dict.DescendantFonts;
  for (let depth = 0; depth < 4; depth += 1) {
    const list = Array.isArray(value) ? value : [value];
    if (list.length === 0) return undefined;
    const record = resolve(list[0], objects);
    if (record === undefined) return undefined;
    value = record.dict;
    if (!Array.isArray(value)) return value;
  }
  return undefined;
}

/**
 * The widths a font's glyphs take, in thousandths of an em.
 *
 * A simple font lists one width per code; a composite font keeps them in its
 * descendant, where a range may stand for many glyphs.
 * @param {object} font - the font object.
 * @param {Map<number, object>} objects - the file's objects.
 * @returns {{composite: boolean, first: number, widths: number[], map: Map<number, number>, fallback: number}|undefined} the metrics.
 */
function readFontMetrics(font, objects) {
  const widths = dictOf(font.dict.Widths, objects) ?? font.dict.Widths;
  if (Array.isArray(widths)) {
    return {
      composite: false,
      first: Number(font.dict.FirstChar ?? 0),
      widths: widths.map((width) => Number(width) || 0),
      map: new Map(),
      fallback: 0,
    };
  }
  const descendant = descendantOf(font, objects);
  if (descendant === undefined) return undefined;
  const map = parseWidthArray(dictOf(descendant.W, objects) ?? descendant.W);
  return {
    composite: true,
    first: 0,
    widths: [],
    map,
    fallback: Number(descendant.DW ?? 1000) || 1000,
  };
}

/**
 * Read a font's width array.
 * @param {unknown} value - the array.
 * @returns {Map<number, number>} the width of every code that has one.
 */
function parseWidthArray(value) {
  const map = new Map();
  if (!Array.isArray(value)) return map;
  let index = 0;
  while (index < value.length) {
    const first = Number(value[index]);
    if (!Number.isFinite(first)) {
      index += 1;
      continue;
    }
    const second = value[index + 1];
    if (Array.isArray(second)) {
      second.forEach((width, offset) => map.set(first + offset, Number(width) || 0));
      index += 2;
      continue;
    }
    const last = Number(second);
    const width = Number(value[index + 2]);
    if (Number.isFinite(last) && Number.isFinite(width)) {
      if (last - first < 65536) {
        for (let code = first; code <= last; code += 1) map.set(code, width);
      }
      index += 3;
      continue;
    }
    index += 1;
  }
  return map;
}

/**
 * The width of one glyph.
 * @param {object} metrics - the font's metrics.
 * @param {number} code - the character code.
 * @returns {number} the width in thousandths of an em.
 */
function widthOfCode(metrics, code) {
  if (metrics.composite) return metrics.map.get(code) ?? metrics.fallback;
  const width = metrics.widths[code - metrics.first];
  return width === undefined ? metrics.fallback : width;
}

/**
 * The fonts of a page, by resource name.
 *
 * The character maps are cached per font, not per page: a document usually
 * shares a handful of fonts across hundreds of pages, and reading a font's
 * map again for every page is the difference between seconds and minutes.
 * @param {object} page - the page object.
 * @param {Map<number, object>} objects - the file's objects.
 * @param {Buffer} buffer - the file bytes.
 * @param {Map<object, {cmap: object|undefined, metrics: object|undefined}>} cache - the already read fonts.
 * @returns {Map<string, {cmap: object|undefined, metrics: object|undefined}>} the fonts.
 */
function readFonts(page, objects, buffer, cache) {
  const fonts = new Map();
  const resources = dictOf(page.dict.Resources, objects);
  if (resources === undefined) return fonts;
  const fontDict = dictOf(resources.Font, objects) ?? resources.Font;
  if (typeof fontDict !== 'object' || fontDict === null || Array.isArray(fontDict)) return fonts;
  for (const [name, value] of Object.entries(fontDict)) {
    const font = resolve(value, objects);
    if (font === undefined) continue;
    let entry = cache.get(font);
    if (entry === undefined) {
      entry = { cmap: readCharacterMap(font, objects, buffer), metrics: readFontMetrics(font, objects) };
      cache.set(font, entry);
    }
    fonts.set(`/${name}`, entry);
  }
  return fonts;
}

/**
 * The pictures a page can draw, by resource name.
 * @param {object} page - the page object.
 * @param {Map<number, object>} objects - the file's objects.
 * @param {Buffer} buffer - the file bytes.
 * @param {Map<object, {index: number, alt: string}>} cache - the pictures already read.
 * @param {object[]} images - the book's picture list, which grows as they are read.
 * @returns {Map<string, {index: number, alt: string}>} the pictures of the page.
 */
function readPageImages(page, objects, buffer, cache, images) {
  const result = new Map();
  const resources = dictOf(page.dict.Resources, objects);
  if (resources === undefined) return result;
  const xobjects = dictOf(resources.XObject, objects);
  if (xobjects === undefined || typeof xobjects !== 'object' || Array.isArray(xobjects)) return result;
  for (const [name, value] of Object.entries(xobjects)) {
    const record = resolve(value, objects);
    if (record === undefined || record.dict.Subtype !== '/Image') continue;
    let entry = cache.get(record);
    if (entry === undefined) {
      const decoded = readImage(record, objects, buffer);
      if (decoded === undefined) continue;
      const extension = decoded.type === 'image/jpeg' ? 'jpg' : 'png';
      entry = { index: images.length, alt: '' };
      images.push({ path: `image-${images.length}.${extension}`, alt: '', data: decoded.data });
      cache.set(record, entry);
    }
    result.set(`/${name}`, entry);
  }
  return result;
}

/**
 * The content of one page: its paragraphs and its pictures.
 * @param {object} page - the page object.
 * @param {Map<number, object>} objects - the file's objects.
 * @param {Buffer} buffer - the file bytes.
 * @param {Map<object, object>} fontCache - the fonts already read.
 * @param {Map<object, object>} imageCache - the pictures already read.
 * @param {object[]} images - the book's picture list.
 * @returns {object[]} the blocks of the page.
 */
function readPage(page, objects, buffer, fontCache, imageCache, images) {
  const contents = page.dict.Contents;
  const streams = [];
  const collect = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) collect(item);
      return;
    }
    const object = resolve(value, objects);
    if (object === undefined) return;
    const bytes = streamBytes(object, objects, buffer);
    if (bytes !== undefined) streams.push(bytes.toString('latin1'));
  };
  collect(contents);
  if (streams.length === 0) return [];
  const fonts = readFonts(page, objects, buffer, fontCache);
  const pageImages = readPageImages(page, objects, buffer, imageCache, images);
  const { runs, placements } = extractPageContent(streams.join('\n'), fonts, pageImages);
  return runsToParagraphs(runs, placements);
}

/**
 * The root of a document's outline.
 *
 * The catalog normally names it; some writers leave the root unreferenced
 * even though they wrote the items, so an unreferenced list of titled items
 * is accepted as well.
 * @param {object} catalog - the catalog object.
 * @param {Map<number, object>} objects - the file's objects.
 * @returns {object|undefined} the outline root.
 */
function findOutlineRoot(catalog, objects) {
  const direct = resolve(catalog.Outlines, objects);
  if (direct !== undefined) return direct;
  for (const object of objects.values()) {
    if (object.dict.First === undefined || object.dict.Last === undefined) continue;
    const item = resolve(object.dict.First, objects);
    if (item === undefined || item.dict.Title === undefined) continue;
    return object;
  }
  return undefined;
}
/**
 * The outline of a document, with the page each entry points at.
 * @param {object} catalog - the catalog object.
 * @param {Map<number, object>} objects - the file's objects.
 * @param {Map<number, number>} pageNumbers - the object number to page index map.
 * @returns {{title: string, page: number}[]} the outline entries.
 */
function readOutline(catalog, objects, pageNumbers) {
  const root = findOutlineRoot(catalog, objects);
  if (root === undefined) return [];
  const entries = [];
  let node = resolve(root.dict.First, objects);
  let guard = 0;
  while (node !== undefined && guard < 2000) {
    guard += 1;
    const dictionary = node.dict;
    let destination = dictionary.Dest;
    if (destination === undefined) {
      const action = dictOf(dictionary.A, objects);
      if (action !== undefined) destination = action.D;
    }
    let page = 0;
    if (Array.isArray(destination)) {
      const target = destination[0];
      const index = typeof target === 'object' && target !== null ? pageNumbers.get(target.ref) : undefined;
      if (index !== undefined) page = index + 1;
    }
    entries.push({ title: decodePdfString(dictionary.Title), page });
    node = resolve(dictionary.Next, objects);
  }
  return entries;
}

/**
 * The chapters of a PDF.
 *
 * A document that carries an outline is cut along its own table of contents;
 * one without an outline is cut page by page, so the reader always has a
 * place to jump to. The pages in front of the first chapter — the cover,
 * the preface and the table of contents — become a chapter of their own.
 * @param {{pages: {number: number, blocks: object[]}[], outline: {title: string, page: number}[]}} parsed - the parsed document.
 * @returns {{ title: string, blocks: object[] }[]} the chapters.
 */
export function pdfChapters(parsed) {
  const chapters = [];
  const entries = parsed.outline.filter((entry) => entry.page >= 1);
  /**
   * The blocks of a range of pages.
   * @param {number} from - the first page.
   * @param {number} to - the page after the last one.
   * @returns {object[]} the blocks.
   */
  const blocksOf = (from, to) => {
    const blocks = [];
    for (let page = from; page < to; page += 1) {
      const content = parsed.pages[page - 1];
      if (content === undefined) continue;
      for (const block of content.blocks) blocks.push(block);
    }
    return blocks;
  };

  if (entries.length > 0) {
    const first = entries[0].page;
    if (first > 1) {
      const blocks = blocksOf(1, first);
      if (blocks.length > 0) chapters.push({ title: '前言与目录', blocks });
    }
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const next = index + 1 < entries.length ? entries[index + 1].page : parsed.pages.length + 1;
      chapters.push({ title: entry.title === '' ? `第 ${index + 1} 节` : entry.title, blocks: blocksOf(entry.page, next) });
    }
    return chapters;
  }
  for (const page of parsed.pages) {
    chapters.push({ title: `第 ${page.number} 页`, blocks: page.blocks });
  }
  return chapters;
}

/**
 * The checksum a PNG chunk carries.
 * @param {Buffer} buffer - the chunk's body.
 * @returns {number} the checksum.
 */
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * One chunk of a PNG file.
 * @param {string} type - the chunk's name.
 * @param {Buffer} data - the chunk's body.
 * @returns {Buffer} the chunk.
 */
function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, checksum]);
}

/**
 * The value of one sample in a packed row.
 * @param {Buffer} row - the packed row.
 * @param {number} x - the sample's place in the row.
 * @param {number} bits - the bits one sample takes.
 * @returns {number} the sample's value.
 */
function readSample(row, x, bits) {
  if (bits === 8) return row[x] ?? 0;
  if (bits === 16) return ((row[x * 2] ?? 0) << 8) | (row[x * 2 + 1] ?? 0);
  const perByte = 8 / bits;
  const byte = row[Math.floor(x / perByte)] ?? 0;
  const shift = 8 - bits * ((x % perByte) + 1);
  return (byte >> shift) & ((1 << bits) - 1);
}

/**
 * Write a PNG file.
 * @param {number} width - the image's width in pixels.
 * @param {number} height - the image's height in pixels.
 * @param {number} bits - the bits one sample takes.
 * @param {number} colorType - the PNG colour type.
 * @param {Buffer} samples - the packed samples.
 * @param {number} channels - the samples one pixel takes.
 * @param {Buffer|undefined} palette - the colour table of an indexed image.
 * @returns {Buffer} the file.
 */
function encodePng(width, height, bits, colorType, samples, channels, palette) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = bits;
  header[9] = colorType;
  const stride = Math.ceil((width * channels * bits) / 8);
  const raw = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row += 1) {
    raw[row * (stride + 1)] = 0;
    samples.copy(raw, row * (stride + 1) + 1, row * stride, Math.min(samples.length, (row + 1) * stride));
  }
  const parts = [PNG_SIGNATURE, pngChunk('IHDR', header)];
  if (palette !== undefined) parts.push(pngChunk('PLTE', palette));
  parts.push(pngChunk('IDAT', deflateSync(raw)));
  parts.push(pngChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

/**
 * The colour space an image's samples are in.
 * @param {unknown} value - the colour space.
 * @param {Map<number, object>} objects - the file's objects.
 * @param {Buffer} buffer - the file bytes.
 * @returns {{kind: string, palette: Buffer|undefined, base: string}|undefined} the colour space.
 */
function readColorSpace(value, objects, buffer) {
  if (typeof value === 'string') {
    if (value === '/DeviceRGB' || value === '/CalRGB') return { kind: 'rgb', palette: undefined, base: 'rgb' };
    if (value === '/DeviceGray' || value === '/CalGray') return { kind: 'gray', palette: undefined, base: 'gray' };
    if (value === '/DeviceCMYK') return { kind: 'cmyk', palette: undefined, base: 'cmyk' };
    return undefined;
  }
  if (!Array.isArray(value)) return undefined;
  const family = value[0];
  if (family === '/Indexed' || family === '/I') {
    const base = readColorSpace(value[1], objects, buffer);
    let palette = Buffer.isBuffer(value[3]) ? value[3] : undefined;
    if (palette === undefined) {
      const record = resolve(value[3], objects);
      if (record !== undefined) palette = streamBytes(record, objects, buffer);
    }
    return { kind: 'indexed', palette, base: base?.base ?? 'rgb' };
  }
  if (family === '/ICCBased') {
    const record = resolve(value[1], objects);
    const count = Number(record?.dict?.N ?? 3);
    const kind = count === 1 ? 'gray' : count === 4 ? 'cmyk' : 'rgb';
    return { kind, palette: undefined, base: kind };
  }
  if (family === '/CalRGB') return { kind: 'rgb', palette: undefined, base: 'rgb' };
  if (family === '/CalGray') return { kind: 'gray', palette: undefined, base: 'gray' };
  if (family === '/DeviceN') {
    const names = resolve(value[1], objects)?.dict?.Names;
    const count = Array.isArray(names) ? names.length : 1;
    const kind = count === 1 ? 'gray' : count === 4 ? 'cmyk' : 'rgb';
    return { kind, palette: undefined, base: kind };
  }
  if (family === '/Separation') return { kind: 'gray', palette: undefined, base: 'gray' };
  return undefined;
}

/**
 * The raw samples of an image, without any alpha.
 * @param {object} xobject - the image object.
 * @param {Map<number, object>} objects - the file's objects.
 * @param {Buffer} buffer - the file bytes.
 * @returns {Buffer|undefined} the samples.
 */
function readImageSamples(xobject, objects, buffer) {
  const filters = filtersOf(xobject.dict);
  let data = buffer.subarray(xobject.streamStart, xobject.streamEnd);
  for (const filter of filters) {
    if (IMAGE_CODECS.has(filter)) return undefined;
    if (filter === '/FlateDecode' || filter === '/Fl') {
      try {
        data = inflateSync(data);
      } catch {
        try {
          data = inflateRawSync(data);
        } catch {
          return undefined;
        }
      }
      continue;
    }
    return undefined;
  }
  return data;
}

/**
 * Read an image's pixels.
 *
 * A JPEG is handed over as it is; every other encoding is turned into a PNG
 * so that a browser can show it.
 * @param {object} xobject - the image object.
 * @param {Map<number, object>} objects - the file's objects.
 * @param {Buffer} buffer - the file bytes.
 * @returns {{data: Buffer, type: string}|undefined} the image.
 */
function readImage(xobject, objects, buffer) {
  const dict = xobject.dict;
  const width = Number(dict.Width);
  const height = Number(dict.Height);
  const bits = Number(dict.BitsPerComponent ?? 8);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined;
  if (width > 20000 || height > 20000) return undefined;

  const filters = filtersOf(dict);
  const codec = filters.find((filter) => IMAGE_CODECS.has(filter));
  let data = buffer.subarray(xobject.streamStart, xobject.streamEnd);
  for (const filter of filters) {
    if (IMAGE_CODECS.has(filter)) continue;
    if (filter === '/FlateDecode' || filter === '/Fl') {
      try {
        data = inflateSync(data);
      } catch {
        try {
          data = inflateRawSync(data);
        } catch {
          return undefined;
        }
      }
      continue;
    }
    if (filter === '/ASCIIHexDecode' || filter === '/AHx') {
      const hex = data.toString('latin1').replace(/[^0-9a-fA-F]/g, '');
      data = Buffer.from(hex.length % 2 === 0 ? hex : `${hex}0`, 'hex');
      continue;
    }
    return undefined;
  }

  if (codec === '/DCTDecode') return { data, type: 'image/jpeg' };
  if (codec !== undefined) return undefined;

  const colorSpace = readColorSpace(dict.ColorSpace, objects, buffer);
  if (colorSpace === undefined) return undefined;
  const channels = colorSpace.kind === 'rgb' ? 3 : colorSpace.kind === 'gray' ? 1 : colorSpace.kind === 'cmyk' ? 4 : 1;
  const stride = Math.ceil((width * channels * bits) / 8);
  if (data.length < stride * height) return undefined;

  // A soft mask holds the alpha channel of the image.
  const maskRecord = resolve(dict.SMask, objects);
  let mask;
  if (maskRecord !== undefined) {
    const maskWidth = Number(maskRecord.dict.Width);
    const maskHeight = Number(maskRecord.dict.Height);
    const maskBits = Number(maskRecord.dict.BitsPerComponent ?? 8);
    const maskData = readImageSamples(maskRecord, objects, buffer);
    if (maskData !== undefined && maskWidth === width && maskHeight === height) {
      mask = { bits: maskBits, samples: maskData };
    }
  }
  const alphaOf = (index) => (mask === undefined ? 255 : mask.bits === 8 ? mask.samples[index] ?? 255 : readSample(mask.samples, index, mask.bits));

  if (colorSpace.kind === 'indexed') {
    const palette = colorSpace.palette;
    if (palette === undefined) return undefined;
    const baseChannels = colorSpace.base === 'gray' ? 1 : colorSpace.base === 'cmyk' ? 4 : 3;
    if (mask === undefined && bits === 8 && baseChannels === 3) {
      return { data: encodePng(width, height, 8, 3, data, 1, palette), type: 'image/png' };
    }
    // A palette with a mask has to be expanded into colours.
    const out = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = readSample(data.subarray(y * stride, (y + 1) * stride), x, bits);
        const base = index * baseChannels;
        const at = (y * width + x) * 4;
        out[at] = palette[base] ?? 0;
        out[at + 1] = palette[base + 1] ?? 0;
        out[at + 2] = palette[base + 2] ?? 0;
        out[at + 3] = alphaOf(y * width + x);
      }
    }
    return { data: encodePng(width, height, 8, 6, out, 4, undefined), type: 'image/png' };
  }

  if (mask !== undefined) {
    // A grey or colour image with a mask becomes fully transparent.
    const out = Buffer.alloc(width * height * 4);
    for (let index = 0; index < width * height; index += 1) {
      const at = index * 4;
      if (channels === 1) {
        out[at] = out[at + 1] = out[at + 2] = data[index] ?? 0;
      } else {
        out[at] = data[index * 3] ?? 0;
        out[at + 1] = data[index * 3 + 1] ?? 0;
        out[at + 2] = data[index * 3 + 2] ?? 0;
      }
      out[at + 3] = alphaOf(index);
    }
    return { data: encodePng(width, height, 8, 6, out, 4, undefined), type: 'image/png' };
  }

  if (colorSpace.kind === 'cmyk') {
    const out = Buffer.alloc(width * height * 3);
    for (let index = 0; index < width * height; index += 1) {
      const c = data[index * 4] ?? 0;
      const m = data[index * 4 + 1] ?? 0;
      const y = data[index * 4 + 2] ?? 0;
      const k = data[index * 4 + 3] ?? 0;
      out[index * 3] = Math.round(((255 - c) * (255 - k)) / 255);
      out[index * 3 + 1] = Math.round(((255 - m) * (255 - k)) / 255);
      out[index * 3 + 2] = Math.round(((255 - y) * (255 - k)) / 255);
    }
    return { data: encodePng(width, height, 8, 2, out, 3, undefined), type: 'image/png' };
  }

  const colorType = colorSpace.kind === 'gray' ? 0 : 2;
  return { data: encodePng(width, height, bits, colorType, data, channels, undefined), type: 'image/png' };
}

/**
 * Read a PDF file.
 * @param {Buffer} buffer - the file bytes.
 * @returns {{title: string, author: string|undefined, pages: {number: number, blocks: object[]}[], outline: {title: string, page: number}[], images: object[], warnings: string[]}} the document.
 */
export function parsePdf(buffer) {
  if (buffer.length < 8 || buffer.toString('latin1', 0, 5) !== '%PDF-') {
    throw new Error('not a pdf file: the header is missing');
  }
  const objects = scanObjects(buffer);
  const warnings = [];
  let catalog;
  for (const object of objects.values()) {
    if (object.dict.Type === '/Catalog') {
      catalog = object;
      break;
    }
  }
  if (catalog === undefined) {
    throw new Error('not a pdf file: no document catalog');
  }

  const pages = readPages(catalog, objects);
  if (pages.length === 0) {
    throw new Error('this pdf file has no pages');
  }

  const numbers = new Map();
  for (const [number, object] of objects) numbers.set(object, number);
  const pageNumbers = new Map();
  pages.forEach((page, index) => {
    const number = numbers.get(page);
    if (number !== undefined) pageNumbers.set(number, index);
  });

  let title;
  let author;
  for (const object of objects.values()) {
    if (object.dict.Title !== undefined && title === undefined) title = decodePdfString(object.dict.Title);
    if (object.dict.Author !== undefined && author === undefined) author = decodePdfString(object.dict.Author);
  }

  const fontCache = new Map();
  const imageCache = new Map();
  const images = [];
  const read = pages.map((page, index) => ({
    number: index + 1,
    blocks: readPage(page, objects, buffer, fontCache, imageCache, images),
  }));
  const outline = readOutline(catalog, objects, pageNumbers);
  return { title: title ?? '', author, pages: read, outline, images, warnings };
}


/** @internal Temporary debugging helper. */
export const __probe = { scanObjects, resolve, dictOf, streamBytes, readFonts };
