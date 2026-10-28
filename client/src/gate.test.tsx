import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserRouter } from 'react-router';
import { App } from './App';
import type { ListedUser } from './api';
import { Gate } from './gate';
import { catalogs } from './i18n';
import { Shell } from './shell';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installFetch(handler: (url: string, init?: RequestInit) => Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      return Promise.resolve(handler(url, init));
    }),
  );
}

describe('first-run gate', () => {
  it('shows setup instead of sign-in when no administrator exists', async () => {
    installFetch((url) => {
      if (url === '/api/setup') return json({ needed: true });
      return json({ error: 'unauthorized' }, 401);
    });

    render(<App locale="en" />);
    expect(await screen.findByRole('heading', { name: catalogs.en.setup.title })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: catalogs.en.login.title })).not.toBeInTheDocument();
    expect(screen.getByLabelText(catalogs.en.setup.username)).toBeInTheDocument();
    expect(screen.getByLabelText(catalogs.en.setup.password)).toBeInTheDocument();
    expect(screen.getByLabelText(catalogs.en.setup.libraryName)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: catalogs.en.setup.submit })).toBeInTheDocument();
  });

  it('switches setup copy to Simplified Chinese', async () => {
    installFetch((url) => {
      if (url === '/api/setup') return json({ needed: true });
      return json({ error: 'unauthorized' }, 401);
    });

    render(<App locale="en" />);
    expect(await screen.findByRole('heading', { name: catalogs.en.setup.title })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(catalogs.en.shell.language), { target: { value: 'zh-Hans' } });
    expect(screen.getByRole('heading', { name: catalogs['zh-Hans'].setup.title })).toBeInTheDocument();
    expect(screen.getByLabelText(catalogs['zh-Hans'].setup.libraryName)).toBeInTheDocument();
  });

  it('shows sign-in once setup is complete and keeps an empty session out', async () => {
    installFetch((url, init) => {
      if (url === '/api/setup') return json({ needed: false });
      if (url === '/api/me') return json({ error: 'unauthorized' }, 401);
      if (url === '/api/session/login' && init?.method === 'POST') {
        return json({ error: 'invalid_credentials' }, 401);
      }
      return json({ error: 'not_found' }, 404);
    });

    render(
      <BrowserRouter>
        <Shell locale="zh-Hans">
          <Gate />
        </Shell>
      </BrowserRouter>,
    );

    expect(await screen.findByRole('heading', { name: catalogs['zh-Hans'].login.title })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: catalogs['zh-Hans'].setup.title })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(catalogs['zh-Hans'].login.username), { target: { value: 'ada' } });
    fireEvent.change(screen.getByLabelText(catalogs['zh-Hans'].login.password), {
      target: { value: 'not-the-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: catalogs['zh-Hans'].login.submit }));
    expect(await screen.findByRole('alert')).toHaveTextContent(catalogs['zh-Hans'].errors.invalid_credentials);
  });

  it('signs in after setup and lets an admin create and grant a reader', async () => {
    const state: {
      needed: boolean;
      users: ListedUser[];
      libraries: Array<{ id: number; name: string; mode: 'managed' }>;
    } = {
      needed: true,
      users: [{ id: 1, username: 'ada', role: 'admin', libraryIds: [1] }],
      libraries: [{ id: 1, name: 'Home', mode: 'managed' }],
    };

    installFetch((url, init) => {
      const method = init?.method ?? 'GET';
      if (url === '/api/setup' && method === 'GET') return json({ needed: state.needed });
      if (url === '/api/setup' && method === 'POST') {
        state.needed = false;
        return json(
          {
            user: { id: 1, username: 'ada', role: 'admin' },
            library: state.libraries[0],
          },
          201,
        );
      }
      if (url === '/api/me') {
        return json({
          user: { id: 1, username: 'ada', role: 'admin' },
          libraries: state.libraries,
        });
      }
      if (url === '/api/users' && method === 'GET') return json({ users: state.users });
      if (url === '/api/libraries' && method === 'GET') return json({ libraries: state.libraries });
      if (url === '/api/users' && method === 'POST') {
        state.users = [...state.users, { id: 2, username: 'bea', role: 'reader', libraryIds: [] }];
        return json({ user: { id: 2, username: 'bea', role: 'reader' } }, 201);
      }
      if (url === '/api/libraries/1/grants' && method === 'POST') {
        state.users = state.users.map((user) => (user.id === 2 ? { ...user, libraryIds: [1] } : user));
        return json({ userId: 2, libraryId: 1 }, 201);
      }
      return json({ error: 'not_found' }, 404);
    });

    render(<App locale="en" />);
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'ada' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct-horse' } });
    fireEvent.change(screen.getByLabelText('Library name'), { target: { value: 'Home' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create administrator' }));

    expect(await screen.findByRole('heading', { name: 'Library' })).toBeInTheDocument();
    expect(screen.getByText('Home')).toBeInTheDocument();
    expect(await screen.findByText('ada')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('link', { name: 'Settings' }));
    expect(await screen.findByRole('heading', { name: 'Readers' })).toBeInTheDocument();
    expect(await screen.findByText('No readers yet.')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'bea' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'reader-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create reader' }));

    expect(await screen.findByRole('heading', { name: 'bea' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Grant Home bea' }));
    expect(await screen.findByRole('button', { name: 'Revoke Home bea' })).toBeInTheDocument();
  });
});
