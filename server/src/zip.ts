import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

const MAX_ENTRIES = 10_000;
const MAX_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_COMMENT = 65_535;

export class ZipError extends Error {
  readonly code: 'invalid' | 'unsafe_path' | 'too_large' | 'not_zip';

  constructor(code: ZipError['code']) {
    super(code);
    this.name = 'ZipError';
    this.code = code;
  }
}

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  crc32: number;
}

export interface ZipArchive {
  entries: ZipEntry[];
  read(name: string, maxUncompressed?: number): Buffer;
  close(): void;
}

/**
 * Reads a zip central directory, then inflates one named entry at a time.
 * Absolute paths and `..` segments are refused before any entry bytes are inflated.
 * This is only used for a recognized EPUB. Other formats must not call it.
 */
export function openZip(filePath: string): ZipArchive {
  const fd = openSync(filePath, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size < 22) throw new ZipError('not_zip');
    const entries = readCentralDirectory(fd, size);
    for (const entry of entries) {
      if (normalizeZipName(entry.name) === null) throw new ZipError('unsafe_path');
    }
    let closed = false;
    return {
      entries,
      read(name: string, maxUncompressed = MAX_ENTRY_BYTES) {
        if (closed) throw new ZipError('invalid');
        const safe = normalizeZipName(name);
        if (!safe) throw new ZipError('unsafe_path');
        const entry = entries.find((candidate) => candidate.name === safe);
        if (!entry) throw new ZipError('invalid');
        return readEntry(fd, entry, maxUncompressed);
      },
      close() {
        if (closed) return;
        closed = true;
        closeSync(fd);
      },
    };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/** Store (method 0) or raw deflate (method 8). Names must already be zip-safe. */
export function buildZip(
  entries: Array<{ name: string; data: Buffer; method?: 0 | 8 }>,
  options?: { allowUnsafe?: boolean },
): Buffer {
  const parts: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const safe = normalizeZipName(entry.name);
    if (!options?.allowUnsafe && (!safe || safe !== entry.name)) throw new ZipError('unsafe_path');
    const name = Buffer.from(entry.name, 'utf8');
    const method = entry.method ?? 0;
    const stored = method === 8 ? deflateRawSync(entry.data) : entry.data;
    const checksum = crc32(entry.data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    parts.push(local, stored);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(CENTRAL_SIG, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + stored.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBuf, eocd]);
}

export function normalizeZipName(name: string): string | null {
  if (typeof name !== 'string') return null;
  if (name.includes('\0') || name.includes('\\')) return null;
  if (name.startsWith('/') || name.startsWith('\\') || /^[A-Za-z]:/.test(name)) return null;
  const parts: string[] = [];
  for (const part of name.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') return null;
    parts.push(part);
  }
  if (parts.length === 0) return null;
  return parts.join('/');
}

export function zipPathInside(baseFile: string, href: string): string | null {
  const withoutFragment = href.split('#')[0] ?? '';
  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutFragment);
  } catch {
    return null;
  }
  if (decoded.includes('\\') || decoded.includes('\0')) return null;
  const baseDir = baseFile.includes('/') ? baseFile.slice(0, baseFile.lastIndexOf('/') + 1) : '';
  const combined = decoded.startsWith('/') ? decoded.slice(1) : `${baseDir}${decoded}`;
  return normalizeZipName(combined);
}

export function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  CRC_TABLE[index] = value >>> 0;
}

