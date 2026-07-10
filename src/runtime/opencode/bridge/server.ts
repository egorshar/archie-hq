/**
 * opencode tool bridge — Archie-side HTTP listener.
 *
 * opencode's server runs as a child process; Archie's typed control tools,
 * the research tool, and repo-host (git/PR) tools (all of which close over
 * the live in-memory `Task`/`Agent`) are reached from an opencode plugin via
 * this localhost-only bridge. The plugin POSTs `{ sessionId, tool, args }` to
 * `/tool`; the bridge resolves the session in the `SessionRegistry`,
 * dispatches to one of a FIXED whitelist built from the 3 control-tool
 * handlers, the `web_research` handler (`createResearchToolHandler`, from
 * `src/mcp/research-tools.ts` — folds in the budget check, persistence, and
 * defense-tag wrapping the Claude path spreads across the tool + 2
 * PostToolUse hooks), and the session's repo-tool handlers
 * (`createRepoToolHandlers`, from `src/agents/tools.ts` — the same handler
 * bodies the Claude-path SDK MCP server uses), and returns `{ ok: true,
 * result }` or `{ ok: false, error }`. `result` is the tool's `ToolResult`
 * unwrapped to a plain string (opencode's custom-tool `execute` must return a
 * string, not a JSON object).
 *
 * Read-only enforcement (defense in depth, layer 2 — layer 1 is the opencode
 * plugin's `tool.execute.before` guard blocking built-in write tools):
 * `POST /tool` rejects any tool name in `WRITE_REPO_TOOLS` for a session whose
 * registry entry has `readOnly: true`, BEFORE the handler ever runs. The
 * `GET /tools` manifest is NOT session-scoped — opencode's plugin fetches it
 * once at plugin load, before any session exists — so it always lists every
 * repo tool (including writes); RO enforcement lives entirely in the dispatch
 * rejection below, not in what the manifest advertises.
 *
 * Security: binds to 127.0.0.1 only, requires a bearer token (constant-time
 * compared) on every request (including `GET /tools`), and dispatches ONLY
 * whitelisted tool names via `Map`/`Object.hasOwn` own-key lookups — never an
 * arbitrary function, never a prototype-chain fallthrough. Never logs the
 * token, prompt content, or tool args.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { randomBytes, timingSafeEqual } from 'crypto';
import type { AddressInfo } from 'net';
import { z } from 'zod';
import {
  postToUserHandler,
  reportCompletionHandler,
  requestEditModeHandler,
  createRepoToolHandlers,
  WRITE_REPO_TOOLS,
  REPO_TOOL_SPECS,
  type PostToUserArgs,
  type ReportCompletionArgs,
  type RequestEditModeArgs,
  type ToolResult,
} from '../../../agents/tools.js';
import { createResearchToolHandler } from '../../../mcp/research-tools.js';
import type { Agent } from '../../../agents/agent.js';
import type { Task } from '../../../tasks/task.js';
import type { SessionRegistry, BridgeSession } from './registry.js';
import { logger } from '../../../system/logger.js';

export interface BridgeHandle {
  url: string;
  token: string;
  close(): Promise<void>;
}

/** JSON-serializable descriptor of a single arg: its primitive kind + whether it's optional. */
interface ArgSpec {
  type: 'string' | 'object' | 'number' | 'boolean';
  optional?: boolean;
}

/** JSON-serializable descriptor of a tool's args shape: argName -> spec. */
type ArgsSchema = Record<string, ArgSpec>;

interface ToolDescriptor {
  name: string;
  description: string;
  argsSchema: ArgsSchema;
}

type ToolHandler = (agent: Agent, task: Task, args: any) => Promise<ToolResult>;

// FIXED whitelist — the bridge will never dispatch anything outside this map.
// A Map (not a plain object) is used deliberately: bracket/property access on a
// plain object falls through to Object.prototype, so tool names like
// "constructor", "toString", or "__proto__" would resolve to truthy, callable
// functions and bypass the "unknown tool" rejection. Map has no such fallthrough.
const TOOL_WHITELIST: Map<string, ToolHandler> = new Map([
  ['post_to_user', postToUserHandler as ToolHandler],
  ['report_completion', reportCompletionHandler as ToolHandler],
  ['request_edit_mode', requestEditModeHandler as ToolHandler],
]);

