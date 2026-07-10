/**
 * B.3 Task-0 spike (throwaway). Pins the opencode config.mcp + per-turn tool
 * scoping mechanism the B.3 plan rests on. Probes with a real stdio MCP server
 * (@modelcontextprotocol/server-everything — deterministic `echo`/`add` tools).
 *
 * Answers:
 *   1. Does config.mcp connect a server + surface its tools to a prompt turn?
 *   2. Tool-naming scheme — what `part.tool` name does an MCP tool call carry?
 *   3. Does body.tools:{[name]:bool} gate MCP tools (disable → can't call)?
 *   4. (bridge /tools session-scoping is checked separately in code, not here.)
 *
 * Run: npx tsx --env-file=.env src/runtime/opencode/__spike__/b3-mcp-spike.ts
 * Requires: opencode CLI + OpenRouter authed + ARCHIE_OPENCODE_MODEL_DEFAULT + npx (fetches the MCP server).
 */
import { createOpencode } from '@opencode-ai/sdk';

const MODEL = process.env.ARCHIE_OPENCODE_MODEL_DEFAULT || 'openrouter/anthropic/claude-haiku-4.5';
type Ev = { type?: string; properties?: any };

async function runPrompt(client: any, sid: string, text: string, tools?: Record<string, boolean>) {
  const seen: Array<{ tool: string; state?: string }> = [];
  const body: any = { parts: [{ type: 'text', text }] };
  if (tools) body.tools = tools;
  const res = await client.session.prompt({ path: { id: sid }, body });
  return { res, seen };
}

async function main() {
  console.log('MODEL', MODEL);
  const { client, server } = await createOpencode({
    port: 0,
    config: {
      model: MODEL,
      permission: { edit: 'allow', bash: 'allow', webfetch: 'allow', external_directory: 'allow' },
      mcp: {
        everything: { type: 'local', command: ['npx', '-y', '@modelcontextprotocol/server-everything'] },
      },
    },
  });

  const toolCalls: Array<{ at: string; tool: string; sid?: string }> = [];
  const start = process.hrtime.bigint();
  const consume = (async () => {
    try {
      const sub = await client.event.subscribe();
      for await (const ev of (sub as any).stream as AsyncIterable<Ev>) {
        const part = ev?.properties?.part;
        if (ev?.type === 'message.part.updated' && part?.type === 'tool') {
          toolCalls.push({ at: `+${(process.hrtime.bigint() - start) / 1_000_000n}ms`, tool: part.tool, sid: part.sessionID });
        }
      }
    } catch { /* stream ends on close */ }
  })();

  try {
    // Q1/Q2: can it call the MCP tool, and what is the tool name?
    const s1 = (await client.session.create({ body: { title: 'b3-q12' } })) as any;
    const sid1 = s1?.data?.id;
    console.log('SESSION1', sid1);
    const r1 = await runPrompt(client, sid1, "You have an MCP tool named 'echo' (from the 'everything' server). Call it once with message 'B3PROBE', then reply with the single word done.");
    const info1 = (r1.res as any)?.data?.info;
    console.log('Q1 error=', JSON.stringify(info1?.error));
    await new Promise((r) => setTimeout(r, 1500));
    console.log('Q1/Q2 tool calls observed:', JSON.stringify(toolCalls));

    async function probe(label: string, tools: Record<string, boolean>, prompt: string, expectTool: RegExp) {
      const before = toolCalls.length;
      const s = (await client.session.create({ body: { title: label } })) as any;
      await runPrompt(client, s?.data?.id, prompt, tools);
      await new Promise((r) => setTimeout(r, 1500));
      const after = toolCalls.slice(before);
      const called = after.some((t) => expectTool.test(t.tool));
      console.log(`${label}: tools=${JSON.stringify(tools)} -> calls=${JSON.stringify(after.map((t) => t.tool))} | expected-tool-called=${called}`);
      return called;
    }

    // Q3a: exact-name denylist gates the MCP tool?
    await probe('Q3a-exact-deny', { everything_echo: false }, "Call the echo MCP tool with message 'X', then say done.", /echo/i);
    // Q3b: wildcard denylist gates?
    await probe('Q3b-wildcard-deny', { 'everything*': false }, "Call the echo MCP tool with message 'X', then say done.", /echo/i);
    // Q3c: SEMANTICS — enable only echo; does a BUILT-IN (read) still work (unlisted=on) or is it blocked (allowlist)?
    await probe('Q3c-semantics', { everything_echo: true }, "Read the file /etc/hostname using your read tool and reply with its contents.", /^read$/i);
  } finally {
    try { server.close(); } catch {}
    void consume;
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('SPIKE_ERROR', e); process.exit(1); });
