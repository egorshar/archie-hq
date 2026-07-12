/**
 * Cooperative egress proxy for opencode serve children (P3b). One loopback
 * CONNECT/HTTP proxy per process (singleton, like getBridge). Each child gets a
 * per-child credential selecting a hardcoded, orchestrator-controlled host
 * allowlist (provider + git host + registries + declared MCP hosts); the child
 * is steered here via forced HTTP(S)_PROXY env. This is a COOPERATIVE boundary:
 * honest tooling (Bun fetch, npm, curl, git) honors proxy env, so all normal
 * traffic is filtered — a deliberately malicious bash could still open direct
 * TCP (kernel-enforced egress via --unshare-net is a tracked follow-up).
 * Never logs credentials; denials log {taskId, agentId, host} only.
 */
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect, type Socket } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { logger } from '../../system/logger.js';

export interface EgressCredential { username: string; password: string; }
interface CredEntry { password: string; allowlist: string[]; identity: { taskId: string; agentId: string }; }

export interface EgressProxyHandle {
  url: string;
  mintCredential(identity: { taskId: string; agentId: string }, allowlist: string[]): EgressCredential;
  revokeCredential(cred: EgressCredential): void;
  close(): Promise<void>;
}

/** Exact host, dot-suffix subdomain, or an explicit `host:port` allowlist entry.
 * Bare entries permit ports 443 and 80 only. */
// Allowlist entries we've already warned about being unsupported, so the warn
// fires once per distinct bad entry rather than on every request that carries it.
const warnedUnsupportedEntries = new Set<string>();

/**
 * Whether an egress target is permitted by an allowlist.
 *
 * CONTRACT — allowlist entries are DNS HOSTNAMES, optionally with a single
 * `:port` suffix (`example.com`, or `mcp.example.com:8443`). Matching is exact
 * host or dot-suffix subdomain; a bare entry permits ports 443/80, a `host:port`
 * entry permits exactly that pair. IP LITERALS ARE NOT SUPPORTED as entries:
 * an IPv6 literal (`::1`), a bracketed host (`[::1]:8443`), or any entry with
 * more than one `:` is unsupported — it is warn-logged once and skipped (never
 * split into a garbage entry by the naive `:`-split below). As a consequence an
 * IP-literal CONNECT *target* (v4 or v6) matches no hostname entry and is denied
 * by default — the intended fail-closed behavior. This is deliberately
 * hostname-only; no IPv6 parsing.
 */
