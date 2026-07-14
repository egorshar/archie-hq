import { describe, it, expect } from 'vitest';
import { classifyEvent, isUserSender } from '../TaskDetail.js';

describe('classifyEvent', () => {
  it('shows user↔pm messages (both directions, cli + named senders)', () => {
    expect(classifyEvent('message', 'user', 'pm-agent')).toBe('visible');
    expect(classifyEvent('message', 'pm-agent', 'user')).toBe('visible');
    expect(classifyEvent('message', 'cli', 'pm-agent')).toBe('visible');       // CLI operator
    expect(classifyEvent('message', 'Egor Sharapov', 'pm-agent')).toBe('visible'); // Slack person
  });
  it('folds inter-agent messages', () => {
    expect(classifyEvent('message', 'pm-agent', 'frontend-agent')).toBe('foldable');
    expect(classifyEvent('message', 'backend-agent', 'pm-agent')).toBe('foldable');
  });
  it('folds CI/webhook messages (from:ci → pm), not treated as user', () => {
    expect(classifyEvent('message', 'ci', 'pm-agent')).toBe('foldable');
  });
  it('keeps a system notice to the user visible but not user-flagged', () => {
    expect(classifyEvent('message', 'system', 'user')).toBe('visible'); // to===user
    expect(isUserSender('system')).toBe(false);                          // but not styled as the human
  });
  it('shows actionable/tracked events', () => {
    for (const t of ['approval:requested', 'approval:resolved', 'pr_card', 'reminder:set', 'reminder:fired', 'reminder:cancelled']) {
      expect(classifyEvent(t)).toBe('visible');
    }
  });
  it('folds findings and background tasks', () => {
    expect(classifyEvent('agent:log', 'backend-agent', 'backend-agent')).toBe('foldable');
    expect(classifyEvent('agent:bg_task')).toBe('foldable');
  });
});

describe('isUserSender', () => {
  it('is true for human senders (cli, named), false for agents', () => {
    expect(isUserSender('cli')).toBe(true);
    expect(isUserSender('Egor Sharapov')).toBe(true);
    expect(isUserSender('user')).toBe(true);
    expect(isUserSender('pm-agent')).toBe(false);
    expect(isUserSender('backend-agent')).toBe(false);
    expect(isUserSender('ci')).toBe(false);       // CI/webhook, not a human
    expect(isUserSender('system')).toBe(false);   // system notice, not a human
    expect(isUserSender(undefined)).toBe(false);
  });
});
