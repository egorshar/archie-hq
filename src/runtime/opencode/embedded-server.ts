/**
 * Start an embedded `opencode serve` in a CONTROLLED working directory.
 *
 * `@opencode-ai/sdk`'s `createOpencode` spawns `opencode serve` in the current
 * process's cwd and gives no way to change it — but opencode discovers skills
 * (and other project-local config) by that cwd. Archie's process cwd is the repo
 * root, which carries Archie's OWN dev skills (`.claude/skills`), so we can't use
 * it. This helper reproduces the SDK's spawn faithfully — same `opencode serve
 * --hostname --port` invocation, same `OPENCODE_CONFIG_CONTENT` env for config,
 * same "opencode server listening on <url>" stdout parse — and adds the one thing
 * it omits: an explicit `cwd`. Pointed at a clean, git-initialised staging root
 * (so opencode's git-worktree walk stops there), the serve sees only the skills
 * Archie stages, not the repo's.
 */
import { createOpencodeClient } from '@opencode-ai/sdk';
import { spawn, exec } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

/**
 * Prepare the embedded server's working directory: create it and make it its own
 * git worktree (`git init`). The worktree boundary is what stops opencode's
 * upward skill-discovery walk at this root, so it can't reach the repo's own
 * `.claude/skills`. Idempotent — skips `git init` if `.git` already exists.
 */
export async function prepareServeRoot(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  if (!existsSync(join(root, '.git'))) {
    await execAsync('git init -q', { cwd: root });
  }
}

/** The connected client type — from the SDK's client factory. */
export type OpencodeClient = ReturnType<typeof createOpencodeClient>;

export interface EmbeddedServer {
  client: OpencodeClient;
  /** Terminate the serve child. Idempotent / best-effort. */
  close: () => void;
}

export async function startEmbeddedServer(opts: {
  cwd: string;
  config: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<EmbeddedServer> {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const proc = spawn('opencode', ['serve', '--hostname=127.0.0.1', '--port=0'], {
    cwd: opts.cwd,
    env: { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(opts.config) },
  });

  const url = await new Promise<string>((resolve, reject) => {
    let out = '';
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      try { proc.kill(); } catch { /* already gone */ }
      reject(new Error(`opencode serve did not start within ${timeoutMs}ms`));
    }, timeoutMs);
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    };
    proc.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return;
      out += chunk.toString();
      for (const line of out.split('\n')) {
        if (line.startsWith('opencode server listening')) {
          const m = line.match(/on\s+(https?:\/\/[^\s]+)/);
          if (m) {
            settled = true;
            clearTimeout(timer);
            // Keep draining stdout so the child's later log output can't fill
            // the pipe buffer and stall it; we no longer accumulate it.
            proc.stdout?.resume();
            resolve(m[1]);
            return;
          }
        }
      }
    });
    proc.stderr?.on('data', (chunk: Buffer) => { if (!settled) out += chunk.toString(); });
    proc.on('exit', (code) => fail(new Error(`opencode serve exited (code ${code})${out.trim() ? `: ${out.slice(-500)}` : ''}`)));
    proc.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))));
  });

  return {
    client: createOpencodeClient({ baseUrl: url }),
    close: () => { try { proc.kill(); } catch { /* already gone */ } },
  };
}
