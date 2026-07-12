import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  startEmbeddedServerMock, prepareServeRootMock, sessionCreate, sessionPrompt, fakeServer,
  buildOneShotSandboxProfileMock, wrapServeCommandMock, getEgressProxyMock, revokeCredentialMock, fsMkdirMock,
} = vi.hoisted(() => {
  const sessionCreate = vi.fn();
  const sessionPrompt = vi.fn();
  const client = { session: { create: sessionCreate, prompt: sessionPrompt } };
  const fakeServer = {
    client,
    url: 'http://127.0.0.1:1',
    close: vi.fn(),
    onExit: vi.fn(),
  };
  const revokeCredentialMock = vi.fn();
  return {
    startEmbeddedServerMock: vi.fn(async (_opts: { cwd: string; config: Record<string, unknown>; spawnOverride?: { command: string; args: string[] }; env?: Record<string, string> }) => fakeServer),
    prepareServeRootMock: vi.fn(async (_root: string) => {}),
    sessionCreate,
    sessionPrompt,
    fakeServer,
    buildOneShotSandboxProfileMock: vi.fn((args: { root: string; homeDir: string; proxy: unknown }) => ({
      cwd: args.root, homeDir: args.homeDir, // I4: profile cwd == root (== spawn cwd)
      roBinds: [], rwBinds: [args.root], denyWriteRoBinds: [], proxy: { url: 'http://127.0.0.1:1', noProxy: '127.0.0.1' },
      allowlist: ['openrouter.ai'], env: { HOME: args.homeDir },
      cred: { username: 'one-shot-u', password: 'one-shot-p' },
    })),
    wrapServeCommandMock: vi.fn(async () => ({ command: 'bwrap', args: ['opencode', 'serve'] })),
    getEgressProxyMock: vi.fn(async () => ({
      url: 'http://127.0.0.1:1',
      mintCredential: vi.fn(() => ({ username: 'one-shot-u', password: 'one-shot-p' })),
      revokeCredential: revokeCredentialMock,
      close: vi.fn(),
    })),
    revokeCredentialMock,
    fsMkdirMock: vi.fn(async () => undefined),
  };
});

// The one-shot utility serve (P3a §7) boots its OWN tiny embedded server
// directly via embedded-server.js — no bridge, no skills, no MCP. Stub the
// embedded-server boundary so this unit test exercises llm-one-shot.ts against
// a mocked client only (no real spawn, socket, or file write). `concatPromptText`
// is still consumed from the real `../server.js` (unchanged), so it is NOT
// mocked here — only the collaborators llm-one-shot.ts itself calls are.
vi.mock('../embedded-server.js', () => ({
  startEmbeddedServer: startEmbeddedServerMock,
  prepareServeRoot: prepareServeRootMock,
  SERVE_PERMISSION: { edit: 'allow', bash: 'allow', webfetch: 'allow', external_directory: 'allow' },
}));
// P3b: llm-one-shot.ts now builds a minimal sandbox profile + mints its own
// egress-proxy credential + creates its own homeDir before spawning wrapped.
vi.mock('../child-sandbox.js', () => ({
  buildOneShotSandboxProfile: buildOneShotSandboxProfileMock,
  wrapServeCommand: wrapServeCommandMock,
}));
vi.mock('../egress-proxy.js', () => ({ getEgressProxy: getEgressProxyMock }));
// Real disk I/O would be needless overhead/flakiness in a unit test — stub it
// like the rest of the boot preamble (prepareServeRoot above).
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, mkdir: fsMkdirMock };
});
vi.mock('../../../system/workdir.js', () => ({ WORKDIR: '/fake-workdir' }));
vi.mock('../../../system/logger.js', () => ({
  logger: { error: vi.fn(), system: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn(), plain: vi.fn() },
}));

import { OpencodeLlmOneShot, closeOneShotServe } from '../llm-one-shot.js';

const MODEL = 'anthropic/claude-haiku-4-5'; // passthrough — avoids env lookup
const shot = new OpencodeLlmOneShot();

beforeEach(() => {
  sessionCreate.mockReset().mockResolvedValue({ data: { id: 'sess-1' } });
  sessionPrompt.mockReset();
  startEmbeddedServerMock.mockClear();
  prepareServeRootMock.mockClear();
  fakeServer.close.mockClear();
  buildOneShotSandboxProfileMock.mockClear();
  wrapServeCommandMock.mockClear();
  getEgressProxyMock.mockClear();
  revokeCredentialMock.mockClear();
  fsMkdirMock.mockClear();
  delete process.env.ARCHIE_OPENCODE_MODEL_HAIKU;
  // getOneShotClient() resolves the utility serve's own config.model via
  // resolveOpencodeModel('haiku') — set DEFAULT as the fallback so that
  // internal resolution succeeds independently of what each test is asserting
  // about req.model resolution. The one test that needs
  // ARCHIE_OPENCODE_MODEL_DEFAULT absent (model-cannot-be-resolved) deletes it
  // itself before its request, and fails before ever reaching getOneShotClient().
  process.env.ARCHIE_OPENCODE_MODEL_DEFAULT = 'openrouter/z-ai/glm-4.7';
});

