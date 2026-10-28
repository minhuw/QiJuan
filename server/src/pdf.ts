import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { BookError, classifyIdentifier, type BookCreator, type BookMetadata } from './metadata.js';
import { elementValues, parseXml, XmlError, type XmlNode } from './xml.js';

const MAX_PDF_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_OBJECT_HEAD = 1024 * 1024;
const MAX_METADATA = 2 * 1024 * 1024;
const MAX_STREAM = 16 * 1024 * 1024;
const MAX_XREF_CHAIN = 64;
const MAX_XREF_ENTRIES = 1_000_000;

class Truncated extends Error {
  constructor() {
    super('truncated');
    this.name = 'Truncated';
  }
}

type PdfDict = { kind: 'dict'; entries: Map<string, PdfValue>; streamStart: number | null };
type XrefEntry =
  | { kind: 'offset'; offset: number }
  | { kind: 'compressed'; container: number; index: number }
  | { kind: 'free' };

interface PdfSource {
  fd: number;
  map: Map<number, XrefEntry>;
  objects: Map<number, PdfValue[]>;
  decoding: Set<number>;
}

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
 * Reads document info and XMP from a PDF. The cross-reference may be a classic
 * table or a stream, and catalog objects may live in an object stream.
 * Page content streams are not indexed. An image-only page stays an image: this does not OCR it.
 */
export function parsePdf(filePath: string): BookMetadata {
  const fd = openSync(filePath, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size < 8 || size > MAX_PDF_BYTES) throw new BookError('malformed');
    const header = readAt(fd, 0, Math.min(size, 16));
    if (!header.toString('latin1', 0, 5).startsWith('%PDF-')) throw new BookError('malformed');
    const xref = readXref(fd, size);
    const source: PdfSource = { fd, map: xref.map, objects: new Map(), decoding: new Set() };
    const root = loadDict(source, xref.root);
    const info = xref.info === null ? null : loadDict(source, xref.info);
    const title = stringOf(info, 'Title') ?? xmpValues(source, root, 'title')[0] ?? null;
    const language = stringOf(root, 'Lang') ?? stringOf(info, 'Lang') ?? xmpValues(source, root, 'language')[0] ?? null;
    const creators = readCreators(info, source, root);
    const identifiers = xmpValues(source, root, 'identifier').map((value) => classifyIdentifier(value));
    const description = xmpValues(source, root, 'description')[0] ?? stringOf(info, 'Subject') ?? null;
    const publisher = xmpValues(source, root, 'publisher')[0] ?? stringOf(info, 'Publisher') ?? null;
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

function readCreators(info: PdfDict | null, source: PdfSource, root: PdfDict): BookCreator[] {
  const fromXmp = xmpValues(source, root, 'creator');
  if (fromXmp.length > 0) return fromXmp.map((name) => ({ name, role: 'author' as const }));
  const author = stringOf(info, 'Author');
  if (!author) return [];
  return author
    .split(/\s*;\s*/)
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
    .map((name) => ({ name, role: 'author' as const }));
}

function xmpValues(source: PdfSource, root: PdfDict, tag: string): string[] {
  const metadata = root.entries.get('Metadata');
  if (!metadata || metadata.kind !== 'ref') return [];
  const entry = source.map.get(metadata.object);
  if (!entry || entry.kind !== 'offset') return [];
  let bytes: Buffer;
  try {
    const object = loadObject(source.fd, entry.offset);
    if (object.kind !== 'dict' || object.streamStart === null) return [];
    bytes = decodeStream(source, object, entry.offset);
  } catch (error) {
    if (error instanceof BookError || error instanceof Truncated) return [];
    throw error;
  }
  if (bytes.length > MAX_METADATA) return [];
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
  map: Map<number, XrefEntry>;
  root: number;
  info: number | null;
}

interface XrefSection {
  root: number | null;
  info: number | null;
  prev: number | null;
  xrefStm: number | null;
}

function readXref(fd: number, size: number): XrefTable {
  const tailLen = Math.min(size, 64 * 1024);
  const tail = readAt(fd, size - tailLen, tailLen);
  const marker = tail.lastIndexOf('startxref');
  if (marker < 0) throw new BookError('malformed');
  const start = Number.parseInt(tail.toString('latin1', marker + 'startxref'.length).trim(), 10);
  if (!Number.isInteger(start) || start < 0 || start >= size) throw new BookError('malformed');
  const map = new Map<number, XrefEntry>();
  const seen = new Set<number>();
  const first = walkXref(fd, size, start, map, seen, true);
  if (first.root === null) throw new BookError('malformed');
  return { map, root: first.root, info: first.info };
}

function walkXref(
  fd: number,
  size: number,
  start: number,
  map: Map<number, XrefEntry>,
  seen: Set<number>,
  captureTrailer: boolean,
): { root: number | null; info: number | null } {
  let root: number | null = null;
  let info: number | null = null;
  let offset: number | null = start;
  let steps = 0;
  let capture = captureTrailer;
  while (offset !== null) {
    if (steps >= MAX_XREF_CHAIN) throw new BookError('malformed');
    if (seen.has(offset)) break;
    seen.add(offset);
    steps += 1;
    const section = readXrefSection(fd, size, offset, map);
    if (capture) {
      root = section.root;
      info = section.info;
      if (root === null) throw new BookError('malformed');
      capture = false;
    }
    if (section.xrefStm !== null && !seen.has(section.xrefStm)) {
      walkXref(fd, size, section.xrefStm, map, seen, false);
    }
    offset = section.prev;
  }
  return { root, info };
}

function readXrefSection(fd: number, size: number, offset: number, map: Map<number, XrefEntry>): XrefSection {
  if (offset < 0 || offset >= size) throw new BookError('malformed');
  const peek = readAt(fd, offset, Math.min(size - offset, 32));
  const index = skip(peek, 0);
  if (peek.toString('latin1', index, index + 4) === 'xref') return readClassicXref(fd, size, offset, map);
  return readXrefStream(fd, size, offset, map);
}

function readClassicXref(fd: number, size: number, offset: number, map: Map<number, XrefEntry>): XrefSection {
  const chunk = readAt(fd, offset, Math.min(size - offset, 2 * 1024 * 1024));
  let index = skip(chunk, 0);
  if (chunk.toString('latin1', index, index + 4) !== 'xref') throw new BookError('malformed');
  index += 4;
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
      putXref(
        map,
        start + entry,
        row.flag === 'n' ? { kind: 'offset', offset: row.offset } : { kind: 'free' },
      );
      index = row.next;
    }
  }
  index = skip(chunk, index);
  if (chunk.toString('latin1', index, index + 7) !== 'trailer') throw new BookError('malformed');
  index += 7;
  const trailer = parseValue(chunk, index).value;
  if (trailer.kind !== 'dict') throw new BookError('malformed');
  return sectionFrom(trailer, size);
}

