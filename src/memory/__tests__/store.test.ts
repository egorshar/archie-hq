/**
 * Memory Store Tests
 *
 * Uses temp directories and mocked paths module to test all store operations.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// We need to set up the mock before importing the module
let tempDir: string;
let orgPath: string;
let usersDir: string;

vi.mock('../paths.js', () => ({
  getOrgPath: () => orgPath,
  getUserPath: (id: string) => {
    const safe = id.includes(':') ? id.replace(':', '__') : id;
    return join(usersDir, `${safe}.md`);
  },
  getUsersDir: () => usersDir,
  getMemoryDir: () => tempDir,
  getOrgCap: () => 200,
  getUserCap: () => 100,
  getSectionCap: () => 30,
  isHousekeepingEnabled: () => false,
}));

vi.mock('../../system/logger.js', () => ({
  logger: { warn: vi.fn(), system: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import {
  readOrg,
  writeOrg,
  readUser,
  writeUser,
  applyOrgUpdates,
  applyUserUpdates,
} from '../store.js';

describe('memory store', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'archie-memory-test-'));
    orgPath = join(tempDir, 'org.md');
    usersDir = join(tempDir, 'users');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ---- readOrg ----

  describe('readOrg()', () => {
    it('returns empty string when file does not exist', async () => {
      const result = await readOrg();
      expect(result).toBe('');
    });

    it('returns file content when file exists', async () => {
      const content = '## Engineering\n- Uses TypeScript\n';
      await writeFile(orgPath, content, 'utf-8');
      const result = await readOrg();
      expect(result).toBe(content);
    });
  });

  // ---- writeOrg ----

  describe('writeOrg(content)', () => {
    it('creates the file with given content', async () => {
      const content = '## Engineering\n- Uses TypeScript\n';
      await writeOrg(content);
      const saved = await readFile(orgPath, 'utf-8');
      expect(saved).toBe(content);
    });

    it('overwrites existing content', async () => {
      await writeFile(orgPath, 'old content', 'utf-8');
      await writeOrg('new content');
      const saved = await readFile(orgPath, 'utf-8');
      expect(saved).toBe('new content');
    });
  });

  // ---- readUser ----

  describe('readUser(username)', () => {
    it('returns empty string when user file does not exist', async () => {
      const result = await readUser('alice');
      expect(result).toBe('');
    });

    it('returns content when user file exists', async () => {
      await mkdir(usersDir, { recursive: true });
      const content = '## Communication\n- Prefers async\n';
      await writeFile(join(usersDir, 'alice.md'), content, 'utf-8');
      const result = await readUser('alice');
      expect(result).toBe(content);
    });

    // Note: identifier-guard rejection of invalid IDs (e.g. 'John Doe') is
    // covered in paths.test.ts. This test file mocks paths.js to a permissive
    // implementation so it can focus on store semantics.

    it('reads a file keyed by raw Slack ID', async () => {
      await mkdir(usersDir, { recursive: true });
      const content = '## Notes\n- Developer\n';
      await writeFile(join(usersDir, 'U07ABC123.md'), content, 'utf-8');
      const result = await readUser('U07ABC123');
      expect(result).toBe(content);
    });
  });

  // ---- writeUser ----

  describe('writeUser(username, content)', () => {
    it('creates file and users/ directory if missing', async () => {
      const content = '## Communication\n- Prefers async\n';
      await writeUser('alice', content);
      const saved = await readFile(join(usersDir, 'alice.md'), 'utf-8');
      expect(saved).toBe(content);
    });

    it('works even if users/ dir already exists', async () => {
      await mkdir(usersDir, { recursive: true });
      const content = '## Notes\n- Backend developer\n';
      await writeUser('bob', content);
      const saved = await readFile(join(usersDir, 'bob.md'), 'utf-8');
      expect(saved).toBe(content);
    });

    it('overwrites existing user file', async () => {
      await mkdir(usersDir, { recursive: true });
      await writeFile(join(usersDir, 'alice.md'), 'old content', 'utf-8');
      await writeUser('alice', 'new content');
      const saved = await readFile(join(usersDir, 'alice.md'), 'utf-8');
      expect(saved).toBe('new content');
    });
  });

  // ---- applyOrgUpdates ----

  describe('applyOrgUpdates(updates)', () => {
    it('handles empty file — creates new section for add action', async () => {
      await applyOrgUpdates([{ action: 'add', section: 'Engineering', content: 'Uses TypeScript' }]);
      const saved = await readFile(orgPath, 'utf-8');
      expect(saved).toContain('## Engineering');
      expect(saved).toContain('- Uses TypeScript');
    });

    it('adds under existing section', async () => {
      await writeFile(orgPath, '## Engineering\n- Uses Node.js\n', 'utf-8');
      await applyOrgUpdates([{ action: 'add', section: 'Engineering', content: 'Uses TypeScript' }]);
      const saved = await readFile(orgPath, 'utf-8');
      expect(saved).toContain('- Uses Node.js');
      expect(saved).toContain('- Uses TypeScript');
    });

    it('creates new section at end of file when section missing', async () => {
      await writeFile(orgPath, '## Engineering\n- Uses Node.js\n', 'utf-8');
      await applyOrgUpdates([{ action: 'add', section: 'Marketing', content: 'Uses Figma' }]);
      const saved = await readFile(orgPath, 'utf-8');
      expect(saved).toContain('## Engineering');
      expect(saved).toContain('## Marketing');
      expect(saved).toContain('- Uses Figma');
      // Marketing section should come after Engineering
      expect(saved.indexOf('## Engineering')).toBeLessThan(saved.indexOf('## Marketing'));
    });

    it('replaces line on update action with old text', async () => {
      await writeFile(orgPath, '## Engineering\n- Uses Node.js\n- Uses TypeScript\n', 'utf-8');
      await applyOrgUpdates([{ action: 'update', content: 'Uses Node.js v20', old: 'Uses Node.js' }]);
      const saved = await readFile(orgPath, 'utf-8');
      expect(saved).toContain('- Uses Node.js v20');
      expect(saved).not.toContain('- Uses Node.js\n');
      expect(saved).toContain('- Uses TypeScript');
    });

    it('skips update when `old` text is not found (no silent append)', async () => {
      await writeFile(orgPath, '## Engineering\n- Uses TypeScript\n', 'utf-8');
      const before = await readFile(orgPath, 'utf-8');
      await applyOrgUpdates([{ action: 'update', content: 'Uses TypeScript v5', old: 'Uses JavaScript' }]);
      const after = await readFile(orgPath, 'utf-8');
      expect(after).toBe(before);
    });

    it('skips update when `old` is missing entirely', async () => {
      await writeFile(orgPath, '## Engineering\n- Uses TypeScript\n', 'utf-8');
      const before = await readFile(orgPath, 'utf-8');
      // sanitizeUpdate would normally reject this; testing applyUpdate directly via applyOrgUpdates
      // The sanitizer catches it first — verifying the file is unchanged either way.
      await applyOrgUpdates([{ action: 'update', content: 'orphan content' } as any]);
      const after = await readFile(orgPath, 'utf-8');
      expect(after).toBe(before);
    });

    it('applies multiple updates sequentially', async () => {
      await writeFile(orgPath, '## Engineering\n- Uses Node.js\n', 'utf-8');
      await applyOrgUpdates([
        { action: 'add', section: 'Engineering', content: 'Uses TypeScript' },
        { action: 'add', section: 'Culture', content: 'Remote first' },
      ]);
      const saved = await readFile(orgPath, 'utf-8');
      expect(saved).toContain('- Uses Node.js');
      expect(saved).toContain('- Uses TypeScript');
      expect(saved).toContain('## Culture');
      expect(saved).toContain('- Remote first');
    });
  });

  // ---- applyUserUpdates ----

  describe('applyUserUpdates(username, updates)', () => {
    it('creates new user file with section when file does not exist', async () => {
      await applyUserUpdates('alice', [{ action: 'add', section: 'Communication', content: 'Prefers async' }]);
      const saved = await readFile(join(usersDir, 'alice.md'), 'utf-8');
      expect(saved).toContain('## Communication');
      expect(saved).toContain('- Prefers async');
    });

    it('adds under existing section in user file', async () => {
      await mkdir(usersDir, { recursive: true });
      await writeFile(join(usersDir, 'bob.md'), '## Communication\n- Prefers async\n', 'utf-8');
      await applyUserUpdates('bob', [{ action: 'add', section: 'Communication', content: 'Uses Slack' }]);
      const saved = await readFile(join(usersDir, 'bob.md'), 'utf-8');
      expect(saved).toContain('- Prefers async');
      expect(saved).toContain('- Uses Slack');
    });

    it('creates users/ directory if missing', async () => {
      await applyUserUpdates('charlie', [{ action: 'add', section: 'Notes', content: 'Backend dev' }]);
      const saved = await readFile(join(usersDir, 'charlie.md'), 'utf-8');
      expect(saved).toContain('## Notes');
      expect(saved).toContain('- Backend dev');
    });
  });
});
