import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { BookError, classifyIdentifier, type BookCreator, type BookMetadata } from './metadata.js';
import { elementValues, parseXml, XmlError, type XmlNode } from './xml.js';

const MAX_PDF_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_OBJECT_HEAD = 1024 * 1024;
const MAX_METADATA = 2 * 1024 * 1024;

class Truncated extends Error {
  constructor() {
    super('truncated');
    this.name = 'Truncated';
  }
}

type PdfDict = { kind: 'dict'; entries: Map<string, PdfValue>; streamStart: number | null };
type PdfValue =
  | { kind: 'null' }
  | { kind: 'bool'; value: boolean }
  | { kind: 'number'; value: number }
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'ref'; object: number; generation: number }
  | { kind: 'array'; items: PdfValue[] }
  | PdfDict;

/**
 * Reads document info and XMP from a PDF. Page content streams are not indexed.
 * An image-only page stays an image: this does not OCR it.
 */
export function parsePdf(filePath: string): BookMetadata {
  const fd = openSync(filePath, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size < 8 || size > MAX_PDF_BYTES) throw new BookError('malformed');
    const header = readAt(fd, 0, Math.min(size, 16));
    if (!header.toString('latin1', 0, 5).startsWith('%PDF-')) throw new BookError('malformed');
    const xref = readXref(fd, size);
    const root = loadDict(fd, xref.map, xref.root);
    const info = xref.info === null ? null : loadDict(fd, xref.map, xref.info);
    const title = stringOf(info, 'Title') ?? xmpValues(fd, xref.map, root, 'title')[0] ?? null;
    const language = stringOf(root, 'Lang') ?? stringOf(info, 'Lang') ?? xmpValues(fd, xref.map, root, 'language')[0] ?? null;
    const creators = readCreators(info, fd, xref.map, root);
    const identifiers = xmpValues(fd, xref.map, root, 'identifier').map((value) => classifyIdentifier(value));
    const description = xmpValues(fd, xref.map, root, 'description')[0] ?? stringOf(info, 'Subject') ?? null;
    const publisher = xmpValues(fd, xref.map, root, 'publisher')[0] ?? stringOf(info, 'Publisher') ?? null;
    return {
      title,
      language,
      creators,
      identifiers,
      cover: null,
      description,
      publisher,
    };
  } catch (error) {
    if (error instanceof BookError) throw error;
    if (error instanceof Truncated) throw new BookError('malformed');
    throw error;
  } finally {
    closeSync(fd);
  }
}

function readCreators(info: PdfDict | null, fd: number, map: Map<number, number>, root: PdfDict): BookCreator[] {
  const fromXmp = xmpValues(fd, map, root, 'creator');
  if (fromXmp.length > 0) return fromXmp.map((name) => ({ name, role: 'author' as const }));
  const author = stringOf(info, 'Author');
  if (!author) return [];
  return author
    .split(/\s*;\s*/)
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
    .map((name) => ({ name, role: 'author' as const }));
}

function xmpValues(fd: number, map: Map<number, number>, root: PdfDict, tag: string): string[] {
  const metadata = root.entries.get('Metadata');
  if (!metadata || metadata.kind !== 'ref') return [];
  const offset = map.get(metadata.object);
  if (offset === undefined) return [];
  const object = loadObject(fd, offset);
  if (object.kind !== 'dict' || object.streamStart === null) return [];
  const length = streamLength(fd, map, object);
  if (length === null || length > MAX_METADATA) return [];
  const bytes = readAt(fd, offset + object.streamStart, length);
  if (bytes.length !== length) return [];
  let xml: XmlNode;
  try {
    xml = parseXml(bytes.toString('utf8'));
  } catch (error) {
    if (error instanceof XmlError) return [];
    throw error;
  }
  const values: string[] = [];
  for (const node of elementsNamed(xml, tag)) {
    values.push(...elementValues(node));
  }
  return values;
}

function elementsNamed(node: XmlNode, name: string): XmlNode[] {
  const found: XmlNode[] = [];
  const walk = (current: XmlNode) => {
    if (current.name === name) found.push(current);
    for (const child of current.children) walk(child);
  };
  walk(node);
  return found;
}