// Required/optional shape mirrors the real zod schemas in src/agents/tools.ts
// EXACTLY (postToUserArgsSchema, reportCompletionArgsSchema,
// requestEditModeArgsSchema) — keep these in sync if those schemas change.
const TOOL_DESCRIPTORS: ToolDescriptor[] = [
  {
    name: 'post_to_user',
    description: 'Send a message to the user.',
    argsSchema: {
      message: { type: 'string' },
      target: { type: 'object', optional: true },
    } satisfies Record<keyof PostToUserArgs, ArgSpec>,
  },
  {
    name: 'report_completion',
    description: 'Finish your turn: signal you have responded and are now waiting only on the user.',
    argsSchema: {
      message: { type: 'string', optional: true },
    } satisfies Record<keyof ReportCompletionArgs, ArgSpec>,
  },
  {
    name: 'request_edit_mode',
    description: 'Request permission to make code changes.',
    argsSchema: {
      reason: { type: 'string' },
      channel: { type: 'string', optional: true },
    } satisfies Record<keyof RequestEditModeArgs, ArgSpec>,
  },
  {
    name: 'web_research',
    description: 'Research a topic using web search. Classifies query complexity and delegates to the appropriate search engine. Returns findings as markdown. Use for any task requiring up-to-date information from the internet.',
    argsSchema: {
      topic: { type: 'string' },
      context: { type: 'string', optional: true },
    },
  },
];

/**
 * Derive a JSON-serializable {@link ArgSpec} from a single zod field of a
 * repo-tool's schema (`src/agents/tools.ts` `RepoToolSpec.schema`). Unwraps
 * `.optional()`/`.default()`/`.nullable()` wrappers to find the base type and
 * to determine optionality — mirrors how the hand-written `TOOL_DESCRIPTORS`
 * above describe the 3 control tools, just derived instead of hand-written
 * (the repo-tools surface is too large to keep a hand-written copy in sync).
 */
function zodFieldToArgSpec(field: z.ZodTypeAny): ArgSpec {
  const optional = field.isOptional();
  let inner: z.ZodTypeAny = field;
  while (inner instanceof z.ZodOptional || inner instanceof z.ZodDefault || inner instanceof z.ZodNullable) {
    inner = inner.unwrap() as z.ZodTypeAny;
  }
  let type: ArgSpec['type'];
  if (inner instanceof z.ZodNumber) type = 'number';
  else if (inner instanceof z.ZodBoolean) type = 'boolean';
  else if (inner instanceof z.ZodObject || inner instanceof z.ZodArray) type = 'object';
  else type = 'string';
  return optional ? { type, optional: true } : { type };
}

// Repo-tool descriptors, derived from the same `REPO_TOOL_SPECS` the Claude
// SDK MCP server and the opencode bridge dispatch both use — single source of
// truth, no hand-maintained second copy that can drift. The `/tools` manifest
// is not session-scoped (see file header), so this always lists every repo
// tool, including writes; RO enforcement lives entirely in the dispatch
// rejection in `handleToolRequest`.
//
// Computed lazily (not at module top level): this module sits in an existing
// import cycle (`tools.ts` -> `system/backends.ts` -> opencode's `llm-one-shot.ts`
// -> `server.ts` -> `bridge/server.ts` -> back to `tools.ts`), so `REPO_TOOL_SPECS`
// is not guaranteed to be populated yet at the moment this module first
// evaluates. Deferring to first call (and caching) sidesteps the ordering
// hazard entirely — by the time any HTTP request is handled, both modules
// have fully loaded.
let repoToolDescriptorsCache: ToolDescriptor[] | null = null;
function getRepoToolDescriptors(): ToolDescriptor[] {
  if (!repoToolDescriptorsCache) {
    repoToolDescriptorsCache = REPO_TOOL_SPECS.map((spec) => ({
      name: spec.name,
      description: spec.description,
      argsSchema: Object.fromEntries(
        Object.entries(spec.schema).map(([key, zodType]) => [key, zodFieldToArgSpec(zodType)]),
      ),
    }));
  }
  return repoToolDescriptorsCache;
}

