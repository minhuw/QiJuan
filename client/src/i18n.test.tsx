import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserRouter } from 'react-router';
import { catalogs, resolveLocale, translate } from './i18n';
import { Shell } from './shell';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('locales', () => {
  it('renders one shared key in English and Simplified Chinese', () => {
    const english = render(
      <BrowserRouter>
        <Shell locale="en" />
      </BrowserRouter>,
    );
    expect(screen.getByRole('heading', { name: catalogs.en.home.title })).toBeInTheDocument();
    expect(screen.getByText('栖卷')).toBeInTheDocument();
    expect(screen.getByText('QiJuan')).toBeInTheDocument();
    expect(screen.getByText(catalogs.en.home.placeholder)).toBeInTheDocument();
    english.unmount();

    render(
      <BrowserRouter>
        <Shell locale="zh-Hans" />
      </BrowserRouter>,
    );
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

  it('shows the running revision in the header', async () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: true, revision: sha }), { status: 200 })),
    );
    render(
      <BrowserRouter>
        <Shell locale="en" />
      </BrowserRouter>,
    );
    const shown = await screen.findByTitle(sha);
    expect(shown).toHaveTextContent(sha.slice(0, 12));
    expect(shown).toHaveTextContent('Version');
  });
});
