const TITLE_MAX = 500;
const NAME_MAX = 300;
const LANGUAGE_MAX = 35;
const PUBLISHER_MAX = 300;
const DATE_MAX = 40;
const DESCRIPTION_MAX = 100_000;
const TAG_MAX = 80;
const IDENTIFIER_MAX = 500;

export function hasControls(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function hasDescriptionControls(value: string): boolean {
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

export function cleanTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed || trimmed.length > TITLE_MAX || hasControls(trimmed)) return null;
  return trimmed;
}

export function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed || trimmed.length > NAME_MAX || hasControls(trimmed)) return null;
  return trimmed;
}

export function cleanLanguage(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > LANGUAGE_MAX || hasControls(trimmed)) return null;
  return trimmed;
}

export function cleanPublisher(value: unknown): string | null {
  return cleanName(value);
}

export function cleanPublishedDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > DATE_MAX || hasControls(trimmed)) return null;
  return trimmed;
}

export function cleanDescription(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.length > DESCRIPTION_MAX || hasDescriptionControls(value)) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function cleanTag(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed || trimmed.length > TAG_MAX || hasControls(trimmed)) return null;
  return trimmed;
}

export function cleanScheme(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const scheme = value.trim().toLowerCase();
  if (!/^[a-z0-9:+._-]{1,40}$/.test(scheme)) return null;
  return scheme;
}

export function cleanIdentifierValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > IDENTIFIER_MAX || hasControls(trimmed)) return null;
  return trimmed;
}