/**
 * opencode built-in write-shaped tool names to block for read-only sessions.
 * A conservative superset (spike decision — b2-spike.md): the live
 * plugin-guard adversarial test (a later task) confirms/extends this against
 * opencode's actual `config.tools` enumeration. Read built-ins (`read`,
 * `grep`, `glob`, `list`, `webfetch`) are deliberately NOT included.
 */
export const RO_BUILTIN_BLOCK: readonly string[] = ['edit', 'write', 'bash', 'patch', 'multiedit', 'apply_patch'];

const MAX_BODY_BYTES = 1 * 1024 * 1024; // 1 MB — loopback-only, generous for control-tool payloads.

class BodyTooLargeError extends Error {
  constructor() {
    super('request body too large');
    this.name = 'BodyTooLargeError';
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.removeAllListeners('data');
        req.removeAllListeners('end');
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

/** Constant-time bearer-token check. Never logs the token or the header value. */
function isAuthorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers['authorization'];
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length);
  const presentedBuf = Buffer.from(presented, 'utf8');
  const tokenBuf = Buffer.from(token, 'utf8');
  if (presentedBuf.length !== tokenBuf.length) return false;
  return timingSafeEqual(presentedBuf, tokenBuf);
}

/**
 * Unwrap a `ToolResult` (`{ content: [{ type: 'text', text }] }`) to the plain
 * string opencode's custom-tool `execute` must return (spike-confirmed — a
 * JSON blob renders as-is in the model's view instead of the tool's message).
 * Joins all text parts; coerces anything unexpected to a string rather than
 * dropping it silently.
 */
function unwrapToolResult(result: ToolResult): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return String(result);
  const parts = content
    .map((part) => (part && typeof part === 'object' && typeof (part as any).text === 'string' ? (part as any).text : null))
    .filter((text): text is string => text !== null);
  if (parts.length > 0) return parts.join('\n');
  // No text parts found (unexpected shape) — coerce sensibly instead of
  // silently dropping the content.
  return JSON.stringify(result);
}

type BoundHandler = (args: unknown) => Promise<ToolResult>;

/**
 * Build the full own-key-only handler map for one session: the 3 fixed
 * control-tool handlers plus `web_research` (all bound to this session's
 * `agent`/`task`), plus the session's repo-tool handlers
 * (`createRepoToolHandlers`, already bound to `agent`/`task` — same handler
 * bodies the Claude-path SDK MCP server uses).
 * A `Map`, never a plain object, for the same prototype-fallthrough reason as
 * `TOOL_WHITELIST` above: `Object.keys(repoHandlers)` only ever yields the
 * fixed, own, enumerable tool names `createRepoToolHandlers` assigned, so
 * merging them into the `Map` cannot smuggle in a `constructor`/`__proto__`
 * style name — the eventual `handlers.has(toolName)` lookup is a real `Map`
 * lookup, not a property access that could fall through to
 * `Object.prototype`.
 */
function buildSessionHandlers(session: BridgeSession): Map<string, BoundHandler> {
  const handlers = new Map<string, BoundHandler>();
  for (const [name, handler] of TOOL_WHITELIST) {
    handlers.set(name, (args: unknown) => handler(session.agent, session.task, args));
  }
  // Every agent gets research (like the control tools above) — folds the
  // Claude-path budget/persistence/defense-tag logic into the handler itself
  // (see createResearchToolHandler's doc comment).
  handlers.set('web_research', createResearchToolHandler(session.agent, session.task));
  const repoHandlers = createRepoToolHandlers(session.agent, session.task);
  for (const name of Object.keys(repoHandlers)) {
    handlers.set(name, repoHandlers[name]!);
  }
  return handlers;
}

