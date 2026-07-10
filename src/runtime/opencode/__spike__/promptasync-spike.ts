/**
 * Spike: confirm session.promptAsync's runtime behavior for the turn-loop
 * refactor (B) that replaces the blocking session.prompt (which holds one HTTP
 * request open for the whole turn -> undici UND_ERR_HEADERS_TIMEOUT on long
 * glm-5.2 turns).
 *
 * Confirms:
 *   1. promptAsync RETURNS FAST (does not block for the turn) + status 204.
 *   2. session.idle fires on the event stream when the async turn completes.
 *   3. assistant text arrives via message.part.updated (type "text") parts.
 *   4. (return-shape for the not-found reset-retry: types say 404 -> covered by
 *      isSessionNotFound on the promptAsync result; not forced live here.)
 *
 * Run: npx tsx --env-file=.env src/runtime/opencode/__spike__/promptasync-spike.ts
 */
import { createOpencode } from '@opencode-ai/sdk';

const MODEL = process.env.ARCHIE_OPENCODE_MODEL_DEFAULT || 'openrouter/z-ai/glm-4.5';
type Ev = { type?: string; properties?: any };
const START = process.hrtime.bigint();
const ms = () => Number((process.hrtime.bigint() - START) / 1_000_000n);

async function main() {
  console.log('MODEL', MODEL);
  const { client, server } = await createOpencode({
    port: 0,
    config: { model: MODEL, permission: { edit: 'allow', bash: 'allow', webfetch: 'allow', external_directory: 'allow' } },
  });

  const events: Array<{ at: number; type: string; part?: string }> = [];
  let idleAt = -1;
  let textChunks = 0;
  const consume = (async () => {
    try {
      const sub = await client.event.subscribe();
      for await (const ev of (sub as any).stream as AsyncIterable<Ev>) {
        const part = ev?.properties?.part;
        if (ev?.type === 'message.part.updated') {
          if (part?.type === 'text') textChunks++;
          events.push({ at: ms(), type: ev.type, part: part?.type });
        } else if (ev?.type === 'session.idle' || ev?.type === 'session.error') {
          events.push({ at: ms(), type: ev.type });
          if (ev.type === 'session.idle') idleAt = ms();
        }
      }
    } catch { /* stream closes on server.close */ }
  })();

  try {
    const created = (await client.session.create({ body: { title: 'promptasync-spike' } })) as any;
    const sid = created?.data?.id;
    console.log('SESSION', sid);

    const t0 = ms();
    const res = (await (client.session as any).promptAsync({
      path: { id: sid },
      body: { parts: [{ type: 'text', text: 'Reply with exactly the word: pong.' }] },
    })) as any;
    const t1 = ms();
    console.log(`promptAsync RETURNED in ${t1 - t0}ms | data=${JSON.stringify(res?.data)} | httpStatus=${res?.response?.status ?? '?'} | error=${JSON.stringify(res?.error)}`);

    // Wait for the async turn to reach idle (bounded).
    for (let i = 0; i < 60 && idleAt < 0; i++) await new Promise((r) => setTimeout(r, 1000));
    console.log(`idle fired at ${idleAt}ms (returnAt=${t1}ms) | textChunks=${textChunks}`);
    console.log('event trace:', JSON.stringify(events.filter((e) => e.type !== 'message.part.updated' || e.part === 'text').slice(0, 20)));
    console.log('SUMMARY: fast-return =', (t1 - t0) < 3000, '| idle-fired =', idleAt >= 0, '| got-text =', textChunks > 0);
  } finally {
    try { server.close(); } catch {}
    void consume;
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error('SPIKE_ERROR', e); process.exit(1); });
