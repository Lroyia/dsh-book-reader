/**
 * Word document (.docx) reading.
 *
 * A .docx is a ZIP whose `word/document.xml` holds the text and whose
 * `word/media/` holds the pictures. This reader walks the document body in
 * order, keeps the paragraph styles that mark headings, and resolves the
 * images a paragraph points at through the document's relationship file.
 *
 * The legacy binary `.doc` format is a different container entirely and is
 * not read here.
 */
import { readZipEntries, resolveArchivePath } from './zip.js';
import { IMAGE_MIME_TYPES, decodeEntities } from './epub.js';

/** The document part that holds the body text. */
const DOCUMENT_PART = 'word/document.xml';
/** The document's relationship file. */
const RELATIONSHIP_PART = 'word/_rels/document.xml.rels';
/** The package properties part, which carries the title and the author. */
const CORE_PART = 'docProps/core.xml';

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
 * The text of an XML element.
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
 * The style of a Word paragraph, which tells headings from body text.
 * @param {string} paragraph - the paragraph source.
 * @returns {string} the style identifier.
 */
function styleOf(paragraph) {
  const match = /<w:pStyle\b[^>]*\bw:val\s*=\s*("([^"]*)"|'([^']*)')/i.exec(paragraph);
  return match === null ? '' : (match[2] ?? match[3] ?? '');
}

/**
 * Whether a paragraph style marks a heading.
 * @param {string} style - the style identifier.
 * @returns {number} the heading level, or 0 for a body paragraph.
 */
function headingLevelOf(style) {
  if (style === '') return 0;
  if (/^heading\s*[1-9]$/i.test(style)) return Number(style.replace(/\D/g, ''));
  if (/^[1-9]$/.test(style)) return Number(style);
  if (/^berschrift[1-9]$/i.test(style)) return Number(style.replace(/\D/g, ''));
  return 0;
}

/**
 * The relationship table of the document.
 * @param {Map<string, Buffer>} entries - the archive entries.
 * @returns {Map<string, string>} the relationship id to archive path map.
 */
function readRelationships(entries) {
  const source = entries.get(RELATIONSHIP_PART);
  const relations = new Map();
  if (source === undefined) return relations;
  const xml = source.toString('utf8');
  for (const tag of xml.match(/<Relationship\b[^>]*>/gi) ?? []) {
    const id = attribute(tag, 'Id');
    const target = attribute(tag, 'Target');
    if (id === undefined || target === undefined) continue;
    if (/^https?:/i.test(target)) continue;
    relations.set(id, resolveArchivePath('word/document.xml', target.replace(/^\.\//, '')));
  }
  return relations;
}

/**
 * The images a paragraph points at.
 * @param {string} paragraph - the paragraph source.
 * @param {Map<string, string>} relations - the relationship table.
 * @returns {{ id: string, alt: string }[]} the image references.
 */
function imagesOf(paragraph, relations) {
  const found = [];
  for (const tag of paragraph.match(/<(?:a:)?blip\b[^>]*>|<v:imagedata\b[^>]*>/gi) ?? []) {
    const id = attribute(tag, 'r:embed') ?? attribute(tag, 'r:id');
    if (id === undefined) continue;
    const target = relations.get(id);
    if (target === undefined) continue;
    const alt = /<wp:docPr\b[^>]*\bdescr\s*=\s*("([^"]*)"|'([^']*)')/i.exec(paragraph);
    found.push({ id: target, alt: alt === null ? '' : (alt[2] ?? alt[3] ?? '') });
  }
  return found;
}

/**
 * The text of a paragraph, with its tabs and line breaks.
 * @param {string} paragraph - the paragraph source.
 * @returns {string} the text.
 */
function textOfParagraph(paragraph) {
  let text = '';
  const body = paragraph.replace(/<w:pPr\b[\s\S]*?<\/w:pPr>/i, '');
  for (const tag of body.match(/<w:t\b[^>]*>[\s\S]*?<\/w:t>|<w:tab\s*\/>|<w:br\b[^>]*\/?>|<w:cr\b[^>]*\/?>/gi) ?? []) {
    if (/^<w:t\b/i.test(tag)) {
      const inner = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/i.exec(tag);
      text += inner === null ? '' : decodeEntities(inner[1]);
      continue;
    }
    if (/^<w:tab/i.test(tag)) {
      text += '\t';
      continue;
    }
    text += '\n';
  }
  return text.replace(/[ \t]+\n/g, '\n').trim();
}

/**
 * Split a document body into chapters.
 *
 * A heading starts a chapter; a document without headings is cut into even
 * chapters so the reader always has somewhere to jump to.
 * @param {{ level: number, text: string, images: object[] }[]} paragraphs - the body paragraphs.
 * @returns {{ title: string, blocks: object[] }[]} the chapters.
 */
function toChapters(paragraphs) {
  const chapters = [];
  let current = null;
  for (const paragraph of paragraphs) {
    if (paragraph.level > 0 && paragraph.text !== '') {
      if (current !== null) chapters.push(current);
      current = { title: paragraph.text, blocks: [] };
      continue;
    }
    if (current === null) current = { title: '正文', blocks: [] };
    for (const image of paragraph.images) current.blocks.push(image);
    if (paragraph.text !== '') current.blocks.push({ t: 'p', text: paragraph.text });
  }
  if (current !== null) chapters.push(current);
  if (chapters.length === 0) return [{ title: '正文', blocks: [] }];
  return chapters;
}

/**
 * Read a Word document.
 * @param {Buffer} buffer - the file bytes.
 * @returns {{ title: string, author: string|undefined, chapters: { title: string, blocks: object[] }[], images: { path: string, alt: string }[], warnings: string[] }} the parsed document.
 * @throws when the file is not a readable .docx container.
 */
export function parseDocx(buffer) {
  const { entries, warnings } = readZipEntries(buffer);
  const document = entries.get(DOCUMENT_PART);
  if (document === undefined) {
    throw new Error('not a word document: word/document.xml is missing');
  }
  const relations = readRelationships(entries);
  const core = entries.get(CORE_PART);
  const coreXml = core === undefined ? '' : core.toString('utf8');
  const title = textOfTag(coreXml, 'dc:title');
  const author = textOfTag(coreXml, 'dc:creator');

  const xml = document.toString('utf8');
  const bodyMatch = /<w:body\b[^>]*>([\s\S]*?)<\/w:body>/i.exec(xml);
  const body = bodyMatch === null ? xml : bodyMatch[1];

  const images = [];
  const imageIndex = new Map();
  const paragraphs = [];
  for (const match of body.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/gi)) {
    const source = match[0];
    const references = imagesOf(source, relations);
    const paragraphImages = [];
    for (const reference of references) {
      const extension = /\.([a-z0-9]+)$/i.exec(reference.id)?.[1].toLowerCase() ?? '';
      if (IMAGE_MIME_TYPES[extension] === undefined) continue;
      let index = imageIndex.get(reference.id);
      if (index === undefined) {
        index = images.length;
        const data = entries.get(reference.id);
        images.push({ path: reference.id, alt: reference.alt, data });
        imageIndex.set(reference.id, index);
      }
      paragraphImages.push({ t: 'img', index, alt: reference.alt });
    }
    paragraphs.push({
      level: headingLevelOf(styleOf(source)),
      text: textOfParagraph(source),
      images: paragraphImages,
    });
  }

  return {
    title: title ?? '',
    author,
    chapters: toChapters(paragraphs),
    images,
    warnings,
  };
}
