/**
 * Minimal unified-diff parser.
 *
 * We only need what the audit rules ask about: which files an upstream range
 * touched, and which lines it added. Deleted lines never trip a rule — a rule
 * fires on code arriving in the fork, not on code leaving upstream.
 */

export type ChangeStatus = 'added' | 'modified' | 'deleted';

export interface AddedLine {
  /** 1-based line number in the post-change file */
  line: number;
  text: string;
}

export interface ChangedFile {
  path: string;
  status: ChangeStatus;
  addedLines: AddedLine[];
}

const FILE_HEADER = /^diff --git a\/(.+) b\/(.+)$/;
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parseUnifiedDiff(text: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  let current: ChangedFile | null = null;
  let nextLine = 0;

  for (const raw of text.split('\n')) {
    const header = FILE_HEADER.exec(raw);
    if (header) {
      current = { path: header[2], status: 'modified', addedLines: [] };
      files.push(current);
      nextLine = 0;
      continue;
    }
    if (!current) continue;

    if (raw.startsWith('new file mode')) {
      current.status = 'added';
      continue;
    }
    if (raw.startsWith('deleted file mode')) {
      current.status = 'deleted';
      continue;
    }

    const hunk = HUNK_HEADER.exec(raw);
    if (hunk) {
      nextLine = Number(hunk[1]);
      continue;
    }

    if (raw.startsWith('+++') || raw.startsWith('---')) continue;

    if (raw.startsWith('+')) {
      current.addedLines.push({ line: nextLine, text: raw.slice(1) });
      nextLine += 1;
      continue;
    }
    if (raw.startsWith('-') || raw.startsWith('\\')) continue;
    // context line
    if (nextLine > 0) nextLine += 1;
  }

  return files;
}