function stringOf(dict: PdfDict | null, key: string): string | null {
  if (!dict) return null;
  const value = dict.entries.get(key);
  if (!value) return null;
  if (value.kind === 'string' || value.kind === 'name') {
    const trimmed = value.value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

interface XrefTable {
  map: Map<number, number>;
  root: number;
  info: number | null;
}

function readXref(fd: number, size: number): XrefTable {
  const tailLen = Math.min(size, 64 * 1024);
  const tail = readAt(fd, size - tailLen, tailLen);
  const marker = tail.lastIndexOf('startxref');
  if (marker < 0) throw new BookError('malformed');
  const offset = Number.parseInt(tail.toString('latin1', marker + 'startxref'.length).trim(), 10);
  if (!Number.isInteger(offset) || offset < 0 || offset >= size) throw new BookError('malformed');
  const chunk = readAt(fd, offset, Math.min(size - offset, 2 * 1024 * 1024));
  let index = skip(chunk, 0);
  if (chunk.toString('latin1', index, index + 4) !== 'xref') throw new BookError('malformed');
  index += 4;
  const map = new Map<number, number>();
  while (index < chunk.length) {
    index = skip(chunk, index);
    if (chunk.toString('latin1', index, index + 7) === 'trailer') break;
    const line = readLine(chunk, index);
    const parts = line.text.trim().split(/\s+/);
    const start = Number(parts[0]);
    const count = Number(parts[1]);
    if (!Number.isInteger(start) || !Number.isInteger(count) || count < 0 || start < 0) throw new BookError('malformed');
    index = line.next;
    for (let entry = 0; entry < count; entry += 1) {
      const row = readXrefRow(chunk, index);
      if (row.flag === 'n') map.set(start + entry, row.offset);
      index = row.next;
    }
  }
  index = skip(chunk, index);
  if (chunk.toString('latin1', index, index + 7) !== 'trailer') throw new BookError('malformed');
  index += 7;
  const trailer = parseValue(chunk, index).value;
  if (trailer.kind !== 'dict') throw new BookError('malformed');
  const root = trailer.entries.get('Root');
  if (!root || root.kind !== 'ref') throw new BookError('malformed');
  const info = trailer.entries.get('Info');
  return { map, root: root.object, info: info && info.kind === 'ref' ? info.object : null };
}

function loadDict(fd: number, map: Map<number, number>, objectNumber: number): PdfDict {
  const offset = map.get(objectNumber);
  if (offset === undefined) throw new BookError('malformed');
  const value = loadObject(fd, offset);
  if (value.kind !== 'dict') throw new BookError('malformed');
  return value;
}

function loadObject(fd: number, offset: number): PdfValue {
  let window = 8192;
  while (window <= MAX_OBJECT_HEAD) {
    const head = readAt(fd, offset, window);
    try {
      return parseIndirect(head);
    } catch (error) {
      if (error instanceof Truncated && window < MAX_OBJECT_HEAD && head.length === window) {
        window *= 2;
        continue;
      }
      if (error instanceof Truncated) throw new BookError('malformed');
      throw error;
    }
  }
  throw new BookError('malformed');
}

function streamLength(fd: number, map: Map<number, number>, dict: PdfDict): number | null {
  const length = dict.entries.get('Length');
  if (!length) return null;
  if (length.kind === 'number') return length.value;
  if (length.kind !== 'ref') return null;
  const offset = map.get(length.object);
  if (offset === undefined) return null;
  const value = loadObject(fd, offset);
  return value.kind === 'number' ? value.value : null;
}

function parseIndirect(buffer: Buffer): PdfValue {
  let index = skip(buffer, 0);
  const first = parseNumber(buffer, index);
  index = skip(buffer, first.next);
  const second = parseNumber(buffer, index);
  index = skip(buffer, second.next);
  if (buffer.toString('latin1', index, index + 3) !== 'obj') throw new BookError('malformed');
  index += 3;
  return parseValue(buffer, index).value;
}

function parseValue(buffer: Buffer, index: number): { value: PdfValue; next: number } {
  index = skip(buffer, index);
  if (index >= buffer.length) throw new Truncated();
  const byte = buffer[index];
  if (byte === 0x3c && buffer[index + 1] === 0x3c) return parseDict(buffer, index);
  if (byte === 0x5b) return parseArray(buffer, index);
  if (byte === 0x28) return parseLiteral(buffer, index);
  if (byte === 0x3c) return parseHex(buffer, index);
  if (byte === 0x2f) return parseName(buffer, index);
  if (buffer.toString('latin1', index, index + 4) === 'null') return { value: { kind: 'null' }, next: index + 4 };
  if (buffer.toString('latin1', index, index + 4) === 'true') return { value: { kind: 'bool', value: true }, next: index + 4 };
  if (buffer.toString('latin1', index, index + 5) === 'false') return { value: { kind: 'bool', value: false }, next: index + 5 };
  if (byte !== undefined && (byte === 0x2b || byte === 0x2d || byte === 0x2e || (byte >= 0x30 && byte <= 0x39))) {
    return parseNumberOrRef(buffer, index);
  }
  throw new BookError('malformed');
}

function parseDict(buffer: Buffer, index: number): { value: PdfDict; next: number } {
  if (buffer[index] !== 0x3c || buffer[index + 1] !== 0x3c) throw new BookError('malformed');
  index += 2;
  const entries = new Map<string, PdfValue>();
  while (true) {
    index = skip(buffer, index);
    if (index >= buffer.length) throw new Truncated();
    if (buffer[index] === 0x3e && buffer[index + 1] === 0x3e) {
      index += 2;
      break;
    }
    const name = parseName(buffer, index);
    const inner = parseValue(buffer, name.next);
    entries.set(name.value.value, inner.value);
    index = inner.next;
  }
  let streamStart: number | null = null;
  const after = skip(buffer, index);
  if (buffer.toString('latin1', after, after + 6) === 'stream') {
    let dataAt = after + 6;
    if (buffer[dataAt] === 0x0d && buffer[dataAt + 1] === 0x0a) dataAt += 2;
    else if (buffer[dataAt] === 0x0a) dataAt += 1;
    else throw new BookError('malformed');
    streamStart = dataAt;
  }
  return { value: { kind: 'dict', entries, streamStart }, next: index };
}

function parseArray(buffer: Buffer, index: number): { value: PdfValue; next: number } {
  if (buffer[index] !== 0x5b) throw new BookError('malformed');
  index += 1;
  const items: PdfValue[] = [];
  while (true) {
    index = skip(buffer, index);
    if (index >= buffer.length) throw new Truncated();
    if (buffer[index] === 0x5d) return { value: { kind: 'array', items }, next: index + 1 };
    const inner = parseValue(buffer, index);
    items.push(inner.value);
    index = inner.next;
    if (items.length > 10_000) throw new BookError('malformed');
  }
}

function parseLiteral(buffer: Buffer, index: number): { value: PdfValue; next: number } {
  if (buffer[index] !== 0x28) throw new BookError('malformed');
  index += 1;
  const bytes: number[] = [];
  let depth = 1;
  while (index < buffer.length && depth > 0) {
    const byte = buffer[index]!;
    if (byte === 0x5c) {
      const next = buffer[index + 1];
      if (next === undefined) throw new Truncated();
      if (next === 0x6e) bytes.push(0x0a);
      else if (next === 0x72) bytes.push(0x0d);
      else if (next === 0x74) bytes.push(0x09);
      else if (next === 0x62) bytes.push(0x08);
      else if (next === 0x66) bytes.push(0x0c);
      else if (next >= 0x30 && next <= 0x37) {
        let octal = String.fromCharCode(next);
        let consumed = 1;
        while (consumed < 3 && buffer[index + 1 + consumed]! >= 0x30 && buffer[index + 1 + consumed]! <= 0x37) {
          octal += String.fromCharCode(buffer[index + 1 + consumed]!);
          consumed += 1;
        }
        bytes.push(Number.parseInt(octal, 8) & 0xff);
        index += 1 + consumed;
        continue;
      } else if (next === 0x0d) {
        index += buffer[index + 2] === 0x0a ? 3 : 2;
        continue;
      } else if (next === 0x0a) {
        index += 2;
        continue;
      } else bytes.push(next);
      index += 2;
      continue;
    }
    if (byte === 0x28) depth += 1;
    if (byte === 0x29) {
      depth -= 1;
      if (depth === 0) {
        index += 1;
        break;
      }
    }
    bytes.push(byte);
    index += 1;
  }
  if (depth !== 0) throw new Truncated();
  return { value: { kind: 'string', value: decodePdfBytes(Buffer.from(bytes)) }, next: index };
}

function parseHex(buffer: Buffer, index: number): { value: PdfValue; next: number } {
  if (buffer[index] !== 0x3c) throw new BookError('malformed');
  index += 1;
  let hex = '';
  while (index < buffer.length && buffer[index] !== 0x3e) {
    const byte = buffer[index]!;
    if (byte > 32) hex += String.fromCharCode(byte);
    index += 1;
  }
  if (buffer[index] !== 0x3e) throw new Truncated();
  if (hex.length % 2 === 1) hex += '0';
  if (!/^[0-9A-Fa-f]*$/.test(hex)) throw new BookError('malformed');
  return { value: { kind: 'string', value: decodePdfBytes(Buffer.from(hex, 'hex')) }, next: index + 1 };
}

function parseName(buffer: Buffer, index: number): { value: { kind: 'name'; value: string }; next: number } {
  if (buffer[index] !== 0x2f) throw new BookError('malformed');
  index += 1;
  let name = '';
  while (index < buffer.length) {
    const byte = buffer[index]!;
    if (byte <= 32 || byte === 0x2f || byte === 0x28 || byte === 0x29 || byte === 0x3c || byte === 0x3e || byte === 0x5b || byte === 0x5d || byte === 0x7b || byte === 0x7d || byte === 0x25) {
      break;
    }
    if (byte === 0x23) {
      const hex = buffer.toString('latin1', index + 1, index + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) throw new BookError('malformed');
      name += String.fromCharCode(Number.parseInt(hex, 16));
      index += 3;
      continue;
    }
    name += String.fromCharCode(byte);
    index += 1;
  }
  return { value: { kind: 'name', value: name }, next: index };
}

function parseNumberOrRef(buffer: Buffer, index: number): { value: PdfValue; next: number } {
  const first = parseNumber(buffer, index);
  const save = first.next;
  let next = skip(buffer, first.next);
  if (next >= buffer.length) return { value: { kind: 'number', value: first.value }, next: save };
  const byte = buffer[next]!;
  if (!(byte === 0x2b || byte === 0x2d || (byte >= 0x30 && byte <= 0x39))) {
    return { value: { kind: 'number', value: first.value }, next: save };
  }
  const second = parseNumber(buffer, next);
  next = skip(buffer, second.next);
  if (buffer[next] === 0x52 && (next + 1 >= buffer.length || isDelimiter(buffer[next + 1]!))) {
    return {
      value: { kind: 'ref', object: first.value, generation: second.value },
      next: next + 1,
    };
  }
  return { value: { kind: 'number', value: first.value }, next: save };
}

function parseNumber(buffer: Buffer, index: number): { value: number; next: number } {
  const start = index;
  if (buffer[index] === 0x2b || buffer[index] === 0x2d) index += 1;
  let sawDigit = false;
  while (index < buffer.length && buffer[index]! >= 0x30 && buffer[index]! <= 0x39) {
    sawDigit = true;
    index += 1;
  }
  if (buffer[index] === 0x2e) {
    index += 1;
    while (index < buffer.length && buffer[index]! >= 0x30 && buffer[index]! <= 0x39) {
      sawDigit = true;
      index += 1;
    }
  }
  if (!sawDigit) throw new BookError('malformed');
  const value = Number(buffer.toString('latin1', start, index));
  if (!Number.isFinite(value)) throw new BookError('malformed');
  return { value, next: index };
}

function skip(buffer: Buffer, index: number): number {
  while (index < buffer.length) {
    const byte = buffer[index]!;
    if (byte === 0x25) {
      while (index < buffer.length && buffer[index] !== 0x0a && buffer[index] !== 0x0d) index += 1;
      continue;
    }
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x0c) {
      index += 1;
      continue;
    }
    break;
  }
  return index;
}

function readLine(buffer: Buffer, index: number): { text: string; next: number } {
  let end = index;
  while (end < buffer.length && buffer[end] !== 0x0a && buffer[end] !== 0x0d) end += 1;
  if (end >= buffer.length) throw new Truncated();
  const text = buffer.toString('latin1', index, end);
  if (buffer[end] === 0x0d && buffer[end + 1] === 0x0a) return { text, next: end + 2 };
  return { text, next: end + 1 };
}

function readXrefRow(buffer: Buffer, index: number): { offset: number; flag: string; next: number } {
  const slice = buffer.toString('latin1', index, Math.min(buffer.length, index + 24));
  const match = /^(\d{10}) (\d{5}) ([nf]) ?(?:\r\n|\n|\r)/.exec(slice);
  if (!match) throw new BookError('malformed');
  return { offset: Number(match[1]), flag: match[3] ?? 'f', next: index + match[0].length };
}

function isDelimiter(byte: number): boolean {
  return byte <= 32 || byte === 0x25 || byte === 0x28 || byte === 0x29 || byte === 0x3c || byte === 0x3e || byte === 0x5b || byte === 0x5d || byte === 0x7b || byte === 0x7d || byte === 0x2f;
}

function decodePdfBytes(bytes: Buffer): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let text = '';
    for (let index = 2; index + 1 < bytes.length; index += 2) {
      const code = bytes.readUInt16BE(index);
      if (code >= 0xd800 && code <= 0xdbff && index + 3 < bytes.length) {
        const next = bytes.readUInt16BE(index + 2);
        text += String.fromCodePoint(0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00));
        index += 2;
      } else {
        text += String.fromCharCode(code);
      }
    }
    return text;
  }
  return bytes.toString('latin1');
}

function readAt(fd: number, position: number, length: number): Buffer {
  if (position < 0 || length < 0) throw new BookError('malformed');
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const read = readSync(fd, buffer, offset, length - offset, position + offset);
    if (read <= 0) break;
    offset += read;
  }
  return offset === length ? buffer : buffer.subarray(0, offset);
}
