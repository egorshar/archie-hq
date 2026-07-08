import { describe, it, expect, afterEach } from 'vitest';
import { writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadPromptFromPath } from '../prompt-loader.js';

describe('prompt loader injects BOT_NAME', () => {
  const orig = process.env.BOT_NAME;
  const tmp = join(tmpdir(), `botname-tpl-${process.pid}.md`);
  afterEach(async () => {
    if (orig === undefined) delete process.env.BOT_NAME;
    else process.env.BOT_NAME = orig;
    await rm(tmp, { force: true });
  });

  it('substitutes {{BOT_NAME}} from env even with no caller vars', async () => {
    process.env.BOT_NAME = 'Universal Soldier';
    await writeFile(tmp, 'I am {{BOT_NAME}}.', 'utf-8');
    expect(await loadPromptFromPath(tmp)).toBe('I am Universal Soldier.');
  });

  it('defaults {{BOT_NAME}} to Archie when unset', async () => {
    delete process.env.BOT_NAME;
    await writeFile(tmp, 'I am {{BOT_NAME}}.', 'utf-8');
    expect(await loadPromptFromPath(tmp)).toBe('I am Archie.');
  });

  it('lets a caller-provided BOT_NAME win', async () => {
    process.env.BOT_NAME = 'FromEnv';
    await writeFile(tmp, 'I am {{BOT_NAME}}.', 'utf-8');
    expect(await loadPromptFromPath(tmp, { BOT_NAME: 'Override' })).toBe('I am Override.');
  });
});
