import { describe, it, expect, afterEach } from 'vitest';
import { botName } from '../bot-name.js';

describe('botName', () => {
  const orig = process.env.BOT_NAME;
  afterEach(() => {
    if (orig === undefined) delete process.env.BOT_NAME;
    else process.env.BOT_NAME = orig;
  });

  it('defaults to Archie when BOT_NAME is unset', () => {
    delete process.env.BOT_NAME;
    expect(botName()).toBe('Archie');
  });

  it('uses BOT_NAME when set', () => {
    process.env.BOT_NAME = 'Universal Soldier';
    expect(botName()).toBe('Universal Soldier');
  });

  it('trims surrounding whitespace and falls back on blank', () => {
    process.env.BOT_NAME = '  Neo  ';
    expect(botName()).toBe('Neo');
    process.env.BOT_NAME = '   ';
    expect(botName()).toBe('Archie');
  });
});