async function handleToolRequest(
  req: IncomingMessage,
  res: ServerResponse,
  registry: SessionRegistry,
): Promise<void> {
  let parsed: unknown;
  try {
    const raw = await readBody(req);
    parsed = JSON.parse(raw);
  } catch (e) {
    if (e instanceof BodyTooLargeError) {
      sendJson(res, 413, { ok: false, error: 'request body too large' });
      return;
    }
    sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
    return;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    sendJson(res, 400, { ok: false, error: 'request body must be a JSON object' });
    return;
  }

  const { sessionId, tool: toolName, args: rawArgs } = parsed as { sessionId?: unknown; tool?: unknown; args?: unknown };
  const args = rawArgs ?? {};

  if (typeof sessionId !== 'string' || typeof toolName !== 'string') {
    sendJson(res, 400, { ok: false, error: 'sessionId and tool must be strings' });
    return;
  }

  const session = registry.get(sessionId);
  if (!session) {
    sendJson(res, 200, { ok: false, error: `unknown session: ${sessionId}` });
    return;
  }

  // Read-only enforcement, layer 2 (see file header) — reject a write
  // repo-tool for a read-only session BEFORE it ever reaches the handler.
  if (session.readOnly && WRITE_REPO_TOOLS.includes(toolName)) {
    sendJson(res, 200, { ok: false, error: `read-only: ${toolName} not permitted` });
    return;
  }

  const handlers = buildSessionHandlers(session);
  if (!handlers.has(toolName)) {
    sendJson(res, 200, { ok: false, error: `unknown tool (not permitted): ${toolName}` });
    return;
  }
  const handler = handlers.get(toolName)!;

  try {
    const result = await handler(args);
    sendJson(res, 200, { ok: true, result: unwrapToolResult(result) });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    sendJson(res, 200, { ok: false, error: message });
  }
}

function handleToolsList(res: ServerResponse): void {
  sendJson(res, 200, [...TOOL_DESCRIPTORS, ...getRepoToolDescriptors()]);
}

/**
 * `GET /policy?sessionId=<id>` — tells the opencode plugin guard whether the
 * session is read-only and, if so, which built-in tools to block. Queried
 * (and cached) per-session by the plugin's `tool.execute.before` hook rather
 * than looked up locally, because the plugin runs in the opencode server
 * child and never sees Archie's in-memory `SessionRegistry`.
 */
function handlePolicyRequest(req: IncomingMessage, res: ServerResponse, registry: SessionRegistry): void {
  const url = new URL(req.url ?? '', 'http://127.0.0.1');
  const sessionId = url.searchParams.get('sessionId');
  if (!sessionId) {
    sendJson(res, 400, { ok: false, error: 'sessionId query param is required' });
    return;
  }

  const session = registry.get(sessionId);
  if (!session) {
    sendJson(res, 404, { ok: false, error: `unknown session: ${sessionId}` });
    return;
  }

  sendJson(res, 200, { readOnly: session.readOnly, blockedTools: session.readOnly ? RO_BUILTIN_BLOCK : [] });
}

/**
 * Start the bridge's loopback-only HTTP listener.
 *
 * Binds `127.0.0.1` on an ephemeral port (0), mints a fresh bearer token, and
 * dispatches `POST /tool` requests to the fixed control-tool whitelist for
 * the resolved session. Never logs the token, prompt content, or tool args.
 */
export function startBridgeServer(registry: SessionRegistry): Promise<BridgeHandle> {
  const token = randomBytes(32).toString('hex');

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      void (async () => {
        try {
          const pathname = req.url ? new URL(req.url, 'http://127.0.0.1').pathname : '';
          if (req.method === 'GET' && pathname === '/tools') {
            if (!isAuthorized(req, token)) {
              sendJson(res, 401, { ok: false, error: 'unauthorized' });
              return;
            }
            handleToolsList(res);
            return;
          }
          if (req.method === 'GET' && pathname === '/policy') {
            if (!isAuthorized(req, token)) {
              sendJson(res, 401, { ok: false, error: 'unauthorized' });
              return;
            }
            handlePolicyRequest(req, res, registry);
            return;
          }
          if (req.method === 'POST' && pathname === '/tool') {
            if (!isAuthorized(req, token)) {
              sendJson(res, 401, { ok: false, error: 'unauthorized' });
              return;
            }
            await handleToolRequest(req, res, registry);
            return;
          }
          sendJson(res, 404, { ok: false, error: 'not found' });
        } catch (e) {
          logger.error('system', `opencode bridge: unhandled error handling ${req.method} ${req.url}`);
          if (!res.headersSent) {
            sendJson(res, 500, { ok: false, error: e instanceof Error ? e.message : 'internal error' });
          }
        }
      })();
    });

    server.once('error', reject);

    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${address.port}`;
      const close = () =>
        new Promise<void>((res, rej) => {
          server.close((err) => (err ? rej(err) : res()));
        });
      resolve({ url, token, close });
    });
  });
}
