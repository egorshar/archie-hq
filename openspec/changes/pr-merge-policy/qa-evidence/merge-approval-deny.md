# E2E evidence — merge-approval-deny

- **Result:** PASS
- **ACs covered:** AC3
- **Terminal state:** `completed`
- **Started:** 2026-07-06T12:08:41Z · **Finished:** 2026-07-06T12:13:13Z
- **Environment:** http://localhost:3000 · branch `forge/pr-merge-policy` · commit `869b0c8`
- **Nonce:** `E2E-6f812928` · **Task:** `task-20260706-1209-8tn0bu`

## Assertions

| id | description | expected | observed | pass |
|----|-------------|----------|----------|------|
| boot-attestation | Instance booted from the checkout under test | boot.ts attests the /health git_sha equals git rev-parse HEAD of the branch under test | Attested: instance composed from 869b0c82a5bf605b3f93a603f5f4af1ae1db31f2 (branch forge/pr-merge-policy HEAD, clean tree) | PASS |
| pr-opened | Change request opened a real PR in a configured non-auto repo after edit-mode approval | edit_mode gate approved via approve(type: edit_mode, approve: true); task completes announcing an open PR | approval:requested (edit_mode) at 12:09:40 resolved with approve:true at 12:09:54; PR #80 opened on sweatco/archie-plugins (no agent sets autoMerge, so the repo is non-auto); task:completed at 12:11:09 | PASS |
| merge-gate-surfaced | Explicit merge request trips the merge approval gate instead of merging | after send_message asking to merge, wait_for_task returns STATE=approval_requested with APPROVAL_TYPE=merge and the knowledge log carries the merge-approval decision finding naming the PR | wait_for_task returned STATE=approval_requested, APPROVAL_TYPE=merge; knowledge log line: [2026-07-06T12:11:44.760Z] [system] [decision] Merge approval requested for sweatco/archie-plugins#80 | PASS |
| deny-resolves-via-api | Denial via the API path with the pending PR's identity resolves the gate | approve(type: merge, approve: false, github: sweatco/archie-plugins, pr_number: 80) succeeds and emits approval:resolved {type: merge, approve: false} | approve call returned 'Denied merge for task-20260706-1209-8tn0bu'; event at 12:12:09.843: approval:resolved {"type":"merge","approve":false} | PASS |
| no-merge-occurred | The denied merge never executed | denial finding 'Merge denied by user — PR not merged' in the knowledge log; no 'merged on user approval' completion finding or merged event; PR still open on GitHub | knowledge log carries the denial finding at 12:12:09.802; no merge finding/event anywhere in the task; gh pr view 80 --repo sweatco/archie-plugins reports {"mergedAt":null,"state":"OPEN"}; task settled STATE=completed with the PM relaying the denial | PASS |

## Excerpts

### Knowledge log

```
[2026-07-06T12:10:45.287Z] [archie-agent] [decision] Created PR #80 on sweatco/archie-plugins: https://github.com/sweatco/archie-plugins/pull/80
[2026-07-06T12:11:21.399Z] [cli] [E2E-6f812928] Please merge that PR.
[2026-07-06T12:11:34.074Z] [pm-agent] → archie-agent: The user has asked to merge PR #80 in sweatco/archie-plugins. Please merge it using your merge_pull_request tool (which will surface Approve/Deny buttons to the user). Report back once it's merged.
[2026-07-06T12:11:44.760Z] [system] [decision] Merge approval requested for sweatco/archie-plugins#80
[2026-07-06T12:12:09.802Z] [system] [decision] Merge denied by user — PR not merged
[2026-07-06T12:12:17.720Z] [pm-agent in cli] Understood — the merge was denied, so PR #80 stays open and unmerged. Let me know if you'd like anything else.
```

### Events

```json
{"timestamp":"2026-07-06T12:09:40.809Z","type":"approval:requested","data":{"text":"Edit mode request: Add a single HTML comment line to the bottom of README.md in sweatco/archie-plugins and open a PR (no merge).","approvalType":"edit_mode"}}
{"timestamp":"2026-07-06T12:09:54.120Z","type":"approval:resolved","data":{"type":"edit_mode","approve":true}}
{"timestamp":"2026-07-06T12:11:09.638Z","type":"task:completed","data":{}}
{"timestamp":"2026-07-06T12:11:44.761Z","type":"approval:requested","data":{"text":"Merge approval requested for PR #80 (sweatco/archie-plugins)","approvalType":"merge"}}
{"timestamp":"2026-07-06T12:12:09.802Z","agentName":"system","type":"agent:log","data":{"finding":"Merge denied by user — PR not merged","type":"decision"}}
{"timestamp":"2026-07-06T12:12:09.843Z","type":"approval:resolved","data":{"type":"merge","approve":false}}
{"timestamp":"2026-07-06T12:12:28.741Z","type":"task:completed","data":{}}
```

## Verdict

**PASS** — 5/5 assertions passed.
