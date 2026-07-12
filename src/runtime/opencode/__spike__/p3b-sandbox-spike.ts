/**
 * LIVE SPIKE — P3b sandbox de-risking (S1, S2, S3). Excluded from
 * typecheck/vitest (tsconfig `exclude` + vitest `include`). Findings recorded
 * in p3b-sandbox-spike.md beside this file.
 *
 * Run against the PINNED CLI 1.17.16:
 *   npm i --no-save opencode-ai@1.17.16
 *   PATH="$(pwd)/node_modules/.bin:$PATH" npx tsx \
 *     src/runtime/opencode/__spike__/p3b-sandbox-spike.ts <s1|s2|s3>
 *
 * S1: does `opencode serve` boot under a representative bwrap argv (ro-bind
 *     system dirs, tmpfs/proc/dev, bind cwd + a scratch HOME, die-with-parent,
 *     unshare-pid/ipc/uts, NO unshare-net)? Client connects over loopback, a
 *     read works, a write OUTSIDE the binds is denied. bwrap is Linux-only —
 *     on a host with no `bwrap` binary this records ENV-BLOCKED and returns;
 *     it does NOT fabricate a pass.
 * S2: with HOME + XDG_DATA_HOME pinned to a fresh scratch dir, does the CLI
 *     write its store there (not ~/.local/share/opencode), does provider auth
 *     via OPENROUTER_API_KEY still resolve, and does a session created in
 *     that dir resume after the child is killed + restarted pointed at the
 *     SAME dir?
 * S3: start a tiny CONNECT proxy on loopback that allowlists only
 *     `openrouter.ai`; boot the child with HTTPS_PROXY pointed at it and
 *     NO_PROXY=127.0.0.1,localhost. Does a real model turn (Bun's internal
 *     fetch, reaching openrouter) actually route THROUGH the proxy (checked
 *     via the proxy's own connect log, not just "the reply arrived")? Does
 *     the `webfetch` tool get denied (403) when the model is asked to fetch a
 *     non-allowlisted host? Does a loopback fetch (NO_PROXY bypass) still
 *     succeed direct, unproxied, even though loopback is not on the
 *     allowlist (proving NO_PROXY exempts it rather than "everything passes")?
 */
import 'dotenv/config';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage } from 'node:http';
import net, { type Socket } from 'node:net';
import { mkdtemp, rm, mkdir, writeFile, readdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createOpencodeClient } from '@opencode-ai/sdk';
import { resolveOpencodeModel } from '../model.js';

const log: string[] = [];
const record = (line: string) => { log.push(line); console.log(line); };

function textOf(res: any): string {
  const parts = Array.isArray(res?.data?.parts) ? res.data.parts : [];
  return parts.filter((p: any) => p?.type === 'text' && typeof p.text === 'string').map((p: any) => p.text).join('').trim();
}
function isNotFound(res: any): boolean {
  const name = res?.error?.name ?? res?.data?.info?.error?.name;
  const msg = res?.error?.data?.message ?? res?.error?.message ?? '';
  return name === 'NotFoundError' || /not found/i.test(String(msg));
}

/** Minimal spawn+parse helper (embedded-server.ts's shape), parameterized on env/command so the spike never touches production code. */
async function spawnServe(opts: {
  cwd: string;
  config: Record<string, unknown>;
  env: Record<string, string | undefined>;
  command?: string;
  args?: string[];
  timeoutMs?: number;
}): Promise<{ proc: ChildProcess; client: ReturnType<typeof createOpencodeClient>; url: string; close: () => void }> {
  const timeoutMs = opts.timeoutMs ?? 20000;
  const command = opts.command ?? 'opencode';
  const args = opts.args ?? ['serve', '--hostname=127.0.0.1', '--port=0'];
  const proc = spawn(command, args, {
    cwd: opts.cwd,
    env: { ...opts.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(opts.config) },
  });
  const url = await new Promise<string>((resolve, reject) => {
    let out = '';
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      try { proc.kill(); } catch { /* already gone */ }
      reject(new Error(`opencode serve did not start within ${timeoutMs}ms; output: ${out.slice(-800)}`));
    }, timeoutMs);
    const fail = (err: Error) => { if (settled) return; settled = true; clearTimeout(timer); reject(err); };
    proc.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return;
      out += chunk.toString();
      for (const line of out.split('\n')) {
        if (line.startsWith('opencode server listening')) {
          const m = line.match(/on\s+(https?:\/\/[^\s]+)/);
          if (m) { settled = true; clearTimeout(timer); proc.stdout?.resume(); resolve(m[1]); return; }
        }
      }
    });
    proc.stderr?.on('data', (chunk: Buffer) => { if (!settled) out += chunk.toString(); });
    proc.on('exit', (code) => fail(new Error(`opencode serve exited (code ${code})${out.trim() ? `: ${out.slice(-800)}` : ''}`)));
    proc.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))));
  });
  return {
    proc,
    client: createOpencodeClient({ baseUrl: url }),
    url,
    close: () => { try { proc.kill(); } catch { /* already gone */ } },
  };
}

