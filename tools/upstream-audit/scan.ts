import type { ChangedFile } from './diff.js';
import { RULES, type Rule, type RulePack } from './rules.js';

export interface Hit {
  ruleId: string;
  pack: RulePack;
  file: string;
  /** Present only for rules that match a specific added line. */
  line?: number;
  evidence?: string;
  why: string;
  lookAt: string[];
}

function applies(rule: Rule, path: string): boolean {
  if (!rule.matchPath.test(path)) return false;
  if (rule.ignorePath?.test(path)) return false;
  return true;
}

export function scanDiff(files: ChangedFile[], rules: Rule[] = RULES): Hit[] {
  const hits: Hit[] = [];

  for (const file of files) {
    for (const rule of rules) {
      if (!applies(rule, file.path)) continue;

      const base = { ruleId: rule.id, pack: rule.pack, file: file.path, why: rule.why, lookAt: rule.lookAt };

      if (!rule.matchAdded) {
        hits.push(base);
        continue;
      }
      for (const added of file.addedLines) {
        if (rule.matchAdded.test(added.text)) {
          hits.push({ ...base, line: added.line, evidence: added.text.trim() });
        }
      }
    }
  }

  return hits;
}