function readXrefStream(fd: number, size: number, offset: number, map: Map<number, XrefEntry>): XrefSection {
  const value = loadObject(fd, offset);
  if (value.kind !== 'dict' || value.streamStart === null) throw new BookError('malformed');
  const source: PdfSource = { fd, map, objects: new Map(), decoding: new Set() };
  const bytes = decodeStream(source, value, offset);
  const widths = xrefWidths(value);
  const stride = widths[0] + widths[1] + widths[2];
  if (stride <= 0) throw new BookError('malformed');
  const ranges = xrefRanges(value);
  let cursor = 0;
  for (const [start, count] of ranges) {
    if (cursor + count * stride > bytes.length) throw new BookError('malformed');
    for (let entry = 0; entry < count; entry += 1) {
      const row = bytes.subarray(cursor, cursor + stride);
      cursor += stride;
      const type = widths[0] === 0 ? 1 : readBe(row, 0, widths[0]);
      const field2 = readBe(row, widths[0], widths[1]);
      const field3 = widths[2] === 0 ? 0 : readBe(row, widths[0] + widths[1], widths[2]);
      const objectNumber = start + entry;
      if (type === 0) putXref(map, objectNumber, { kind: 'free' });
      else if (type === 1) {
        if (field2 < 0 || field2 >= size) throw new BookError('malformed');
        putXref(map, objectNumber, { kind: 'offset', offset: field2 });
      } else if (type === 2) {
        if (field2 < 1 || field3 < 0) throw new BookError('malformed');
        putXref(map, objectNumber, { kind: 'compressed', container: field2, index: field3 });
      } else throw new BookError('malformed');
    }
  }
  if (cursor !== bytes.length) throw new BookError('malformed');
  return sectionFrom(value, size);
}

function sectionFrom(trailer: PdfDict, size: number): XrefSection {
  return {
    root: refOf(trailer, 'Root'),
    info: refOf(trailer, 'Info'),
    prev: offsetOf(trailer, 'Prev', size),
    xrefStm: offsetOf(trailer, 'XRefStm', size),
  };
}

function xrefWidths(dict: PdfDict): [number, number, number] {
  const widths = dict.entries.get('W');
  if (!widths || widths.kind !== 'array' || widths.items.length !== 3) throw new BookError('malformed');
  const values = widths.items.map((item) => {
    if (item.kind !== 'number' || !Number.isInteger(item.value) || item.value < 0 || item.value > 8) {
      throw new BookError('malformed');
    }
    return item.value;
  });
  return [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0];
}

