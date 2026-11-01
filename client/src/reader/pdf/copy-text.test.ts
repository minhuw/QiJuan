import { describe, expect, it } from 'vitest';
import { cleanCopiedText } from './copy-text';

describe('cleanCopiedText', () => {
  it('drops OCR spaces between Chinese characters and joins printed lines', () => {
    expect(cleanCopiedText('书 有 归 处 ，\n人 有 闲 读 。')).toBe('书有归处，人有闲读。');
  });

  it('keeps spaces between Latin words and joins their lines with one space', () => {
    expect(cleanCopiedText('A quiet   index\nof   small things')).toBe('A quiet index of small things');
  });

  it('joins a word hyphenated across lines', () => {
    expect(cleanCopiedText('a hyphen-\nated word')).toBe('a hyphenated word');
  });

  it('removes spaces at a Chinese and Latin boundary but keeps paragraphs', () => {
    expect(cleanCopiedText('第一段 C (AA) 结束\n\n\n第二段 开始')).toBe('第一段C (AA)结束\n\n第二段开始');
  });

  it('turns non-breaking spaces into plain ones and trims empty lines', () => {
    expect(cleanCopiedText('\n  one\u00a0two \r\n\r\n')).toBe('one two');
  });
});
