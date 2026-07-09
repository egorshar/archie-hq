/**
 * CLI preflight: make `npm run cli` self-bootstrapping.
 *
 *  - ensureCredential(): if no Claude credential resolves, run `claude
 *    setup-token`, capture the token, persist it to .env, and expose it to
 *    this process so a child server inherits it.
 *  - ensureServer():     if the Archie server is not answering /health, start
 *    `npm run dev` as a child (dies with the cli) and wait for it to come up.
 *
 * Runs before the TUI switches to the alternate screen buffer, since the token
 * flow is interactive (browser + terminal).
 */
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { resolveClaudeCredential } from '../system/claude-credential.js';

const ENV_PATH = join(process.cwd(), '.env');
const DEV_LOG = join(process.cwd(), '.archie-dev.log');

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/**
 * Extract an OAuth token from `claude setup-token` output. Prefers the token
 * pattern; falls back to the last non-empty line for forward-compat.
 */
export function extractOAuthToken(output: string): string | undefined {
  const match = output.match(/sk-ant-oat[\w-]+/);
  if (match) return match[0];
  const lines = output.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : undefined;
}

/**
 * Return `.env` content with CLAUDE_CODE_OAUTH_TOKEN set to `token`: replaces an
 * existing line (even commented/empty) in place, otherwise appends one. Always
 * leaves a trailing newline and does not touch any other line.
 */
export function upsertEnvToken(envContent: string, token: string): string {
  const line = `CLAUDE_CODE_OAUTH_TOKEN=${token}`;
  const existing = /^#?\s*CLAUDE_CODE_OAUTH_TOKEN=.*$/m;
  if (existing.test(envContent)) {
    return envContent.replace(existing, line);
  }
  const sep = envContent.length > 0 && !envContent.endsWith('\n') ? '\n' : '';
  return `${envContent}${sep}${line}\n`;
}

// ---------------------------------------------------------------------------
// Credential
// ---------------------------------------------------------------------------

function runSetupToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    // stdin/stderr inherited for the interactive browser flow; stdout piped so
    // we can capture the printed token while still echoing it to the user.
    const child = spawn('claude', ['setup-token'], { stdio: ['inherit', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      process.stdout.write(chunk);
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      reject(
        err.code === 'ENOENT'
          ? new Error(
              '`claude` CLI not found on PATH. Install Claude Code, or set ' +
                'ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN in .env, then retry.',
            )
          : err,
      );
    });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`\`claude setup-token\` exited with code ${code}.`));
        return;
      }
      const token = extractOAuthToken(out);
      if (!token) {
        reject(new Error('Could not parse a token from `claude setup-token` output.'));
        return;
      }
      resolve(token);
    });
  });
}

/**
 * Ensure a Claude credential is available. If none resolves, obtain one via
 * `claude setup-token`, persist it to .env, and set it on process.env so a
 * child server inherits it. No-op when a credential is already present.
 */
export async function ensureCredential(): Promise<void> {
  if (resolveClaudeCredential().kind !== 'none') return;

  console.log('No Claude credential found — running `claude setup-token`…\n');
  const token = await runSetupToken();

  const existing = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
  writeFileSync(ENV_PATH, upsertEnvToken(existing, token));
  process.env.CLAUDE_CODE_OAUTH_TOKEN = token;
  console.log('\nSaved CLAUDE_CODE_OAUTH_TOKEN to .env.');
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export interface ServerHandle {
  startedByUs: boolean;
  stop: () => void;
}

/** True if the server answers /health at all (any HTTP status = up). */
async function isServerUp(baseUrl: string, timeoutMs: number): Promise<boolean> {
  try {
    await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}

function tailFile(path: string, lines: number): string {
  try {
    return readFileSync(path, 'utf8').split('\n').slice(-lines).join('\n');
  } catch {
    return '(no log output captured)';
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Ensure the Archie server is reachable at `baseUrl`. If it is already up, does
 * nothing. Otherwise starts `npm run dev` as a child (logs → .archie-dev.log)
 * and polls /health until it responds. Throws if it never becomes healthy.
 */
export async function ensureServer(baseUrl: string): Promise<ServerHandle> {
  if (await isServerUp(baseUrl, 1000)) {
    return { startedByUs: false, stop: () => {} };
  }

  console.log(`No server at ${baseUrl} — starting \`npm run dev\` (logs → .archie-dev.log)…`);
  const logFd = openSync(DEV_LOG, 'a');
  const child = spawn('npm', ['run', 'dev'], { stdio: ['ignore', logFd, logFd] });
  const stop = () => {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  };
  child.on('error', (err) => {
    console.error(`Failed to start \`npm run dev\`: ${err.message}`);
  });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break; // server process died
    if (await isServerUp(baseUrl, 1000)) {
      return { startedByUs: true, stop };
    }
    await delay(500);
  }

  stop();
  throw new Error(
    `Archie server did not become healthy within 30s.\n` +
      `Last lines of .archie-dev.log:\n${tailFile(DEV_LOG, 20)}`,
  );
}