function xrefRanges(dict: PdfDict): Array<[number, number]> {
  const index = dict.entries.get('Index');
  if (!index) {
    const size = intOf(dict, 'Size');
    if (size === null || size < 0) throw new BookError('malformed');
    return [[0, size]];
  }
  if (index.kind !== 'array' || index.items.length === 0 || index.items.length % 2 !== 0) throw new BookError('malformed');
  const ranges: Array<[number, number]> = [];
  for (let cursor = 0; cursor < index.items.length; cursor += 2) {
    const start = index.items[cursor];
    const count = index.items[cursor + 1];
    if (!start || !count || start.kind !== 'number' || count.kind !== 'number') throw new BookError('malformed');
    if (!Number.isInteger(start.value) || !Number.isInteger(count.value) || start.value < 0 || count.value < 0) {
      throw new BookError('malformed');
    }
    ranges.push([start.value, count.value]);
  }
  return ranges;
}

function putXref(map: Map<number, XrefEntry>, objectNumber: number, entry: XrefEntry): void {
  if (!Number.isInteger(objectNumber) || objectNumber < 0 || objectNumber > 10_000_000) throw new BookError('malformed');
  if (map.has(objectNumber)) return;
  if (map.size >= MAX_XREF_ENTRIES) throw new BookError('malformed');
  map.set(objectNumber, entry);
}

function refOf(dict: PdfDict, key: string): number | null {
  const value = dict.entries.get(key);
  if (!value) return null;
  if (value.kind !== 'ref' || !Number.isInteger(value.object) || value.object < 1) throw new BookError('malformed');
  return value.object;
}

function offsetOf(dict: PdfDict, key: string, size: number): number | null {
  const value = dict.entries.get(key);
  if (!value) return null;
  if (value.kind !== 'number' || !Number.isInteger(value.value) || value.value < 0 || value.value >= size) {
    throw new BookError('malformed');
  }
  return value.value;
}

function intOf(dict: PdfDict, key: string): number | null {
  const value = dict.entries.get(key);
  if (!value || value.kind !== 'number' || !Number.isInteger(value.value)) return null;
  return value.value;
}

function readBe(buffer: Buffer, start: number, width: number): number {
  if (width === 0) return 0;
  let value = 0;
  for (let index = 0; index < width; index += 1) {
    value = value * 256 + (buffer[start + index] ?? 0);
  }
  if (!Number.isSafeInteger(value)) throw new BookError('malformed');
  return value;
}

function loadDict(source: PdfSource, objectNumber: number): PdfDict {
  const value = loadValue(source, objectNumber);
  if (value.kind !== 'dict') throw new BookError('malformed');
  return value;
}

function loadValue(source: PdfSource, objectNumber: number): PdfValue {
  const entry = source.map.get(objectNumber);
  if (!entry || entry.kind === 'free') throw new BookError('malformed');
  if (entry.kind === 'offset') return loadObject(source.fd, entry.offset);
  return loadCompressed(source, entry.container, entry.index);
}

function loadCompressed(source: PdfSource, container: number, index: number): PdfValue {
  let values = source.objects.get(container);
  if (!values) {
    if (source.decoding.has(container)) throw new BookError('malformed');
    source.decoding.add(container);
    try {
      values = decodeObjectStream(source, container);
      source.objects.set(container, values);
    } finally {
      source.decoding.delete(container);
    }
  }
  const value = values[index];
  if (!value) throw new BookError('malformed');
  return value;
}

function decodeObjectStream(source: PdfSource, container: number): PdfValue[] {
  const entry = source.map.get(container);
  if (!entry || entry.kind !== 'offset') throw new BookError('malformed');
  const dict = loadObject(source.fd, entry.offset);
  if (dict.kind !== 'dict' || dict.streamStart === null) throw new BookError('malformed');
  const bytes = decodeStream(source, dict, entry.offset);
  const count = intOf(dict, 'N');
  const first = intOf(dict, 'First');
  if (count === null || first === null || count < 0 || count > 100_000 || first < 0 || first > bytes.length) {
    throw new BookError('malformed');
  }
  const header = bytes.toString('latin1', 0, first).trim().split(/\s+/).filter((part) => part.length > 0);
  if (header.length < count * 2) throw new BookError('malformed');
  const values: PdfValue[] = [];
  for (let index = 0; index < count; index += 1) {
    const at = first + Number(header[index * 2 + 1]);
    if (!Number.isInteger(at) || at < first || at >= bytes.length) throw new BookError('malformed');
    values.push(parseValue(bytes, at).value);
  }
  return values;
}

