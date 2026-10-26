export class XmlError extends Error {
  constructor() {
    super('invalid_xml');
    this.name = 'XmlError';
  }
}

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const MAX_XML_CHARS = 2_000_000;
const MAX_DEPTH = 40;
const MAX_NODES = 100_000;

export function parseXml(input: string): XmlNode {
  if (input.length > MAX_XML_CHARS) throw new XmlError();
  if (/<!DOCTYPE/i.test(input)) throw new XmlError();
  const source = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const parser = new Parser(source);
  const inner = parser.parseNodes(null, 0);
  return { name: '#root', attrs: {}, children: inner.children, text: inner.text };
}

export function descendants(node: XmlNode, localName: string): XmlNode[] {
  const found: XmlNode[] = [];
  const walk = (current: XmlNode) => {
    if (current.name === localName) found.push(current);
    for (const child of current.children) walk(child);
  };
  walk(node);
  return found;
}

export function deepText(node: XmlNode): string {
  const parts: string[] = [];
  const walk = (current: XmlNode) => {
    if (current.text) parts.push(current.text);
    for (const child of current.children) walk(child);
  };
  walk(node);
  return parts.join('');
}

/** Values of one metadata element, preferring nested rdf:li text when present. */
export function elementValues(node: XmlNode): string[] {
  const items = descendants(node, 'li').filter((item) => item !== node);
  if (items.length > 0) {
    return items.map((item) => deepText(item).trim()).filter((value) => value.length > 0);
  }
  const text = deepText(node).trim();
  return text ? [text] : [];
}

class Parser {
  private index = 0;
  private nodes = 0;

  constructor(private readonly source: string) {}

  parseNodes(endName: string | null, depth: number): { children: XmlNode[]; text: string } {
    if (depth > MAX_DEPTH) throw new XmlError();
    const children: XmlNode[] = [];
    let text = '';
    while (this.index < this.source.length) {
      if (this.source[this.index] !== '<') {
        const next = this.source.indexOf('<', this.index);
        const raw = this.source.slice(this.index, next === -1 ? this.source.length : next);
        text += decodeEntities(raw);
        this.index = next === -1 ? this.source.length : next;
        continue;
      }
      if (this.source.startsWith('<!--', this.index)) {
        const end = this.source.indexOf('-->', this.index + 4);
        if (end < 0) throw new XmlError();
        this.index = end + 3;
        continue;
      }
      if (this.source.startsWith('<![CDATA[', this.index)) {
        const end = this.source.indexOf(']]>', this.index + 9);
        if (end < 0) throw new XmlError();
        text += this.source.slice(this.index + 9, end);
        this.index = end + 3;
        continue;
      }
      if (this.source.startsWith('<?', this.index)) {
        const end = this.source.indexOf('?>', this.index + 2);
        if (end < 0) throw new XmlError();
        this.index = end + 2;
        continue;
      }
      if (this.source.startsWith('</', this.index)) {
        const close = this.readClose();
        if (endName === null || close !== endName) throw new XmlError();
        return { children, text };
      }
      children.push(this.parseElement(depth));
    }
    if (endName !== null) throw new XmlError();
    return { children, text };
  }

  private parseElement(depth: number): XmlNode {
    if (depth > MAX_DEPTH) throw new XmlError();
    if (this.source[this.index] !== '<') throw new XmlError();
    this.index += 1;
    const name = this.readName();
    const attrs = this.readAttrs();
    this.skipSpace();
    if (this.source.startsWith('/>', this.index)) {
      this.index += 2;
      this.countNode();
      return { name: localName(name), attrs, children: [], text: '' };
    }
    if (this.source[this.index] !== '>') throw new XmlError();
    this.index += 1;
    const inner = this.parseNodes(name, depth + 1);
    this.countNode();
    return { name: localName(name), attrs, children: inner.children, text: inner.text };
  }

  private readClose(): string {
    this.index += 2;
    const name = this.readName();
    this.skipSpace();
    if (this.source[this.index] !== '>') throw new XmlError();
    this.index += 1;
    return name;
  }

  private readAttrs(): Record<string, string> {
    const attrs: Record<string, string> = {};
    while (this.index < this.source.length) {
      this.skipSpace();
      const current = this.source[this.index];
      if (current === '>' || current === '/' || current === undefined) break;
      const key = this.readName();
      this.skipSpace();
      if (this.source[this.index] !== '=') throw new XmlError();
      this.index += 1;
      this.skipSpace();
      const quote = this.source[this.index];
      if (quote !== '"' && quote !== "'") throw new XmlError();
      this.index += 1;
      const end = this.source.indexOf(quote, this.index);
      if (end < 0) throw new XmlError();
      attrs[localName(key)] = decodeEntities(this.source.slice(this.index, end));
      this.index = end + 1;
    }
    return attrs;
  }

  private readName(): string {
    const start = this.index;
    while (this.index < this.source.length) {
      const code = this.source.charCodeAt(this.index);
      if (code <= 32 || this.source[this.index] === '>' || this.source[this.index] === '/' || this.source[this.index] === '=') {
        break;
      }
      this.index += 1;
    }
    if (this.index === start) throw new XmlError();
    return this.source.slice(start, this.index);
  }

  private skipSpace(): void {
    while (this.index < this.source.length && this.source.charCodeAt(this.index) <= 32) this.index += 1;
  }

  private countNode(): void {
    this.nodes += 1;
    if (this.nodes > MAX_NODES) throw new XmlError();
  }
}

function localName(name: string): string {
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos|nbsp);/g, (match, entity: string) => {
    if (entity === 'amp') return '&';
    if (entity === 'lt') return '<';
    if (entity === 'gt') return '>';
    if (entity === 'quot') return '"';
    if (entity === 'apos') return "'";
    if (entity === 'nbsp') return '\u00a0';
    const code = entity.startsWith('#x')
      ? Number.parseInt(entity.slice(2), 16)
      : Number.parseInt(entity.slice(1), 10);
    if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return match;
    return String.fromCodePoint(code);
  });
}
