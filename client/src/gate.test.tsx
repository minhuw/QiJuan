import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserRouter } from 'react-router';
import { App } from './App';
import type { ListedUser, MetadataAssistantInfo } from './api';
import { Gate } from './gate';
import { catalogs } from './i18n';
import { Shell } from './shell';

afterEach(() => {
  cleanup();
  window.history.pushState({}, '', '/');
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

const UNCONFIGURED_ASSISTANT: MetadataAssistantInfo = {
  configured: false,
  baseUrl: null,
  model: null,
  apiKeyConfigured: false,
  apiKeyHint: null,
};

const CONFIGURED_ASSISTANT: MetadataAssistantInfo = {
  configured: true,
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  apiKeyConfigured: true,
  apiKeyHint: 'abcd',
};

interface RecordedCall {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

function installSettingsFetch(
  options: {
    role?: 'admin' | 'reader';
    assistant?: MetadataAssistantInfo;
    test?: () => Response;
  } = {},
) {
  const role = options.role ?? 'admin';
  const state = { assistant: options.assistant ?? UNCONFIGURED_ASSISTANT };
  const calls: RecordedCall[] = [];

  installFetch((url, init) => {
    const method = init?.method ?? 'GET';
    if (url === '/api/setup') return json({ needed: false });
    if (url === '/api/me') {
      return json({
        user: { id: role === 'admin' ? 1 : 2, username: role === 'admin' ? 'ada' : 'bea', role },
        libraries: [{ id: 1, name: 'Home', mode: 'managed' }],
      });
    }
    if (url === '/api/users' && method === 'GET') return json({ users: [] });
    if (url === '/api/libraries' && method === 'GET') {
      return json({ libraries: [{ id: 1, name: 'Home', mode: 'managed' }] });
    }
    if (url === '/api/metadata/assistant/test' && method === 'POST') {
      calls.push({ url, method, body: null });
      return options.test ? options.test() : json({ ok: true, model: 'deepseek-chat' });
    }
    if (url === '/api/metadata/assistant') {
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      calls.push({ url, method, body });
      if (method === 'GET') return json({ assistant: state.assistant });
      if (method === 'DELETE') {
        state.assistant = UNCONFIGURED_ASSISTANT;
        return json({ assistant: state.assistant });
      }
      if (method === 'PUT' && body) {
        const typedKey = typeof body.apiKey === 'string' ? body.apiKey : '';
        state.assistant = {
          configured: true,
          baseUrl: String(body.baseUrl ?? ''),
          model: String(body.model ?? ''),
          apiKeyConfigured: typedKey.length > 0 || state.assistant.apiKeyConfigured,
          apiKeyHint: typedKey.length > 0 ? typedKey.slice(-4) : state.assistant.apiKeyHint,
        };
        return json({ assistant: state.assistant });
      }
    }
    return json({ error: 'not_found' }, 404);
  });

  return { state, calls };
}

function renderSettings() {
  window.history.pushState({}, '', '/settings');
  return render(<App locale="en" />);
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
      if (url === '/api/metadata/assistant' && method === 'GET') {
        return json({ assistant: UNCONFIGURED_ASSISTANT });
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

describe('settings metadata agent', () => {
  it('shows the configured model and a masked key hint', async () => {
    installSettingsFetch({ assistant: CONFIGURED_ASSISTANT });
    renderSettings();

    expect(await screen.findByRole('heading', { name: catalogs.en.settings.assistant.title })).toBeInTheDocument();
    expect(await screen.findByText(catalogs.en.settings.assistant.configured)).toBeInTheDocument();
    expect(screen.getByText('deepseek-chat')).toBeInTheDocument();
    expect(screen.getByText('••••abcd')).toBeInTheDocument();
    expect(screen.getByLabelText(catalogs.en.settings.assistant.baseUrl)).toHaveValue(
      CONFIGURED_ASSISTANT.baseUrl,
    );
    expect(screen.getByLabelText(catalogs.en.settings.assistant.model)).toHaveValue(CONFIGURED_ASSISTANT.model);

    const key = screen.getByLabelText(catalogs.en.settings.assistant.apiKey);
    expect(key).toHaveValue('');
    expect(key).toHaveAttribute('type', 'password');
    expect(screen.getByText(catalogs.en.settings.assistant.keyKept)).toBeInTheDocument();
    expect(screen.getByText(catalogs.en.settings.assistant.hint)).toBeInTheDocument();
  });

  it('saves a new agent and clears the typed key', async () => {
    const server = installSettingsFetch();
    renderSettings();

    expect(await screen.findByText(catalogs.en.settings.assistant.notConfigured)).toBeInTheDocument();
    const base = screen.getByLabelText(catalogs.en.settings.assistant.baseUrl);
    const model = screen.getByLabelText(catalogs.en.settings.assistant.model);
    expect(base).toHaveAttribute('placeholder', 'https://api.deepseek.com/v1');
    expect(model).toHaveAttribute('placeholder', 'deepseek-chat');

    fireEvent.change(base, { target: { value: 'https://api.deepseek.com/v1' } });
    fireEvent.change(model, { target: { value: 'deepseek-chat' } });
    fireEvent.change(screen.getByLabelText(catalogs.en.settings.assistant.apiKey), {
      target: { value: 'testkey9876' },
    });
    fireEvent.click(screen.getByRole('button', { name: catalogs.en.settings.assistant.save }));

    expect(await screen.findByText(catalogs.en.settings.assistant.saved)).toBeInTheDocument();
    expect(screen.getByText(catalogs.en.settings.assistant.configured)).toBeInTheDocument();
    expect(server.calls.find((call) => call.method === 'PUT')?.body).toEqual({
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      apiKey: 'testkey9876',
    });
    expect(screen.getByLabelText(catalogs.en.settings.assistant.apiKey)).toHaveValue('');
    expect(screen.getByText('••••9876')).toBeInTheDocument();
    expect(screen.getByText(catalogs.en.settings.assistant.keyKept)).toBeInTheDocument();
  });

  it('keeps the saved key when the key field is blank', async () => {
    const server = installSettingsFetch({ assistant: CONFIGURED_ASSISTANT });
    renderSettings();

    const model = await screen.findByLabelText(catalogs.en.settings.assistant.model);
    fireEvent.change(model, { target: { value: 'deepseek-reasoner' } });
    fireEvent.click(screen.getByRole('button', { name: catalogs.en.settings.assistant.save }));

    expect(await screen.findByText(catalogs.en.settings.assistant.saved)).toBeInTheDocument();
    expect(server.calls.find((call) => call.method === 'PUT')?.body).toEqual({
      baseUrl: CONFIGURED_ASSISTANT.baseUrl,
      model: 'deepseek-reasoner',
      apiKey: '',
    });
    expect(screen.getByLabelText(catalogs.en.settings.assistant.model)).toHaveValue('deepseek-reasoner');
    expect(screen.getByText('••••abcd')).toBeInTheDocument();
    expect(screen.getByText(catalogs.en.settings.assistant.keyKept)).toBeInTheDocument();
  });

  it('tests the saved configuration and reports success', async () => {
    const server = installSettingsFetch({ assistant: CONFIGURED_ASSISTANT });
    renderSettings();

    fireEvent.click(await screen.findByRole('button', { name: catalogs.en.settings.assistant.test }));
    expect(await screen.findByText(catalogs.en.settings.assistant.testOk)).toBeInTheDocument();
    expect(
      server.calls.some((call) => call.url === '/api/metadata/assistant/test' && call.method === 'POST'),
    ).toBe(true);
  });

  it('shows a localized error when the connection test fails', async () => {
    installSettingsFetch({
      assistant: CONFIGURED_ASSISTANT,
      test: () => json({ error: 'assistant_unauthorized' }, 502),
    });
    renderSettings();

    fireEvent.click(await screen.findByRole('button', { name: catalogs.en.settings.assistant.test }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      catalogs.en.settings.assistant.errors.assistant_unauthorized,
    );
  });

  it('removes the saved configuration', async () => {
    const server = installSettingsFetch({ assistant: CONFIGURED_ASSISTANT });
    renderSettings();

    fireEvent.click(await screen.findByRole('button', { name: catalogs.en.settings.assistant.remove }));
    expect(await screen.findByText(catalogs.en.settings.assistant.removed)).toBeInTheDocument();
    expect(screen.getByText(catalogs.en.settings.assistant.notConfigured)).toBeInTheDocument();
    expect(screen.getByLabelText(catalogs.en.settings.assistant.baseUrl)).toHaveValue('');
    expect(screen.getByLabelText(catalogs.en.settings.assistant.model)).toHaveValue('');
    expect(screen.queryByText('••••abcd')).not.toBeInTheDocument();
    expect(
      server.calls.some((call) => call.url === '/api/metadata/assistant' && call.method === 'DELETE'),
    ).toBe(true);
  });

  it('keeps the panel away from readers', async () => {
    const server = installSettingsFetch({ role: 'reader' });
    renderSettings();

    expect(await screen.findByRole('heading', { name: catalogs.en.home.title })).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: catalogs.en.settings.assistant.title }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: catalogs.en.settings.open })).not.toBeInTheDocument();
    expect(server.calls).toHaveLength(0);
  });
});
