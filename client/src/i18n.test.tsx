import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { catalogs, resolveLocale, translate } from './i18n';
import { Shell } from './shell';

describe('locales', () => {
  it('renders one shared key in English and Simplified Chinese', () => {
    const english = render(<Shell locale="en" />);
    expect(screen.getByRole('heading', { name: catalogs.en.home.title })).toBeInTheDocument();
    expect(screen.getByText('栖卷')).toBeInTheDocument();
    expect(screen.getByText('QiJuan')).toBeInTheDocument();
    expect(screen.getByText(catalogs.en.home.placeholder)).toBeInTheDocument();
    english.unmount();

    render(<Shell locale="zh-Hans" />);
    expect(screen.getByRole('heading', { name: catalogs['zh-Hans'].home.title })).toBeInTheDocument();
    expect(screen.getByText(catalogs['zh-Hans'].home.placeholder)).toBeInTheDocument();
    expect(translate('zh-Hans', 'home.title')).toBe(catalogs['zh-Hans'].home.title);
    expect(translate('en', 'home.title')).toBe(catalogs.en.home.title);
  });

  it('resolves Traditional Chinese when that catalog is added', () => {
    const withHant = {
      ...catalogs,
      'zh-Hant': catalogs['zh-Hans'],
    };
    expect(resolveLocale('zh-Hant', withHant)).toBe('zh-Hant');
    expect(resolveLocale('zh-TW', withHant)).toBe('zh-Hant');
    expect(resolveLocale('zh-CN', catalogs)).toBe('zh-Hans');
    expect(Object.keys(catalogs).sort()).toEqual(['en', 'zh-Hans']);
  });
});
