import { describe, it, expect } from 'vitest';
import { classifyEvent } from '../TaskDetail.js';

describe('classifyEvent', () => {
  it('shows user↔pm messages', () => {
    expect(classifyEvent('message', 'user', 'pm-agent')).toBe('visible');
    expect(classifyEvent('message', 'pm-agent', 'user')).toBe('visible');
  });
  it('folds inter-agent messages', () => {
    expect(classifyEvent('message', 'pm-agent', 'frontend-agent')).toBe('foldable');
    expect(classifyEvent('message', 'backend-agent', 'pm-agent')).toBe('foldable');
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