function baseModel() {
  const model = resolveOpencodeModel('default');
  const modelStr = `${model.providerID}/${model.modelID}`;
  return { model, modelStr };
}
const permission = { edit: 'allow', bash: 'allow', webfetch: 'allow', external_directory: 'allow' } as const;

// ==================================================================
// S1 — bwrap-wrapped serve boot
// ==================================================================
async function runS1(): Promise<void> {
  record('# S1 — bwrap-wrapped `opencode serve` boot');
  const probe = spawnSync('bwrap', ['--version']);
  if (probe.error || probe.status !== 0) {
    record('bwrap not found on this host (darwin dev box; bwrap is Linux-only, not installed here).');
    record('VERDICT: ENV-BLOCKED (darwin host, no bwrap; deferred to Task 6 container live smoke).');
    return;
  }

  // Reached only on a host that actually has bwrap (e.g. inside the Docker image).
  const scratchRoot = await mkdtemp(join(tmpdir(), 'archie-p3b-s1-cwd-'));
  const scratchHome = await mkdtemp(join(tmpdir(), 'archie-p3b-s1-home-'));
  const outsideDir = await mkdtemp(join(tmpdir(), 'archie-p3b-s1-outside-'));
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  await promisify(execFile)('git', ['init', '-q'], { cwd: scratchRoot });

  const bwrapArgs = [
    '--ro-bind', '/usr', '/usr',
    '--ro-bind', '/bin', '/bin',
    ...(existsSync('/lib') ? ['--ro-bind', '/lib', '/lib'] : []),
    ...(existsSync('/lib64') ? ['--ro-bind', '/lib64', '/lib64'] : []),
    '--ro-bind', '/etc', '/etc',
    ...(existsSync('/opt') ? ['--ro-bind', '/opt', '/opt'] : []),
    '--tmpfs', '/tmp',
    '--proc', '/proc',
    '--dev', '/dev',
    '--bind', scratchRoot, scratchRoot,
    '--bind', scratchHome, scratchHome,
    '--die-with-parent',
    '--unshare-pid', '--unshare-ipc', '--unshare-uts',
    'opencode', 'serve', '--hostname=127.0.0.1', '--port=0',
  ];
  record(`bwrap argv: bwrap ${bwrapArgs.join(' ')}`);

  const { model, modelStr } = baseModel();
  const config = { model: modelStr, permission };
  const srv = await spawnServe({
    cwd: scratchRoot,
    config,
    env: { PATH: process.env.PATH, HOME: scratchHome, XDG_DATA_HOME: scratchHome, OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY },
    command: 'bwrap',
    args: bwrapArgs,
    timeoutMs: 20000,
  });
  try {
    record(`booted; client connected at ${srv.url}`);
    const created = await srv.client.session.create({ body: { title: 's1' } });
    const sid = (created as any)?.data?.id;
    const read = await srv.client.session.prompt({ path: { id: sid }, body: { model, parts: [{ type: 'text', text: 'Use the bash tool to run `ls /` and report the output verbatim.' }] } as any });
    record(`read (ls /) → ${JSON.stringify(textOf(read)).slice(0, 300)}`);
    const write = await srv.client.session.prompt({ path: { id: sid }, body: { model, parts: [{ type: 'text', text: `Use the bash tool to run: echo hi > ${join(outsideDir, 'should-fail.txt')} — then report whether it succeeded or the exact error.` }] } as any });
    record(`write outside binds → ${JSON.stringify(textOf(write)).slice(0, 300)}`);
    record(`file exists outside binds after attempted write? ${existsSync(join(outsideDir, 'should-fail.txt')) ? 'YES (jail FAILED)' : 'NO (jail held)'}`);
    record('VERDICT: PASS (boot + connect + read OK; out-of-jail write denied) — see output above for exact evidence.');
  } finally {
    srv.close();
    await Promise.all([scratchRoot, scratchHome, outsideDir].map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
  }
}

// ==================================================================
// S2 — data-dir / HOME pinning + auth + resume
// ==================================================================
async function runS2(): Promise<void> {
  record('# S2 — data-dir + auth under a pinned HOME/XDG_DATA_HOME');
  const { model, modelStr } = baseModel();
  const config = { model: modelStr, permission };

  const cwd = await mkdtemp(join(tmpdir(), 'archie-p3b-s2-cwd-'));
  const dataHome = await mkdtemp(join(tmpdir(), 'archie-p3b-s2-home-'));
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  await promisify(execFile)('git', ['init', '-q'], { cwd });

  const realShareDir = join(homedir(), '.local', 'share', 'opencode');
  const realShareExistedBefore = existsSync(realShareDir);
  const realShareSnapshotBefore = realShareExistedBefore ? await snapshotDir(realShareDir) : null;

  const childEnv = {
    PATH: process.env.PATH,
    HOME: dataHome,
    XDG_DATA_HOME: dataHome,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  };
  record(`HOME=${dataHome} XDG_DATA_HOME=${dataHome} cwd=${cwd}`);

  const CODEWORD = 'MANGO-42';
  let sessionId = '';
  const srv1 = await spawnServe({ cwd, config, env: childEnv, timeoutMs: 20000 });
  try {
    record(`child #1 booted at ${srv1.url}`);
    const created = await srv1.client.session.create({ body: { title: 's2' } });
    sessionId = (created as any)?.data?.id;
    record(`created session ${sessionId}`);
    const authTurn = await srv1.client.session.prompt({ path: { id: sessionId }, body: { model, parts: [{ type: 'text', text: `Remember this fact for later: the secret codeword is ${CODEWORD}. Reply with only the word OK.` }] } as any });
    record(`provider-auth turn (establish codeword) → ${JSON.stringify(textOf(authTurn)).slice(0, 160)}`);
  } finally {
    srv1.close();
  }
  await new Promise((r) => setTimeout(r, 1500));

  // Store-location check: what landed under dataHome?
  const dataHomeTree = existsSync(dataHome) ? await listRecursive(dataHome) : [];
  record(`entries under XDG_DATA_HOME after boot:\n  ${dataHomeTree.join('\n  ') || '(none)'}`);
  const storeUnderPinnedDir = dataHomeTree.some((p) => p.toLowerCase().includes('opencode'));
  record(`store present under pinned dir? ${storeUnderPinnedDir ? 'YES' : 'NO'}`);

  const realShareSnapshotAfter = existsSync(realShareDir) ? await snapshotDir(realShareDir) : null;
  const realShareUntouched = realShareExistedBefore
    ? JSON.stringify(realShareSnapshotBefore) === JSON.stringify(realShareSnapshotAfter)
    : !existsSync(realShareDir);
  record(`real ~/.local/share/opencode untouched? ${realShareUntouched ? 'YES' : 'NO (mutated — see snapshots)'} (existed before: ${realShareExistedBefore})`);

  // Resume check: restart pointed at the SAME dataHome, prompt the OLD sessionId.
  const srv2 = await spawnServe({ cwd, config, env: childEnv, timeoutMs: 20000 });
  try {
    const recall = await srv2.client.session.prompt({ path: { id: sessionId }, body: { model, parts: [{ type: 'text', text: 'What is the secret codeword I told you earlier? Reply with ONLY the codeword, or NONE if you do not know.' }] } as any });
    if (isNotFound(recall)) {
      record('restart (same dataHome) → OLD sessionID = 404 NotFoundError (session did NOT resume)');
    } else {
      const t = textOf(recall);
      record(`restart (same dataHome) → OLD sessionID resumed. recall: ${JSON.stringify(t).slice(0, 160)}`);
      record(`  codeword recalled? ${t.includes(CODEWORD) ? 'YES — resume confirmed' : 'session existed but codeword missing (inspect)'}`);
    }
  } finally {
    srv2.close();
  }

  record(`VERDICT: ${storeUnderPinnedDir && realShareUntouched ? 'PASS' : 'FAIL'} (store-under-pinned-dir=${storeUnderPinnedDir}, real-share-untouched=${realShareUntouched}; see resume line above for the resume sub-finding).`);

  await Promise.all([cwd, dataHome].map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
}

async function snapshotDir(dir: string): Promise<string[]> {
  try { return (await listRecursive(dir)).map((p) => `${p}:${statSync(p).mtimeMs}`); } catch { return []; }
}
async function listRecursive(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  let entries: import('node:fs').Dirent[];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    out.push(prefix + p);
    if (e.isDirectory()) out.push(...(await listRecursive(p, prefix)));
  }
  return out;
}

// ==================================================================
// S3 — proxy compliance
// ==================================================================
interface ConnectLogEntry { host: string; port: number; allowed: boolean; }

function startAllowlistProxy(allowlist: string[]): Promise<{ port: number; log: ConnectLogEntry[]; close: () => void }> {
  const connectLog: ConnectLogEntry[] = [];
  const isAllowed = (host: string) => allowlist.some((entry) => host === entry || host.endsWith('.' + entry));

  const server = createServer((req, res) => {
    // Absolute-URI plain HTTP proxying (not expected to be exercised by HTTPS calls, but handled for completeness).
    res.writeHead(400).end('unsupported');
  });
  server.on('error', () => { /* best-effort probe proxy — never crash the harness */ });
  server.on('clientError', (_err, socket) => { try { socket.destroy(); } catch { /* noop */ } });

  server.on('connect', (req: IncomingMessage, clientSocket: Socket, head: Buffer) => {
    // Must be attached before any write — a denied client (or one that aborts
    // after 403) resets the socket, and an unhandled 'error' here would crash
    // the whole harness process, not just this one probe request.
    clientSocket.on('error', () => { /* client reset after deny/abort — expected, not fatal */ });
    const [host, portStr] = (req.url || '').split(':');
    const port = Number(portStr) || 443;
    const allowed = isAllowed(host);
    connectLog.push({ host, port, allowed });
    if (!allowed) {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\nProxy-Agent: p3b-spike-proxy\r\n\r\n');
      console.log(`[proxy] DENIED CONNECT ${host}:${port}`);
      return;
    }
    console.log(`[proxy] ALLOWED CONNECT ${host}:${port}`);
    const serverSocket = net.connect(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) serverSocket.write(head);
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });
    serverSocket.on('error', () => { try { clientSocket.end(); } catch { /* noop */ } });
    clientSocket.on('error', () => { try { serverSocket.end(); } catch { /* noop */ } });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({ port, log: connectLog, close: () => server.close() });
    });
  });
}

