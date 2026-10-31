import { inflateSync } from 'node:zlib';

/**
 * The book page's band colour, derived from the cover: the dominant non-neutral hue mapped to a
 * very pale tint (OKLCH L 0.93, C ≤ 0.03) for day and a very dark one (L 0.2, C ≤ 0.02) for night.
 *
 * Covers are sampled without an image library: a JPEG is read at one sample per 8×8 block from
 * the DC coefficients alone (baseline, or the first DC scan of a progressive file), and a PNG is
 * inflated with node:zlib and unfiltered. Other formats, and covers with no clear hue, give null
 * and the page falls back to stock.
 */

const DAY_L = 0.93;
const DAY_MAX_C = 0.03;
const NIGHT_L = 0.2;
const NIGHT_MAX_C = 0.02;
/** OKLab chroma below which a sample counts as neutral (paper, ink, grey). */
const NEUTRAL_C = 0.03;
/** At most this many samples per cover. */
const MAX_SAMPLES = 4096;

export interface CoverTint {
  /** The day band, as #rrggbb. */
  light: string;
  /** The night band, as #rrggbb. */
  dark: string;
}

/** Samples are packed RGB triplets, 0–255. */
type Samples = number[];

/** The stored day tint for a cover image, or null when it has no clear hue or cannot be read. */
export function deriveCoverTint(bytes: Buffer, mediaType: string): string | null {
  let samples: Samples | null = null;
  try {
    if (mediaType === 'image/jpeg') samples = sampleJpeg(bytes);
    else if (mediaType === 'image/png') samples = samplePng(bytes);
  } catch {
    samples = null;
  }
  if (!samples || samples.length === 0) return null;
  return tintFromSamples(samples);
}

