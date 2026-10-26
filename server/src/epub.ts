import {
  BookError,
  classifyIdentifier,
  type BookCover,
  type BookCreator,
  type BookIdentifier,
  type BookMetadata,
} from './metadata.js';
import { elementValues, parseXml, XmlError, type XmlNode } from './xml.js';
import { normalizeZipName, openZip, ZipError, zipPathInside } from './zip.js';

const MIME = 'application/epub+zip';
const MAX_XML = 2 * 1024 * 1024;
const MAX_COVER = 8 * 1024 * 1024;

/**
 * Reads metadata from a recognized EPUB. Zip entries are inflated only after the
 * mimetype entry is `application/epub+zip`. A failed archive does not write files.
 */
export function parseEpub(filePath: string): BookMetadata {
  let zip;
  try {
    zip = openZip(filePath);
  } catch (error) {
    if (error instanceof ZipError) throw new BookError('malformed');
    throw error;
  }
  try {
    const ordered = [...zip.entries].sort((a, b) => a.localHeaderOffset - b.localHeaderOffset);
    const first = ordered[0];
    if (!first || first.name !== 'mimetype') throw new BookError('malformed');
    let mime: string;
    try {
      mime = zip.read('mimetype', 256).toString('utf8');
    } catch (error) {
      if (error instanceof ZipError) throw new BookError('malformed');
      throw error;
    }
    if (mime !== MIME) throw new BookError('malformed');

    const container = readXml(zip, 'META-INF/container.xml');
    const rootfile = findDescendant(container, 'rootfile');
    const opfPath = rootfile?.attrs['full-path'];
    if (!opfPath) throw new BookError('malformed');
    // full-path is relative to the zip root, not to META-INF/container.xml.
    const opfName = normalizeZipName(opfPath);
    if (!opfName) throw new BookError('malformed');
    const opf = readXml(zip, opfName);
    const title = firstValue(opf, 'title');
    const language = firstValue(opf, 'language');
    const creators = readCreators(opf);
    const identifiers = readIdentifiers(opf);
    const cover = readCover(zip, opf, opfName);
    return { title, language, creators, identifiers, cover };
  } catch (error) {
    if (error instanceof BookError) throw error;
    if (error instanceof ZipError || error instanceof XmlError) throw new BookError('malformed');
    throw error;
  } finally {
    zip.close();
  }
}

function readXml(zip: ReturnType<typeof openZip>, name: string): XmlNode {
  const bytes = zip.read(name, MAX_XML);
  return parseXml(bytes.toString('utf8'));
}

function findDescendant(node: XmlNode, name: string): XmlNode | undefined {
  if (node.name === name) return node;
  for (const child of node.children) {
    const found = findDescendant(child, name);
    if (found) return found;
  }
  return undefined;
}

function elements(node: XmlNode, name: string): XmlNode[] {
  const found: XmlNode[] = [];
  const walk = (current: XmlNode) => {
    if (current.name === name) found.push(current);
    for (const child of current.children) walk(child);
  };
  walk(node);
  return found;
}

function firstValue(node: XmlNode, name: string): string | null {
  for (const element of elements(node, name)) {
    const value = elementValues(element)[0];
    if (value) return value;
  }
  return null;
}

function readCreators(opf: XmlNode): BookCreator[] {
  const creators: BookCreator[] = [];
  for (const element of elements(opf, 'creator')) {
    const roleAttr = (element.attrs.role ?? '').toLowerCase();
    const role = roleAttr === 'trl' || roleAttr === 'translator' ? 'translator' : 'author';
    for (const name of elementValues(element)) {
      creators.push({ name, role });
    }
  }
  return creators;
}

function readIdentifiers(opf: XmlNode): BookIdentifier[] {
  const identifiers: BookIdentifier[] = [];
  for (const element of elements(opf, 'identifier')) {
    for (const value of elementValues(element)) {
      identifiers.push(classifyIdentifier(value, element.attrs.scheme));
    }
  }
  return identifiers;
}

function readCover(zip: ReturnType<typeof openZip>, opf: XmlNode, opfName: string): BookCover | null {
  const items = elements(opf, 'item');
  let href: string | null = null;
  const propertyItem = items.find((item) =>
    (item.attrs.properties ?? '').split(/\s+/).includes('cover-image'),
  );
  if (propertyItem?.attrs.href) href = propertyItem.attrs.href;
  if (!href) {
    const meta = elements(opf, 'meta').find((item) => (item.attrs.name ?? '').toLowerCase() === 'cover');
    const id = meta?.attrs.content;
    const match = id ? items.find((item) => item.attrs.id === id) : undefined;
    href = match?.attrs.href ?? null;
  }
  if (!href) return null;
  const name = zipPathInside(opfName, href);
  if (!name) return null;
  let bytes: Buffer;
  try {
    bytes = zip.read(name, MAX_COVER);
  } catch (error) {
    if (error instanceof ZipError) return null;
    throw error;
  }
  const mediaType = sniffImage(bytes);
  if (!mediaType) return null;
  return { bytes, mediaType };
}

export function sniffImage(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes.toString('ascii', 1, 4) === 'PNG') return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && (bytes.toString('ascii', 0, 6) === 'GIF87a' || bytes.toString('ascii', 0, 6) === 'GIF89a')) {
    return 'image/gif';
  }
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}