afterEach(async () => {
  // Reset the module-level utility-serve singleton so each test's boot
  // assertions (call counts, cwd/config passed to startEmbeddedServer) are
  // independent of test order.
  await closeOneShotServe();
  delete process.env.ARCHIE_OPENCODE_MODEL_DEFAULT;
  delete process.env.ARCHIE_OPENCODE_MODEL_HAIKU;
});

describe('OpencodeLlmOneShot.text', () => {
  it('concatenates text parts and passes model/parts/system', async () => {
    sessionPrompt.mockResolvedValue({
      data: { info: {}, parts: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'world' }, { type: 'tool' }] },
    });
    const out = await shot.text({ prompt: 'hi', model: MODEL, systemPrompt: 'be brief' });
    expect(out).toBe('Hello world');
    const body = sessionPrompt.mock.calls[0][0].body;
    expect(body.model).toEqual({ providerID: 'anthropic', modelID: 'claude-haiku-4-5' });
    expect(body.parts).toEqual([{ type: 'text', text: 'hi' }]);
    expect(body.system).toBe('be brief');
  });

  it('returns null on a message-level error', async () => {
    sessionPrompt.mockResolvedValue({ data: { info: { error: { name: 'ProviderAuthError' } }, parts: [] } });
    expect(await shot.text({ prompt: 'hi', model: MODEL })).toBeNull();
  });

  it('returns null on an HTTP-level error', async () => {
    sessionPrompt.mockResolvedValue({ error: { message: 'boom' } });
    expect(await shot.text({ prompt: 'hi', model: MODEL })).toBeNull();
  });

  it('returns null (no spawn) when the model cannot be resolved', async () => {
    delete process.env.ARCHIE_OPENCODE_MODEL_DEFAULT; // req.model resolution must fail before any env fallback
    const out = await shot.text({ prompt: 'hi', model: 'haiku' }); // no env, no slash
    expect(out).toBeNull();
    expect(sessionCreate).not.toHaveBeenCalled();
  });

  it('boots ONE utility serve outside the pool and reuses it across calls (spec §7/A6)', async () => {
    sessionPrompt.mockResolvedValue({ data: { info: {}, parts: [{ type: 'text', text: 'ok' }] } });
    const oneShot = new OpencodeLlmOneShot();
    await oneShot.text({ model: 'haiku', prompt: 'a' });
    await oneShot.text({ model: 'haiku', prompt: 'b' });
    expect(startEmbeddedServerMock).toHaveBeenCalledTimes(1);
    const opts = startEmbeddedServerMock.mock.calls[0][0];
    expect(opts.cwd).toContain('opencode-server/one-shot');
    expect(opts.config.model).toBe('openrouter/z-ai/glm-4.7'); // haiku route → DEFAULT fallback
    expect(opts.config.mcp).toBeUndefined(); // no skills, no plugin, no MCP — one-shots never use tools
  });

  it('spawns wrapped through wrapServeCommand with the minimal profile env, homeDir created first (P3b)', async () => {
    sessionPrompt.mockResolvedValue({ data: { info: {}, parts: [{ type: 'text', text: 'ok' }] } });
    const oneShot = new OpencodeLlmOneShot();
    await oneShot.text({ model: 'haiku', prompt: 'a' });

    expect(getEgressProxyMock).toHaveBeenCalledTimes(1);
    expect(buildOneShotSandboxProfileMock).toHaveBeenCalledTimes(1);
    const profileArgs = buildOneShotSandboxProfileMock.mock.calls[0][0];
    expect(profileArgs.homeDir).toContain('opencode-server/one-shot-home');

    const opts = startEmbeddedServerMock.mock.calls[0][0];
    expect(opts.spawnOverride).toEqual({ command: 'bwrap', args: ['opencode', 'serve'] });
    expect(opts.env).toEqual(expect.objectContaining({ HOME: expect.stringContaining('one-shot-home') }));
    // I4: the profile's cwd (root) MUST be the exact dir the process is spawned
    // in — otherwise the jail binds a dir the process never runs in.
    expect(profileArgs.root).toBe(opts.cwd);
    // home is a SIBLING of root (not `<root>/home`) so opencode's cwd snapshot
    // can't recursively include the one-shot's own session store.
    expect(profileArgs.homeDir.startsWith(`${opts.cwd}/`)).toBe(false);

    // homeDir must exist on disk before the wrapped spawn (same invariant as
    // the per-agent pool — a nonexistent bind source is silently skipped).
    const mkdirOrder = fsMkdirMock.mock.invocationCallOrder[0];
    const spawnOrder = startEmbeddedServerMock.mock.invocationCallOrder[0];
    expect(mkdirOrder).toBeLessThan(spawnOrder);
  });

  it('closeOneShotServe closes the child and a later call re-boots', async () => {
    sessionPrompt.mockResolvedValue({ data: { info: {}, parts: [{ type: 'text', text: 'ok' }] } });
    const oneShot = new OpencodeLlmOneShot();
    await oneShot.text({ model: 'haiku', prompt: 'a' });
    await closeOneShotServe();
    expect(fakeServer.close).toHaveBeenCalledTimes(1);
    await oneShot.text({ model: 'haiku', prompt: 'b' });
    expect(startEmbeddedServerMock).toHaveBeenCalledTimes(2);
  });

  it('revokes the one-shot proxy credential in closeOneShotServe', async () => {
    sessionPrompt.mockResolvedValue({ data: { info: {}, parts: [{ type: 'text', text: 'ok' }] } });
    const oneShot = new OpencodeLlmOneShot();
    await oneShot.text({ model: 'haiku', prompt: 'a' });
    await closeOneShotServe();
    expect(revokeCredentialMock).toHaveBeenCalledWith({ username: 'one-shot-u', password: 'one-shot-p' });
  });

  it('revokes the minted credential when the boot throws AFTER minting (M1 — mirrors bootChild)', async () => {
    startEmbeddedServerMock.mockRejectedValueOnce(new Error('spawn boom'));
    const oneShot = new OpencodeLlmOneShot();
    // text() swallows the boot rejection and returns null; the credential minted
    // for this failed boot must still be revoked so it doesn't leak.
    expect(await oneShot.text({ model: 'haiku', prompt: 'a' })).toBeNull();
    expect(revokeCredentialMock).toHaveBeenCalledWith({ username: 'one-shot-u', password: 'one-shot-p' });
  });

  it('aborts an in-flight boot if close() lands mid-boot, even after a newer boot has since started (generation token)', async () => {
    sessionPrompt.mockResolvedValue({ data: { info: {}, parts: [{ type: 'text', text: 'ok' }] } });
    const oneShot = new OpencodeLlmOneShot();

    let resolveBootA!: (server: typeof fakeServer) => void;
    const bootADeferred = new Promise<typeof fakeServer>((resolve) => { resolveBootA = resolve; });
    const serverA = { ...fakeServer, close: vi.fn() };
    const serverB = { ...fakeServer, close: vi.fn() };
    startEmbeddedServerMock.mockImplementationOnce(async () => bootADeferred);
    startEmbeddedServerMock.mockImplementationOnce(async () => serverB);

    // Boot A starts and blocks inside startEmbeddedServer (deferred, not yet resolved).
    const bootAPromise = oneShot.text({ model: 'haiku', prompt: 'a' });

    // Reviewer's interleaving: close() runs (and bumps the generation token) while
    // boot A is still awaiting startEmbeddedServer — do NOT await close() yet.
    const closePromise = closeOneShotServe();

    // A newer caller (boot B) starts after close() has nulled servePromise; its
    // startEmbeddedServer resolves immediately, so boot B completes in full.
    await oneShot.text({ model: 'haiku', prompt: 'b' });
    expect(startEmbeddedServerMock).toHaveBeenCalledTimes(2);

    // Now let boot A's startEmbeddedServer resolve — it must self-abort instead of
    // handing its (now-stale) server to caller A, because the generation moved on
    // under it while it was still spawning.
    resolveBootA(serverA);
    await expect(bootAPromise).resolves.toBeNull();
    await closePromise;

    expect(serverA.close).toHaveBeenCalledTimes(1); // boot A closed its own stale server
    expect(serverB.close).not.toHaveBeenCalled(); // boot B's server is untouched

    // Adjacent hole: boot A's failure-path catch must NOT null the singleton that
    // now points at boot B — a later call must reuse B's live server (no third
    // boot, no orphaned/leaked B child).
    await oneShot.text({ model: 'haiku', prompt: 'c' });
    expect(startEmbeddedServerMock).toHaveBeenCalledTimes(2); // still only A + B
    expect(serverB.close).not.toHaveBeenCalled(); // B stays live and reachable
  });
});

describe('OpencodeLlmOneShot.json', () => {
  it('parses a JSON object and instructs the model with the schema', async () => {
    sessionPrompt.mockResolvedValue({ data: { info: {}, parts: [{ type: 'text', text: '{"title":"X"}' }] } });
    const out = await shot.json({ prompt: 'make a title', model: MODEL, jsonSchema: { type: 'object' } });
    expect(out).toEqual({ title: 'X' });
    const sentText = sessionPrompt.mock.calls[0][0].body.parts[0].text;
    expect(sentText).toContain('JSON Schema');
    expect(sentText).toContain('"type":"object"');
  });

  it('strips code fences before parsing', async () => {
    sessionPrompt.mockResolvedValue({ data: { info: {}, parts: [{ type: 'text', text: '```json\n{"a":1}\n```' }] } });
    expect(await shot.json({ prompt: 'p', model: MODEL, jsonSchema: {} })).toEqual({ a: 1 });
  });

  it('returns null on unparseable output', async () => {
    sessionPrompt.mockResolvedValue({ data: { info: {}, parts: [{ type: 'text', text: 'not json' }] } });
    expect(await shot.json({ prompt: 'p', model: MODEL, jsonSchema: {} })).toBeNull();
  });
});