/** The day and night bands for a stored day tint. */
export function coverTintPair(stored: string | null | undefined): CoverTint | null {
  if (!stored || !/^#[0-9a-f]{6}$/.test(stored)) return null;
  const [, a, b] = rgbToOklab(parseInt(stored.slice(1, 3), 16), parseInt(stored.slice(3, 5), 16), parseInt(stored.slice(5, 7), 16));
  const chroma = Math.hypot(a, b);
  const hue = Math.atan2(b, a);
  return {
    light: stored,
    dark: oklchToHex(NIGHT_L, Math.min(NIGHT_MAX_C, chroma * (NIGHT_MAX_C / DAY_MAX_C)), hue),
  };
}

/**
 * The dominant hue is the peak of a chroma-weighted hue histogram, so a cover split between two
 * hues takes the stronger one instead of averaging them to grey. Its strength sets the tint's
 * chroma: a cover that is mostly paper and ink gets a fainter tint than a fully coloured one.
 */
export function tintFromSamples(samples: Samples): string | null {
  const bins = 36;
  const weights = new Array<number>(bins).fill(0);
  const hues: number[] = [];
  const chromas: number[] = [];
  const count = Math.floor(samples.length / 3);
  if (count === 0) return null;
  for (let index = 0; index < count; index += 1) {
    const [, a, b] = rgbToOklab(samples[index * 3]!, samples[index * 3 + 1]!, samples[index * 3 + 2]!);
    const chroma = Math.hypot(a, b);
    if (chroma < NEUTRAL_C) continue;
    const hue = Math.atan2(b, a);
    hues.push(hue);
    chromas.push(chroma);
    weights[binOf(hue, bins)]! += chroma;
  }
  if (hues.length === 0) return null;
  let peak = 0;
  let best = -1;
  for (let bin = 0; bin < bins; bin += 1) {
    const smoothed = weights[(bin + bins - 1) % bins]! + 2 * weights[bin]! + weights[(bin + 1) % bins]!;
    if (smoothed > best) {
      best = smoothed;
      peak = bin;
    }
  }
  const centre = ((peak + 0.5) / bins) * 2 * Math.PI - Math.PI;
  let x = 0;
  let y = 0;
  let near = 0;
  let nearChroma = 0;
  for (let index = 0; index < hues.length; index += 1) {
    if (Math.abs(angleBetween(hues[index]!, centre)) > Math.PI / 6) continue;
    x += Math.cos(hues[index]!) * chromas[index]!;
    y += Math.sin(hues[index]!) * chromas[index]!;
    near += 1;
    nearChroma += chromas[index]!;
  }
  if (near === 0) return null;
  const hue = Math.atan2(y, x);
  const share = near / count;
  const strength = Math.min(1, nearChroma / near / 0.08);
  const chroma = DAY_MAX_C * Math.min(1, 0.35 + share) * Math.max(0.5, strength);
  return oklchToHex(DAY_L, Math.min(DAY_MAX_C, chroma), hue);
}

function binOf(hue: number, bins: number): number {
  const turn = (hue + Math.PI) / (2 * Math.PI);
  return Math.min(bins - 1, Math.floor(turn * bins));
}

function angleBetween(a: number, b: number): number {
  let delta = a - b;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  return delta;
}

// --- OKLab ---------------------------------------------------------------------------------

function toLinear(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function fromLinear(value: number): number {
  const clamped = Math.min(1, Math.max(0, value));
  const encoded = clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
  return Math.round(encoded * 255);
}

export function rgbToOklab(r: number, g: number, b: number): [number, number, number] {
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklchToHex(lightness: number, chroma: number, hue: number): string {
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return `#${rgb.map((value) => fromLinear(value).toString(16).padStart(2, '0')).join('')}`;
}

// --- JPEG: one sample per block from the DC coefficients -------------------------------------

interface Component {
  id: number;
  h: number;
  v: number;
  quant: number;
  dcTable: number;
  acTable: number;
  /** Block means, on the component's padded block grid. */
  blocks: Float64Array;
  /** Blocks per line on the padded grid. */
  stride: number;
  pred: number;
  seen: boolean;
}

interface Huffman {
  maxCode: Int32Array;
  valPtr: Int32Array;
  minCode: Int32Array;
  values: Uint8Array;
}

function buildHuffman(counts: Uint8Array, values: Uint8Array): Huffman {
  const maxCode = new Int32Array(18).fill(-1);
  const valPtr = new Int32Array(17);
  const minCode = new Int32Array(17);
  let code = 0;
  let pointer = 0;
  for (let length = 1; length <= 16; length += 1) {
    const n = counts[length - 1]!;
    if (n > 0) {
      valPtr[length] = pointer;
      minCode[length] = code;
      code += n;
      pointer += n;
      maxCode[length] = code - 1;
    }
    code <<= 1;
  }
  return { maxCode, valPtr, minCode, values };
}

class BitReader {
  private bits = 0;
  private count = 0;
  /** True once the reader has met a marker: later bits read as zero. */
  ended = false;

  constructor(
    private readonly bytes: Buffer,
    public position: number,
  ) {}

  bit(): number {
    if (this.count === 0) this.fill();
    this.count -= 1;
    return (this.bits >> this.count) & 1;
  }

  receive(length: number): number {
    let value = 0;
    for (let index = 0; index < length; index += 1) value = (value << 1) | this.bit();
    return value;
  }

  /** Drops buffered bits and steps over a restart marker, if one is next. */
  restart(): void {
    this.count = 0;
    this.ended = false;
    const bytes = this.bytes;
    while (this.position + 1 < bytes.length) {
      if (bytes[this.position] === 0xff && bytes[this.position + 1]! >= 0xd0 && bytes[this.position + 1]! <= 0xd7) {
        this.position += 2;
        return;
      }
      if (bytes[this.position] === 0xff && bytes[this.position + 1] !== 0x00) return;
      this.position += 1;
    }
  }

  private fill(): void {
    this.count = 8;
    if (this.ended || this.position >= this.bytes.length) {
      this.bits = 0;
      return;
    }
    const byte = this.bytes[this.position]!;
    if (byte === 0xff) {
      const next = this.bytes[this.position + 1];
      if (next === 0x00) {
        this.position += 2;
        this.bits = 0xff;
        return;
      }
      this.ended = true;
      this.bits = 0;
      return;
    }
    this.position += 1;
    this.bits = byte;
  }
}

function decodeSymbol(reader: BitReader, table: Huffman): number {
  let code = 0;
  for (let length = 1; length <= 16; length += 1) {
    code = (code << 1) | reader.bit();
    if (code <= table.maxCode[length]!) return table.values[table.valPtr[length]! + code - table.minCode[length]!]!;
  }
  throw new Error('bad huffman code');
}

function extend(value: number, length: number): number {
  return length === 0 ? 0 : value < 1 << (length - 1) ? value - (1 << length) + 1 : value;
}

/** The offset just past the entropy-coded data that starts at `from`. */
function skipEntropy(bytes: Buffer, from: number): number {
  let position = from;
  while (position + 1 < bytes.length) {
    if (bytes[position] === 0xff) {
      const next = bytes[position + 1]!;
      if (next !== 0x00 && !(next >= 0xd0 && next <= 0xd7)) return position;
    }
    position += 1;
  }
  return bytes.length;
}

export function sampleJpeg(bytes: Buffer): Samples | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const quant = new Map<number, number>();
  const dcTables = new Map<number, Huffman>();
  const acTables = new Map<number, Huffman>();
  let components: Component[] = [];
  let width = 0;
  let height = 0;
  let hMax = 1;
  let vMax = 1;
  let progressive = false;
  let restartInterval = 0;
  let adobeTransform: number | null = null;
  let position = 2;

  while (position + 4 <= bytes.length) {
    if (bytes[position] !== 0xff) return null;
    const marker = bytes[position + 1]!;
    if (marker === 0xff) {
      position += 1;
      continue;
    }
    if (marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      position += 2;
      continue;
    }
    const length = bytes.readUInt16BE(position + 2);
    const start = position + 4;
    const end = position + 2 + length;
    if (length < 2 || end > bytes.length) return null;

    if (marker === 0xdb) {
      let offset = start;
      while (offset < end) {
        const precision = bytes[offset]! >> 4;
        const id = bytes[offset]! & 15;
        // Only the DC quantiser (the first entry) matters for block means.
        quant.set(id, precision === 0 ? bytes[offset + 1]! : bytes.readUInt16BE(offset + 1));
        offset += 1 + 64 * (precision === 0 ? 1 : 2);
      }
    } else if (marker === 0xc4) {
      let offset = start;
      while (offset < end) {
        const kind = bytes[offset]! >> 4;
        const id = bytes[offset]! & 15;
        const counts = bytes.subarray(offset + 1, offset + 17);
        const total = counts.reduce((sum, value) => sum + value, 0);
        const values = bytes.subarray(offset + 17, offset + 17 + total);
        (kind === 0 ? dcTables : acTables).set(id, buildHuffman(counts, values));
        offset += 17 + total;
      }
    } else if (marker === 0xdd) {
      restartInterval = bytes.readUInt16BE(start);
    } else if (marker === 0xee && bytes.toString('ascii', start, start + 5) === 'Adobe') {
      adobeTransform = bytes[start + 11] ?? null;
    } else if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      progressive = marker === 0xc2;
      if (bytes[start] !== 8) return null;
      height = bytes.readUInt16BE(start + 1);
      width = bytes.readUInt16BE(start + 3);
      const count = bytes[start + 5]!;
      if (width === 0 || height === 0 || (count !== 1 && count !== 3)) return null;
      components = [];
      for (let index = 0; index < count; index += 1) {
        const offset = start + 6 + index * 3;
        components.push({
          id: bytes[offset]!,
          h: bytes[offset + 1]! >> 4,
          v: bytes[offset + 1]! & 15,
          quant: bytes[offset + 2]!,
          dcTable: 0,
          acTable: 0,
          blocks: new Float64Array(0),
          stride: 0,
          pred: 0,
          seen: false,
        });
      }
      hMax = Math.max(...components.map((item) => item.h));
      vMax = Math.max(...components.map((item) => item.v));
      const mcusX = Math.ceil(width / (8 * hMax));
      const mcusY = Math.ceil(height / (8 * vMax));
      for (const component of components) {
        component.stride = mcusX * component.h;
        component.blocks = new Float64Array(component.stride * mcusY * component.v);
      }
    } else if (marker >= 0xc3 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      // Lossless, hierarchical and arithmetic-coded JPEGs are not sampled.
      return null;
    } else if (marker === 0xda) {
      if (components.length === 0) return null;
      const count = bytes[start]!;
      const scan: Component[] = [];
      for (let index = 0; index < count; index += 1) {
        const id = bytes[start + 1 + index * 2]!;
        const tables = bytes[start + 2 + index * 2]!;
        const component = components.find((item) => item.id === id);
        if (!component) return null;
        component.dcTable = tables >> 4;
        component.acTable = tables & 15;
        scan.push(component);
      }
      const spectralStart = bytes[start + 1 + count * 2]!;
      const spectralEnd = bytes[start + 2 + count * 2]!;
      const approxHigh = bytes[start + 3 + count * 2]! >> 4;
      const approxLow = bytes[start + 3 + count * 2]! & 15;
      let data = end;
      const decodesDc = progressive ? spectralStart === 0 && approxHigh === 0 : true;
      if (decodesDc) {
        const reader = new BitReader(bytes, data);
        decodeScan(reader, {
          scan,
          width,
          height,
          hMax,
          vMax,
          restartInterval,
          dcTables,
          acTables,
          ac: !progressive,
          spectralEnd: progressive ? 0 : spectralEnd,
          shift: progressive ? approxLow : 0,
        });
        data = reader.position;
      }
      position = skipEntropy(bytes, data);
      continue;
    }
    position = end;
  }

  if (components.length === 0 || components.some((component) => !component.seen)) return null;
  return blockSamples(components, width, height, hMax, vMax, quant, adobeTransform);
}

interface ScanOptions {
  scan: Component[];
  width: number;
  height: number;
  hMax: number;
  vMax: number;
  restartInterval: number;
  dcTables: Map<number, Huffman>;
  acTables: Map<number, Huffman>;
  /** Baseline scans carry the AC coefficients too; they are decoded only to be skipped. */
  ac: boolean;
  spectralEnd: number;
  shift: number;
}

function decodeScan(reader: BitReader, options: ScanOptions): void {
  const { scan, width, height, hMax, vMax, restartInterval } = options;
  for (const component of scan) {
    component.pred = 0;
    component.seen = true;
  }
  const decodeBlock = (component: Component, index: number) => {
    const dc = options.dcTables.get(component.dcTable);
    if (!dc) throw new Error('missing dc table');
    const size = decodeSymbol(reader, dc);
    component.pred += extend(reader.receive(size), size);
    if (index >= 0 && index < component.blocks.length) component.blocks[index] = component.pred * (1 << options.shift);
    if (!options.ac) return;
    const ac = options.acTables.get(component.acTable);
    if (!ac) throw new Error('missing ac table');
    for (let k = 1; k <= options.spectralEnd; ) {
      const symbol = decodeSymbol(reader, ac);
      const run = symbol >> 4;
      const bits = symbol & 15;
      if (bits === 0) {
        if (run !== 15) break;
        k += 16;
        continue;
      }
      k += run;
      reader.receive(bits);
      k += 1;
    }
  };
  const step = (done: number) => {
    if (restartInterval > 0 && done > 0 && done % restartInterval === 0) {
      reader.restart();
      for (const component of scan) component.pred = 0;
    }
  };

  if (scan.length === 1) {
    // A single-component scan walks that component's own block grid, without padding.
    const component = scan[0]!;
    const across = Math.ceil(Math.ceil((width * component.h) / hMax) / 8);
    const down = Math.ceil(Math.ceil((height * component.v) / vMax) / 8);
    let done = 0;
    for (let row = 0; row < down; row += 1) {
      for (let column = 0; column < across; column += 1) {
        step(done);
        decodeBlock(component, row * component.stride + column);
        done += 1;
      }
    }
    return;
  }
  const mcusX = Math.ceil(width / (8 * hMax));
  const mcusY = Math.ceil(height / (8 * vMax));
  let done = 0;
  for (let mcuRow = 0; mcuRow < mcusY; mcuRow += 1) {
    for (let mcuColumn = 0; mcuColumn < mcusX; mcuColumn += 1) {
      step(done);
      for (const component of scan) {
        for (let v = 0; v < component.v; v += 1) {
          for (let h = 0; h < component.h; h += 1) {
            const row = mcuRow * component.v + v;
            const column = mcuColumn * component.h + h;
            decodeBlock(component, row * component.stride + column);
          }
        }
      }
      done += 1;
    }
  }
}

function blockSamples(
  components: Component[],
  width: number,
  height: number,
  hMax: number,
  vMax: number,
  quant: Map<number, number>,
  adobeTransform: number | null,
): Samples {
  // The block mean is the dequantised DC coefficient over 8, level-shifted by 128.
  const means = components.map((component) => {
    const q = quant.get(component.quant) ?? 1;
    return (index: number) => (component.blocks[index] ?? 0) * q / 8 + 128;
  });
  const lumaBlocksX = Math.ceil(width / 8);
  const lumaBlocksY = Math.ceil(height / 8);
  const stride = Math.max(1, Math.ceil(Math.sqrt((lumaBlocksX * lumaBlocksY) / MAX_SAMPLES)));
  const samples: Samples = [];
  for (let by = 0; by < lumaBlocksY; by += stride) {
    for (let bx = 0; bx < lumaBlocksX; bx += stride) {
      const x = bx * 8 + 4;
      const y = by * 8 + 4;
      const values = components.map((component, index) => {
        const column = Math.floor((x * component.h) / hMax / 8);
        const row = Math.floor((y * component.v) / vMax / 8);
        return means[index]!(row * component.stride + column);
      });
      if (values.length === 1) {
        const grey = clampByte(values[0]!);
        samples.push(grey, grey, grey);
      } else if (adobeTransform === 0) {
        samples.push(clampByte(values[0]!), clampByte(values[1]!), clampByte(values[2]!));
      } else {
        const [luma, cb, cr] = values as [number, number, number];
        samples.push(
          clampByte(luma + 1.402 * (cr - 128)),
          clampByte(luma - 0.344136 * (cb - 128) - 0.714136 * (cr - 128)),
          clampByte(luma + 1.772 * (cb - 128)),
        );
      }
    }
  }
  return samples;
}

function clampByte(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}

// --- PNG --------------------------------------------------------------------------------------

export function samplePng(bytes: Buffer): Samples | null {
  if (bytes.length < 33 || bytes.readUInt32BE(0) !== 0x89504e47) return null;
  let position = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let palette: Buffer | null = null;
  const data: Buffer[] = [];
  while (position + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(position);
    const type = bytes.toString('ascii', position + 4, position + 8);
    const body = bytes.subarray(position + 8, position + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8]!;
      colorType = body[9]!;
      // Interlaced PNGs are not sampled.
      if (body[12] !== 0) return null;
    } else if (type === 'PLTE') palette = body;
    else if (type === 'IDAT') data.push(body);
    else if (type === 'IEND') break;
    position += 12 + length;
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels || width === 0 || height === 0) return null;
  // Palette and grey images may pack pixels below a byte; colour images are 8 or 16 bits.
  const depths = colorType === 0 ? [1, 2, 4, 8, 16] : colorType === 3 ? [1, 2, 4, 8] : [8, 16];
  if (!depths.includes(depth)) return null;
  if (colorType === 3 && !palette) return null;
  const bitsPerPixel = channels * depth;
  const pixelBytes = Math.max(1, bitsPerPixel / 8);
  const rowBytes = Math.ceil((width * bitsPerPixel) / 8);
  const raw = inflateSync(Buffer.concat(data));
  if (raw.length < height * (rowBytes + 1)) return null;
  const maxValue = (1 << Math.min(depth, 8)) - 1;

  const stride = Math.max(1, Math.ceil(Math.sqrt((width * height) / MAX_SAMPLES)));
  const samples: Samples = [];
  let previous = Buffer.alloc(rowBytes);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (rowBytes + 1)]!;
    const row = Buffer.from(raw.subarray(y * (rowBytes + 1) + 1, (y + 1) * (rowBytes + 1)));
    unfilter(filter, row, previous, pixelBytes);
    previous = row;
    if (y % stride !== 0) continue;
    for (let x = 0; x < width; x += stride) {
      // The high byte of each channel; packed pixels are read from their bit offset.
      const at = (channel: number) => {
        if (depth >= 8) return row[x * pixelBytes + channel * (depth / 8)]!;
        const bit = x * depth;
        return (row[bit >> 3]! >> (8 - depth - (bit & 7))) & maxValue;
      };
      if (colorType === 3) {
        const entry = at(0) * 3;
        samples.push(palette![entry] ?? 0, palette![entry + 1] ?? 0, palette![entry + 2] ?? 0);
      } else if (colorType === 0 || colorType === 4) {
        if (colorType === 4 && at(1) < 128) continue;
        const grey = Math.round((at(0) * 255) / maxValue);
        samples.push(grey, grey, grey);
      } else {
        if (colorType === 6 && at(3) < 128) continue;
        samples.push(at(0), at(1), at(2));
      }
    }
  }
  return samples;
}

function unfilter(filter: number, row: Buffer, previous: Buffer, pixelBytes: number): void {
  for (let index = 0; index < row.length; index += 1) {
    const left = index >= pixelBytes ? row[index - pixelBytes]! : 0;
    const up = previous[index]!;
    const upLeft = index >= pixelBytes ? previous[index - pixelBytes]! : 0;
    let add = 0;
    if (filter === 1) add = left;
    else if (filter === 2) add = up;
    else if (filter === 3) add = (left + up) >> 1;
    else if (filter === 4) {
      const estimate = left + up - upLeft;
      const toLeft = Math.abs(estimate - left);
      const toUp = Math.abs(estimate - up);
      const toUpLeft = Math.abs(estimate - upLeft);
      add = toLeft <= toUp && toLeft <= toUpLeft ? left : toUp <= toUpLeft ? up : upLeft;
    }
    row[index] = (row[index]! + add) & 0xff;
  }
}
