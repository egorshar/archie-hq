/**
 * P2-C Task-0 spike (throwaway). Confirms, against a real embedded opencode
 * server driving the local opencode CLI, the event-stream contract the P2-C SSE
 * consumer (events.ts) is built on:
 *   1. `(await client.event.subscribe()).stream` is an async-iterable yielding
 *      one event object per event (SDK type says AsyncGenerator).
 *   2. `message.part.updated` (tool part) + `session.idle` actually fire for a
 *      normal read-only turn — and in what order relative to prompt() returning.
 *   3. the stream is GLOBAL (carries events for every session → filtering by
 *      sessionID is required).
 *   4. no extra auth is needed on event.subscribe (same embedded server).
 *
 * Run: npx tsx src/runtime/opencode/__spike__/p2c-events-spike.ts
 * Requires: opencode CLI on PATH + an authed provider (OpenRouter) locally +
 *           ARCHIE_OPENCODE_MODEL_DEFAULT set (provider/model).
 */
import { createOpencode } from '@opencode-ai/sdk';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const MODEL = process.env.ARCHIE_OPENCODE_MODEL_DEFAULT || 'openrouter/anthropic/claude-haiku-4.5';

type Ev = { type?: string; properties?: any };

function stamp(): string {
  return `+${(process.hrtime.bigint() - START) / 1_000_000n}ms`;
}
const START = process.hrtime.bigint();

async function main() {
  const projectDir = join(tmpdir(), 'archie-oc-p2c-spike');
  rmSync(projectDir, { recursive: true, force: true });
  mkdirSync(projectDir, { recursive: true });
  // A file for the agent to read, so a built-in `read` tool call fires.
  writeFileSync(join(projectDir, 'TARGET.md'), '# spike target\nThe secret word is BANANA.\n');
  process.chdir(projectDir);

  console.log('MODEL', MODEL);
  const { client, server } = await createOpencode({
    port: 0,
    config: {
      model: MODEL,
      permission: { edit: 'allow', bash: 'allow', webfetch: 'allow', external_directory: 'allow' },
    },
  });

  const events: Array<{ at: string; type: string; sessionID?: string; tool?: string; partType?: string }> = [];
  let streamShape = 'unknown';
  let subscribeThrew: string | null = null;

  // 1) Subscribe BEFORE prompting, consume in the background.
  const consume = (async () => {
    try {
      const sub = await client.event.subscribe();
      streamShape = `keys=[${Object.keys(sub || {}).join(',')}] hasStream=${!!(sub as any)?.stream}`;
      const stream = (sub as any).stream as AsyncIterable<Ev>;
      for await (const ev of stream) {
        const p = ev?.properties;
        const part = p?.part;
        events.push({
          at: stamp(),
          type: ev?.type ?? '(none)',
          sessionID: p?.sessionID ?? part?.sessionID,
          tool: part?.tool,
          partType: part?.type,
        });
      }
    } catch (e) {
      subscribeThrew = String(e);
    }
  })();

  try {
    const created = await client.session.create({ body: { title: 'p2c-spike' } });
    const sid = (created as any)?.data?.id;
    console.log('SESSION_ID', sid, stamp());

    const res = await client.session.prompt({
      path: { id: sid },
      body: {
        parts: [{ type: 'text', text: "Read the file TARGET.md in the current directory and reply with only the secret word." }],
      } as any,
    });
    console.log('PROMPT_RETURNED', stamp());
    const info = (res as any)?.data?.info ?? (res as any)?.data;
    console.log('ASSISTANT error=', JSON.stringify(info?.error));

    // Give the event stream a moment to flush trailing idle after prompt-return.
    await new Promise((r) => setTimeout(r, 1500));

    console.log('\n--- STREAM SHAPE ---');
    console.log(streamShape, subscribeThrew ? `THREW=${subscribeThrew}` : '');
    console.log('\n--- EVENTS (in order) ---');
    for (const e of events) {
      console.log(`${e.at}\t${e.type}\t${e.partType ?? ''}\t${e.tool ?? ''}\tsid=${e.sessionID ?? ''}`);
    }
    const sawTool = events.some((e) => e.type === 'message.part.updated' && e.partType === 'tool');
    const sawIdle = events.some((e) => e.type === 'session.idle');
    const sids = new Set(events.map((e) => e.sessionID).filter(Boolean));
    console.log('\n--- SUMMARY ---');
    console.log('saw tool part:', sawTool);
    console.log('saw session.idle:', sawIdle);
    console.log('distinct sessionIDs seen:', [...sids]);
    console.log('our session:', sid);
  } finally {
    try { server.close(); } catch {}
    void consume; // background loop ends when the server closes the stream
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('SPIKE_ERROR', e); process.exit(1); });