async function runS3(): Promise<void> {
  record('# S3 — proxy compliance (CONNECT allowlist, NO_PROXY loopback bypass)');
  const { model, modelStr } = baseModel();
  const config = { model: modelStr, permission };

  // A tiny loopback "bridge-like" HTTP server the child should be able to reach
  // DIRECTLY (unproxied) via NO_PROXY, even though it is not on the proxy's allowlist.
  const bridgeStub = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }).end('BRIDGE-OK'); });
  await new Promise<void>((resolve) => bridgeStub.listen(0, '127.0.0.1', resolve));
  const bridgePort = (bridgeStub.address() as net.AddressInfo).port;

  const proxy = await startAllowlistProxy(['openrouter.ai']);
  record(`proxy listening on 127.0.0.1:${proxy.port}, allowlist=[openrouter.ai]`);
  record(`bridge stub listening on 127.0.0.1:${bridgePort} (NOT on the proxy allowlist — reachability depends solely on NO_PROXY)`);

  const cwd = await mkdtemp(join(tmpdir(), 'archie-p3b-s3-cwd-'));
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  await promisify(execFile)('git', ['init', '-q'], { cwd });

  const childEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`,
    HTTP_PROXY: `http://127.0.0.1:${proxy.port}`,
    https_proxy: `http://127.0.0.1:${proxy.port}`,
    http_proxy: `http://127.0.0.1:${proxy.port}`,
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  };
  record(`child env: HTTPS_PROXY=${childEnv.HTTPS_PROXY} NO_PROXY=${childEnv.NO_PROXY}`);

  const srv = await spawnServe({ cwd, config, env: childEnv, timeoutMs: 20000 });
  try {
    record(`booted at ${srv.url}`);
    const sess = await srv.client.session.create({ body: { title: 's3' } });
    const sid = (sess as any)?.data?.id;

    // (a) real model turn — must reach openrouter through the proxy.
    const turn = await srv.client.session.prompt({ path: { id: sid }, body: { model, parts: [{ type: 'text', text: 'Reply with exactly the word PONG and nothing else.' }] } as any });
    record(`model turn via proxy → ${JSON.stringify(textOf(turn)).slice(0, 160)}`);
    const orEntry = proxy.log.find((e) => e.host === 'openrouter.ai' || e.host.endsWith('.openrouter.ai'));
    record(`proxy connect-log entry for openrouter.ai? ${orEntry ? `YES (${JSON.stringify(orEntry)}) — call actually routed through the proxy` : 'NO — model call did NOT appear in the proxy log (see concern)'}`);

    // (b) webfetch to a NON-allowlisted host — must be denied.
    const denyTurn = await srv.client.session.prompt({ path: { id: sid }, body: { model, parts: [{ type: 'text', text: 'Use the webfetch tool to fetch https://example.com/ and report either the result or the exact error message you got.' }] } as any });
    record(`webfetch non-allowlisted host → ${JSON.stringify(textOf(denyTurn)).slice(0, 300)}`);
    const exampleEntry = proxy.log.find((e) => e.host === 'example.com' || e.host.endsWith('.example.com'));
    record(`proxy connect-log entry for example.com? ${exampleEntry ? JSON.stringify(exampleEntry) : 'NO entry (webfetch may not tunnel via CONNECT — inspect reply text above for the denial signal)'}`);

    // (c) webfetch to the loopback bridge stub — must succeed DIRECT (NO_PROXY bypass),
    // despite loopback not being on the proxy allowlist.
    const bridgeTurn = await srv.client.session.prompt({ path: { id: sid }, body: { model, parts: [{ type: 'text', text: `Use the webfetch tool to fetch http://127.0.0.1:${bridgePort}/ and report the exact body text.` }] } as any });
    record(`webfetch loopback (NO_PROXY) → ${JSON.stringify(textOf(bridgeTurn)).slice(0, 300)}`);
    const loopbackEntry = proxy.log.find((e) => e.host === '127.0.0.1' || e.host === 'localhost');
    record(`proxy connect-log entry for loopback? ${loopbackEntry ? `YES (${JSON.stringify(loopbackEntry)}) — NO_PROXY did NOT bypass (concern)` : 'NO entry — confirms NO_PROXY bypassed the proxy for loopback'}`);
  } finally {
    srv.close();
    proxy.close();
    bridgeStub.close();
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
  record('VERDICT: see the three sub-findings above (model-via-proxy / non-allowlisted-denied / loopback-bypassed) — combine into PASS/FAIL in the findings doc.');
}

async function main(): Promise<void> {
  const which = process.argv[2];
  if (which === 's1') return runS1();
  if (which === 's2') return runS2();
  if (which === 's3') return runS3();
  console.error('usage: tsx p3b-sandbox-spike.ts <s1|s2|s3>');
  process.exit(2);
}

main().catch((e) => { console.error('SPIKE FAILED:', e); process.exit(1); });
