## ADDED Requirements

### Requirement: Resolve the target task by id or nonce

The `wait_for_task` tool SHALL accept either an explicit `task_id` or a `nonce`, and SHALL resolve the target task before waiting. When given only a `nonce`, it SHALL locate the task whose knowledge log contains that nonce, retrying while it polls because a task is created asynchronously after an inbound message. It SHALL require at least one of `task_id` or `nonce`.

#### Scenario: Resolve by explicit task id
- **WHEN** `wait_for_task` is called with a `task_id`
- **THEN** it waits on that task without scanning the task list

#### Scenario: Resolve by nonce
- **WHEN** `wait_for_task` is called with a `nonce` and no `task_id`
- **THEN** it scans tasks for one whose knowledge log contains the nonce and waits on the first match

#### Scenario: Neither id nor nonce supplied
- **WHEN** `wait_for_task` is called with neither `task_id` nor `nonce`
- **THEN** it fails fast with a validation error naming the missing input

#### Scenario: Nonce never appears within the call
- **WHEN** no task's knowledge log contains the nonce before the wait cap elapses
- **THEN** it returns `state: "not_found"` as a normal result (not an error) so the caller can retry

### Requirement: Block until a terminal or actionable state

The tool SHALL poll the resolved task's event feed until the task reaches `task:completed`, `task:stopped`, or `approval:requested`, or until the wait cap is reached. Because the events feed replays the full history, terminal states (`completed`, `stopped`) SHALL take precedence over `approval:requested` when both are present.

#### Scenario: Task completes
- **WHEN** the event feed contains `task:completed`
- **THEN** it returns `state: "completed"`

#### Scenario: Task stopped without completing
- **WHEN** the feed contains `task:stopped` and no `task:completed`
- **THEN** it returns `state: "stopped"`

#### Scenario: Approval gate reached
- **WHEN** the feed contains `approval:requested` but no `task:completed` or `task:stopped`
- **THEN** it returns `state: "approval_requested"` together with the approval `type` (`edit_mode` or `research_budget`)

#### Scenario: Approved task that later completed (terminal precedence)
- **WHEN** the feed contains both `approval:requested` and `task:completed`
- **THEN** it returns `state: "completed"`, never `approval_requested`

### Requirement: Bounded, resumable waiting

A single invocation SHALL cap how long it blocks, below typical MCP client tool-call timeouts, so the call always returns. If the task is resolved but has not reached a terminal/actionable state when the cap is reached, the tool SHALL return `state: "pending"` together with an opaque `cursor`. When called again with that `cursor`, it SHALL resume waiting without reprocessing earlier events.

#### Scenario: Wait cap reached before the task settles
- **WHEN** the per-call wait cap elapses with no terminal or approval state observed
- **THEN** it returns `state: "pending"` and a `cursor` for the next call

#### Scenario: Resume from a cursor
- **WHEN** `wait_for_task` is called with a `cursor` returned by a prior call
- **THEN** it resumes polling from that cursor and does not reprocess events before it

### Requirement: Return correlation and round-trip evidence

On resolving a task, the result SHALL include the `task_id`, the `attribution` line (the first knowledge-log line, which carries the `@<U…:Name>` marker), and `pm_replies` (the `pm-agent` messages observed, possibly empty).

#### Scenario: Result payload shape
- **WHEN** a task is resolved in any state
- **THEN** the result includes `task_id`, `state`, `attribution`, and `pm_replies`

### Requirement: Poll incrementally

The tool SHALL poll events using the events endpoint's `after` cursor so that each poll after the first fetches only newly appended events rather than the full history.

#### Scenario: Incremental fetch across polls
- **WHEN** the tool polls one task repeatedly
- **THEN** each request after the first passes the `after` cursor and processes only events appended since the previous poll

### Requirement: Implemented over existing endpoints only

The capability SHALL be implemented entirely within the `archie-debug` MCP process using existing Archie REST endpoints, introducing no new Archie server endpoints and no change to task or runtime behavior.

#### Scenario: Only existing endpoints are used
- **WHEN** `wait_for_task` runs
- **THEN** it calls only existing endpoints (`/api/tasks`, `/api/tasks/:id`, `/api/tasks/:id/events?after=`) and the Archie runtime is unchanged