export function hostAllowed(host: string, port: number, allowlist: string[]): boolean {
  const h = host.toLowerCase();
  for (const raw of allowlist) {
    const entry0 = raw.trim();
    // Reject unsupported entry shapes (IP literals / IPv6 / bracketed hosts)
    // rather than silently mangling them via split(':'): a bracketed host or an
    // entry with >1 colon can never be a valid `hostname[:port]`.
    if (entry0.startsWith('[') || entry0.indexOf(':') !== entry0.lastIndexOf(':')) {
      if (!warnedUnsupportedEntries.has(entry0)) {
        warnedUnsupportedEntries.add(entry0);
        logger.warn('opencode', `egress allowlist entry ignored — unsupported shape (hostnames only, no IP literals / IPv6 / bracketed hosts): ${entry0}`);
      }
      continue;
    }
    const [entry, entryPort] = entry0.toLowerCase().split(':');
    const hostMatch = h === entry || h.endsWith('.' + entry);
    if (!hostMatch) continue;
    if (entryPort) { if (port === Number(entryPort)) return true; }
    else if (port === 443 || port === 80) return true;
  }
  return false;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

let proxyPromise: Promise<EgressProxyHandle> | null = null;

export function getEgressProxy(): Promise<EgressProxyHandle> {
  if (!proxyPromise) {
    proxyPromise = startProxy().catch((err) => { proxyPromise = null; throw err; });
  }
  return proxyPromise;
}

export async function closeEgressProxy(): Promise<void> {
  if (!proxyPromise) return;
  const p = proxyPromise;
  proxyPromise = null;
  const handle = await p.catch(() => null);
  if (handle) await handle.close();
}

function parseAuth(header: string | undefined): { username: string; password: string } | null {
  if (!header || !header.startsWith('Basic ')) return null;
  const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  if (i < 0) return null;
  return { username: decoded.slice(0, i), password: decoded.slice(i + 1) };
}

function startProxy(): Promise<EgressProxyHandle> {
  const creds = new Map<string, CredEntry>(); // username -> entry

  /** Resolve + auth a request's credential, returning its allowlist or null. */
  const authorize = (header: string | undefined): CredEntry | null => {
    const parsed = parseAuth(header);
    if (!parsed) return null;
    const entry = creds.get(parsed.username);
    if (!entry || !safeEqual(entry.password, parsed.password)) return null;
    return entry;
  };

  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      // Guard against a peer reset firing 'error' with no listener attached
      // (would otherwise crash the process — see Task 1 spike finding).
      let up: ReturnType<typeof httpRequest> | null = null;
      req.on('error', () => up?.destroy());
      res.on('error', () => up?.destroy());
      // Absolute-URI plain HTTP proxying.
      const entry = authorize(req.headers['proxy-authorization']);
      if (!entry) { res.writeHead(407, { 'proxy-authenticate': 'Basic' }); res.end(); return; }
      let target: URL;
      try { target = new URL(req.url ?? ''); } catch { res.writeHead(400); res.end(); return; }
      const port = Number(target.port) || 80;
      if (!hostAllowed(target.hostname, port, entry.allowlist)) {
        logger.warn('opencode', `egress DENY (http) ${entry.identity.taskId}:${entry.identity.agentId} → ${target.hostname}:${port}`);
        res.writeHead(403); res.end('egress not permitted'); return;
      }
      // Strip the hop-by-hop proxy headers before forwarding upstream — the
      // per-child Basic credential in Proxy-Authorization must never reach the
      // origin server.
      const fwdHeaders = { ...req.headers };
      delete fwdHeaders['proxy-authorization'];
      delete fwdHeaders['proxy-connection'];
      up = httpRequest({ host: target.hostname, port, path: target.pathname + target.search, method: req.method, headers: fwdHeaders }, (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers); upRes.pipe(res);
      });
      up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(up);
    });

    // CONNECT (HTTPS tunneling) — allowlist by target host, no TLS interception.
    server.on('connect', (req: IncomingMessage, clientSock: Socket, head: Buffer) => {
      // Attach before any write so a peer reset during the handshake (even on
      // the 407/403 denial paths) never crashes the process (see Task 1 spike
      // finding: an unhandled ECONNRESET on this socket took the process down).
      let upstream: Socket | null = null;
      clientSock.on('error', () => upstream?.destroy());
      const entry = authorize(req.headers['proxy-authorization']);
      if (!entry) { clientSock.write('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\n\r\n'); clientSock.end(); return; }
      const [host, portStr] = (req.url ?? '').split(':');
      const port = Number(portStr) || 443;
      if (!hostAllowed(host, port, entry.allowlist)) {
        logger.warn('opencode', `egress DENY (connect) ${entry.identity.taskId}:${entry.identity.agentId} → ${host}:${port}`);
        clientSock.write('HTTP/1.1 403 Forbidden\r\n\r\n'); clientSock.end(); return;
      }
      upstream = connect(port, host, () => {
        clientSock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream!.write(head);
        upstream!.pipe(clientSock); clientSock.pipe(upstream!);
      });
      upstream.on('error', () => { if (!clientSock.destroyed) { clientSock.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'); clientSock.end(); } });
    });

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        mintCredential: (identity, allowlist) => {
          const username = randomBytes(9).toString('hex');
          const password = randomBytes(24).toString('hex');
          creds.set(username, { password, allowlist, identity });
          return { username, password };
        },
        revokeCredential: (cred) => { creds.delete(cred.username); },
        close: () => new Promise<void>((res2, rej2) => server.close((e) => (e ? rej2(e) : res2()))),
      });
    });
  });
}
