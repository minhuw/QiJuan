/** CJK characters and full-width punctuation: no spaces are wanted between them. */
const CJK = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}\\u3000-\\u303f\\uff00-\\uffef';
const SPACE_IN_CJK = new RegExp(`(?<=[${CJK}])[ \\t]+|[ \\t]+(?=[${CJK}])`, 'gu');
const ENDS_CJK = new RegExp(`[${CJK}]$`, 'u');
const STARTS_CJK = new RegExp(`^[${CJK}]`, 'u');

/**
 * Plain text for the clipboard from a PDF text-layer selection. The layer breaks text at every
 * printed line and OCR adds spaces between Chinese characters; a paste should read as prose.
 * Blank lines stay as paragraph breaks; a line ending in a hyphen joins the next word.
 */
export function cleanCopiedText(raw: string): string {
  const paragraphs = raw
    .replace(/\r\n?/g, '\n')
    .replace(/[\u00a0\u2000-\u200b\u3000]/g, (char) => (char === '\u3000' ? char : ' '))
    .split(/\n[ \t]*\n+/);
  return paragraphs
    .map((paragraph) => {
      let out = '';
      for (const piece of paragraph.split('\n')) {
        const line = piece.replace(/[ \t]+/g, ' ').replace(SPACE_IN_CJK, '').trim();
        if (!line) continue;
        if (!out) out = line;
        else if (/[A-Za-z]-$/.test(out)) out = out.slice(0, -1) + line;
        else if (ENDS_CJK.test(out) || STARTS_CJK.test(line)) out += line;
        else out += ` ${line}`;
      }
      return out;
    })
    .filter(Boolean)
    .join('\n\n');
}