function readCentralDirectory(fd: number, size: number): ZipEntry[] {
  const tailLen = Math.min(size, 22 + MAX_COMMENT);
  const tail = readAt(fd, size - tailLen, tailLen);
  const eocd = findEocd(tail);
  if (!eocd) throw new ZipError('not_zip');
  if (eocd.entries > MAX_ENTRIES || eocd.cdOffset < 0 || eocd.cdSize < 0) throw new ZipError('invalid');
  if (eocd.entries === 0xffff || eocd.cdOffset === 0xffffffff || eocd.cdSize === 0xffffffff) throw new ZipError('invalid');
  // Allocate only bytes that exist. A tiny file can claim a multi-gigabyte directory.
  if (eocd.cdOffset > size || eocd.cdSize > size - eocd.cdOffset) throw new ZipError('invalid');
  const directory = readAt(fd, eocd.cdOffset, eocd.cdSize);
  if (directory.length !== eocd.cdSize) throw new ZipError('invalid');
  const entries: ZipEntry[] = [];
  let offset = 0;
  for (let index = 0; index < eocd.entries; index += 1) {
    if (offset + 46 > directory.length) throw new ZipError('invalid');
    if (directory.readUInt32LE(offset) !== CENTRAL_SIG) throw new ZipError('invalid');
    const flags = directory.readUInt16LE(offset + 8);
    const method = directory.readUInt16LE(offset + 10);
    const checksum = directory.readUInt32LE(offset + 16);
    const compressedSize = directory.readUInt32LE(offset + 20);
    const uncompressedSize = directory.readUInt32LE(offset + 24);
    const nameLength = directory.readUInt16LE(offset + 28);
    const extraLength = directory.readUInt16LE(offset + 30);
    const commentLength = directory.readUInt16LE(offset + 32);
    const localHeaderOffset = directory.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd + extraLength + commentLength > directory.length) throw new ZipError('invalid');
    const rawName = directory.toString('utf8', nameStart, nameEnd);
    if (rawName.endsWith('/')) {
      if (normalizeZipName(rawName) === null && rawName !== '/') throw new ZipError('unsafe_path');
      offset = nameEnd + extraLength + commentLength;
      continue;
    }
    if ((flags & 0x1) !== 0) throw new ZipError('invalid');
    if (method !== 0 && method !== 8) throw new ZipError('invalid');
    if (compressedSize > MAX_ENTRY_BYTES || uncompressedSize > MAX_ENTRY_BYTES) throw new ZipError('too_large');
    const safe = normalizeZipName(rawName);
    if (!safe) throw new ZipError('unsafe_path');
    entries.push({
      name: safe,
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      crc32: checksum,
    });
    offset = nameEnd + extraLength + commentLength;
  }
  return entries;
}

function findEocd(tail: Buffer): { entries: number; cdSize: number; cdOffset: number } | null {
  const min = Math.max(0, tail.length - (22 + MAX_COMMENT));
  for (let index = tail.length - 22; index >= min; index -= 1) {
    if (tail.readUInt32LE(index) !== EOCD_SIG) continue;
    const commentLength = tail.readUInt16LE(index + 20);
    if (index + 22 + commentLength !== tail.length) continue;
    return {
      entries: tail.readUInt16LE(index + 10),
      cdSize: tail.readUInt32LE(index + 12),
      cdOffset: tail.readUInt32LE(index + 16),
    };
  }
  return null;
}

function readEntry(fd: number, entry: ZipEntry, maxUncompressed: number): Buffer {
  if (entry.uncompressedSize > maxUncompressed || entry.compressedSize > MAX_ENTRY_BYTES) {
    throw new ZipError('too_large');
  }
  const header = readAt(fd, entry.localHeaderOffset, 30);
  if (header.length < 30 || header.readUInt32LE(0) !== LOCAL_SIG) throw new ZipError('invalid');
  const flags = header.readUInt16LE(6);
  const method = header.readUInt16LE(8);
  if ((flags & 0x1) !== 0) throw new ZipError('invalid');
  if (method !== entry.method) throw new ZipError('invalid');
  const nameLength = header.readUInt16LE(26);
  const extraLength = header.readUInt16LE(28);
  const nameBuf = readAt(fd, entry.localHeaderOffset + 30, nameLength);
  const localName = normalizeZipName(nameBuf.toString('utf8'));
  if (!localName || localName !== entry.name) throw new ZipError('unsafe_path');
  const dataStart = entry.localHeaderOffset + 30 + nameLength + extraLength;
  const compressed = readAt(fd, dataStart, entry.compressedSize);
  if (compressed.length !== entry.compressedSize) throw new ZipError('invalid');
  let output: Buffer;
  try {
    output =
      method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: maxUncompressed + 1 });
  } catch (error) {
    if (error instanceof ZipError) throw error;
    throw new ZipError('invalid');
  }
  if (output.length !== entry.uncompressedSize || output.length > maxUncompressed) throw new ZipError('too_large');
  if (crc32(output) !== entry.crc32) throw new ZipError('invalid');
  return output;
}

function readAt(fd: number, position: number, length: number): Buffer {
  if (!Number.isSafeInteger(position) || !Number.isSafeInteger(length) || position < 0 || length < 0) {
    throw new ZipError('invalid');
  }
  const size = fstatSync(fd).size;
  if (position > size) throw new ZipError('invalid');
  const capped = Math.min(length, size - position);
  const buffer = Buffer.alloc(capped);
  let offset = 0;
  while (offset < capped) {
    const read = readSync(fd, buffer, offset, capped - offset, position + offset);
    if (read <= 0) break;
    offset += read;
  }
  return offset === capped ? buffer : buffer.subarray(0, offset);
}