function decodeStream(source: PdfSource, dict: PdfDict, fileOffset: number): Buffer {
  if (dict.streamStart === null) throw new BookError('malformed');
  const length = streamLength(source, dict);
  if (length === null || length > MAX_STREAM) throw new BookError('malformed');
  const raw = readAt(source.fd, fileOffset + dict.streamStart, length);
  if (raw.length !== length) throw new BookError('malformed');
  return applyFilters(source, dict, raw);
}

function applyFilters(source: PdfSource, dict: PdfDict, data: Buffer): Buffer {
  const names = filterNames(dict);
  let current = data;
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    if (name !== 'FlateDecode' && name !== 'Fl') throw new BookError('malformed');
    try {
      current = inflateSync(current, { maxOutputLength: MAX_STREAM });
    } catch {
      throw new BookError('malformed');
    }
    current = unpredict(current, filterParms(source, dict, index, names.length));
  }
  return current;
}

function filterNames(dict: PdfDict): string[] {
  const filter = dict.entries.get('Filter') ?? dict.entries.get('F');
  if (!filter) return [];
  if (filter.kind === 'name') return [filter.value];
  if (filter.kind !== 'array') throw new BookError('malformed');
  return filter.items.map((item) => {
    if (item.kind !== 'name') throw new BookError('malformed');
    return item.value;
  });
}

function filterParms(source: PdfSource, dict: PdfDict, index: number, count: number): PdfDict | null {
  const raw = dict.entries.get('DecodeParms') ?? dict.entries.get('DP');
  if (!raw || raw.kind === 'null') return null;
  const resolved = raw.kind === 'ref' ? loadValue(source, raw.object) : raw;
  if (resolved.kind === 'dict') return count === 1 ? resolved : null;
  if (resolved.kind !== 'array') throw new BookError('malformed');
  const item = resolved.items[index];
  if (!item || item.kind === 'null') return null;
  if (item.kind === 'dict') return item;
  if (item.kind !== 'ref') throw new BookError('malformed');
  const inner = loadValue(source, item.object);
  if (inner.kind !== 'dict') throw new BookError('malformed');
  return inner;
}

function unpredict(data: Buffer, parms: PdfDict | null): Buffer {
  const predictor = parms ? (intOf(parms, 'Predictor') ?? 1) : 1;
  if (predictor === 1) return data;
  if (predictor < 10 || predictor > 15) throw new BookError('malformed');
  const columns = parms ? (intOf(parms, 'Columns') ?? 1) : 1;
  const colors = parms ? (intOf(parms, 'Colors') ?? 1) : 1;
  const bits = parms ? (intOf(parms, 'BitsPerComponent') ?? 8) : 8;
  if (columns < 1 || colors < 1 || bits < 1 || bits > 16 || columns > 1_000_000) throw new BookError('malformed');
  const sampleBytes = Math.max(1, Math.ceil(bits / 8));
  const rowLength = columns * colors * sampleBytes;
  const stride = rowLength + 1;
  if (rowLength <= 0 || data.length % stride !== 0) throw new BookError('malformed');
  const rows = data.length / stride;
  const out = Buffer.alloc(rows * rowLength);
  let previous = Buffer.alloc(rowLength);
  for (let row = 0; row < rows; row += 1) {
    const tag = data[row * stride] ?? 0;
    const predicted = predictor === 15 ? tag : predictor - 10;
    if (predicted < 0 || predicted > 4) throw new BookError('malformed');
    const raw = data.subarray(row * stride + 1, row * stride + 1 + rowLength);
    const current = Buffer.alloc(rowLength);
    for (let column = 0; column < rowLength; column += 1) {
      const left = column > 0 ? (current[column - 1] ?? 0) : 0;
      const up = previous[column] ?? 0;
      const upLeft = column > 0 ? (previous[column - 1] ?? 0) : 0;
      const sample = raw[column] ?? 0;
      let value = sample;
      if (predicted === 1) value = (sample + left) & 255;
      else if (predicted === 2) value = (sample + up) & 255;
      else if (predicted === 3) value = (sample + Math.floor((left + up) / 2)) & 255;
      else if (predicted === 4) value = (sample + paeth(left, up, upLeft)) & 255;
      current[column] = value;
    }
    current.copy(out, row * rowLength);
    previous = current;
  }
  return out;
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const diagonal = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= diagonal) return left;
  if (upDistance <= diagonal) return up;
  return upLeft;
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

function streamLength(source: PdfSource, dict: PdfDict): number | null {
  const length = dict.entries.get('Length');
  if (!length) return null;
  if (length.kind === 'number' && Number.isInteger(length.value) && length.value >= 0) return length.value;
  if (length.kind !== 'ref') return null;
  const value = loadValue(source, length.object);
  return value.kind === 'number' && Number.isInteger(value.value) && value.value >= 0 ? value.value : null;
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
