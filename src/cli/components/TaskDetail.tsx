import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import Spinner from 'ink-spinner';
import { ScrollView, type ScrollViewRef } from 'ink-scroll-view';
import { fetchTaskDetail, fetchTaskEvents, sendMessage, sendApproval } from '../api.js';
import { MessageInput } from './MessageInput.js';
import type { PrCardData } from '../../types/task.js';
import { prCardSubtitle, CLI_PR_CARD_EMOJI } from '../../system/pr-card-format.js';
import { renderMarkdown } from '../markdown.js';

/**
 * Render a PR card from a `pr_card` event's data. Two lines: a colored title row
 * (`#num branch`) and a dimmed subtitle (`repo · CI summary`) + URL — the same
 * content shown on Slack, with unicode emoji instead of Slack shortcodes.
 */
function renderPrCard(d: Record<string, unknown>): React.ReactNode {
  const card: PrCardData = {
    repo: String(d.repo ?? ''),
    prNumber: Number(d.prNumber ?? 0),
    url: String(d.url ?? ''),
    headRef: String(d.headRef ?? ''),
    state: (d.state as PrCardData['state']) ?? 'open',
    head_sha: String(d.head_sha ?? ''),
    ci: (d.ci as PrCardData['ci']) ?? 'none',
    ciPassed: Number(d.ciPassed ?? 0),
    ciTotal: Number(d.ciTotal ?? 0),
  };
  const color = card.state === 'merged' ? 'magenta' : card.state === 'closed' ? 'red' : 'cyan';
  const title = `#${card.prNumber} ${card.headRef}`;
  const subtitle = `${prCardSubtitle(card, CLI_PR_CARD_EMOJI)} · ${card.url}`;
  return <Text color={color}>{title}{'\n'}<Text dimColor>{subtitle}</Text></Text>;
}

/**
 * Format message for CLI display using from, to, and destination fields.
 *
 * Patterns:
 *   [cli] @pm-agent message                      — CLI input
 *   [Dana in #bot-test] @pm-agent message         — Slack incoming
 *   [pm-agent in #bot-test] message               — agent posting to a channel
 *   [pm-agent in cli] message                     — agent posting to CLI
 *   [pm-agent] @backend-agent message             — agent messaging another agent
 */
function formatMessageParts(from: string, to: string, destination?: string): { label: string; mention: string } {
  const label = destination ? `${from} in ${destination}` : from;
  const mention = from !== to && to !== 'user' ? ` @${to}` : '';
  return { label, mention };
}

/**
 * Which log entries are shown in full by default vs. folded. Visible: the
 * PM↔user conversation and actionable/tracked items. Foldable: inter-agent
 * chatter, findings, and background tasks. Pure + exported for unit testing.
 */
export function classifyEvent(type: string, from?: string, to?: string): 'visible' | 'foldable' {
  if (type === 'message') {
    // A message is part of the PM↔user conversation (shown in full) when it's
    // addressed to the user, or its sender is a human rather than an agent.
    // Agents are `<name>-agent`; a human sender is `cli` or a real name. So an
    // inter-agent message (agent→agent/pm) is the only foldable message.
    return to === 'user' || isUserSender(from) ? 'visible' : 'foldable';
  }
  if (type === 'agent:log' || type === 'agent:bg_task') return 'foldable';
  return 'visible'; // approvals, pr_card, reminders, and anything else
}

/** Non-human, non-agent senders that appear in the message stream: CI/webhook
 * events (`from:'ci'`) and system notices (`from:'system'`, e.g. the wall-clock
 * pause). These are neither agents (they don't end in `-agent`) nor the user. */
const NON_USER_SENDERS = new Set(['ci', 'system']);

/** A message sender that is a human — the CLI operator (`cli`) or a named
 * person (Slack real name) — as opposed to an agent (`<name>-agent`) or a
 * system/CI sender. Used to both classify and visually mark the user's own
 * messages. */
export function isUserSender(from?: string): boolean {
  return !!from && !from.endsWith('-agent') && !NON_USER_SENDERS.has(from);
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

interface AgentStatus {
  agent: string;
  active: boolean;
  last_activity?: string;
}

interface SystemEvent {
  type: string;
  taskId: string;
  timestamp: string;
  agentName?: string;
  data: Record<string, unknown>;
}

interface TaskDetailProps {
  taskId: string;
  onBack: () => void;
  /** Append-only queue of live SSE events from the parent (accumulated so bursts
   *  aren't lost to React batching). TaskDetail processes the delta each render. */
  liveEvents?: SystemEvent[];
  onConnect?: boolean;
}

// Extract the PR identity a merge approval must send back to the API. The
// approve route rejects type:'merge' without github+pr_number; other approval
// types carry no identity and resolve with it omitted (backward compatible).
function mergeIdentity(
  approval: { approvalType: string; github?: string; pr_number?: number },
): { github: string; pr_number: number } | undefined {
  return approval.approvalType === 'merge' && approval.github && typeof approval.pr_number === 'number'
    ? { github: approval.github, pr_number: approval.pr_number }
    : undefined;
}

// Check if a given approval:requested event has been resolved
function isApprovalResolved(req: SystemEvent, allEvents: SystemEvent[]): boolean {
  const reqType = req.data.approvalType as string;
  return allEvents.some(
    (e) =>
      e.type === 'approval:resolved' &&
      // Match by approval type — resolved events use `type` field
      (e.data.type as string) === reqType &&
      e.timestamp > req.timestamp,
  );
}

export function TaskDetail({ taskId, onBack, liveEvents, onConnect }: TaskDetailProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const termHeight = stdout?.rows ?? 24;
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  const [events, setEvents] = useState<SystemEvent[]>([]);
  const [eventCursor, setEventCursor] = useState(0);
  const [fallbackLines, setFallbackLines] = useState<string[]>([]); // knowledge.log for old tasks
  const [inputActive, setInputActive] = useState(true);
  const [focusedLine, setFocusedLine] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('');
  // Live "Archie is …" indicator — the same line pushed to Slack, mirrored here
  // so the status can be tested without Slack. Transient; not persisted.
  const [liveStatus, setLiveStatus] = useState<string>('');
  const [reminder, setReminder] = useState<{ trigger_at: string; reason: string } | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const processedRef = useRef(0); // count of liveEvents already applied
  const prevOnConnect = useRef<boolean | undefined>(undefined);
  const scrollRef = useRef<ScrollViewRef>(null);
  const autoScroll = useRef(true); // stick to bottom unless user scrolls up
  const [linesBelow, setLinesBelow] = useState(0);
  const [expandedFolds, setExpandedFolds] = useState<Set<string>>(new Set());
  const escapeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reserve lines: header(1) + agents(1) + margin(1) + indicator/gap(2) + input(1)
  const reservedLines = 6;
  const logHeight = Math.max(5, termHeight - reservedLines);
  // Wrap width for rendered markdown (leave a small margin inside the log box).
  const mdWidth = Math.max(40, (stdout?.columns ?? 80) - 2);

  // Build log lines with inline approvals
  const logLines: { node?: React.ReactNode; approval?: { approvalType: 'edit_mode' | 'research_budget' | 'merge' | 'trigger' | 'max_mode'; eventIndex: number; github?: string; pr_number?: number; ref?: string }; fold?: { id: string; summary: React.ReactNode; full: React.ReactNode } }[] = [];

  // Fold pr_card events so a card renders once, at its most recent `post`
  // (anchor), showing the latest merged state. `update` events refresh the data
  // without moving the card; a fresh `post` re-anchors it to the bottom.
  const prCardAnchor = new Map<string, number>();
  const prCardLatest = new Map<string, Record<string, unknown>>();
  events.forEach((e, idx) => {
    if (e.type !== 'pr_card') return;
    const cardId = e.data.cardId as string | undefined;
    if (!cardId) return;
    prCardLatest.set(cardId, e.data);
    if (e.data.action === 'post' || !prCardAnchor.has(cardId)) {
      prCardAnchor.set(cardId, idx);
    }
  });

  const FOLD_MIN_CHARS = 80;
  const oneLine = (s: string, n = FOLD_MIN_CHARS): string => {
    const flat = s.replace(/\s+/g, ' ').trim();
    return flat.length > n ? flat.slice(0, n) + '…' : flat;
  };
  // A foldable entry that's already short (fits the one-line summary without
  // truncation) is shown inline instead of collapsed — there's nothing to hide.
  const isShort = (s: string): boolean => s.replace(/\s+/g, ' ').trim().length <= FOLD_MIN_CHARS;

  if (events.length > 0) {
    events.forEach((event, idx) => {
      switch (event.type) {
        case 'message': {
          const p = formatMessageParts(event.data.from as string, event.data.to as string, event.data.destination as string | undefined);
          const footer = event.data.footer as string | undefined;
          const body = event.data.message as string;
          const fromStr = event.data.from as string;
          const fromUser = isUserSender(fromStr);
          const isPm = fromStr === 'pm-agent';
          // Distinct labels so the conversation is scannable: the user's own
          // messages green ([you] for the CLI operator, the name for Slack), the
          // PM cyan (the agent you talk to), every other agent gray.
          const isAgent = !fromUser && !isPm; // a non-PM agent → whole line recedes to gray
          const label = fromUser
            ? <Text color="green" bold>[{fromStr === 'cli' ? 'you' : p.label}]</Text>
            : isPm
              ? <Text color="cyan" bold>[{p.label}]</Text>
              : <Text color="gray">[{p.label}]</Text>;
          const full = <>{label}{p.mention ? <Text color="cyan">{p.mention}</Text> : null} <Text color={isAgent ? 'gray' : undefined}>{renderMarkdown(body, mdWidth)}</Text>{footer ? <Text dimColor>{'\n'}{footer}</Text> : null}</>;
          if (classifyEvent('message', event.data.from as string, event.data.to as string) === 'visible' || isShort(body)) {
            // Visible conversation, OR a short inter-agent message — show inline.
            logLines.push({ node: full });
          } else {
            const summary = <Text color="gray">▸ [{p.label}]{p.mention ? ` @${event.data.to}` : ''}  {oneLine(body)} (Enter to expand)</Text>;
            logLines.push({ fold: { id: String(idx), summary, full: <><Text color="gray">▾ </Text>{full}</> } });
          }
          break;
        }
        case 'pr_card': {
          const cardId = event.data.cardId as string | undefined;
          if (!cardId || prCardAnchor.get(cardId) !== idx) break; // render once, at the anchor
          logLines.push({ node: renderPrCard(prCardLatest.get(cardId) ?? event.data) });
          break;
        }
        case 'agent:log': {
          const finding = event.data.finding as string;
          const full = <Text color="gray">[{event.agentName}] {renderMarkdown(finding, mdWidth)}</Text>;
          if (isShort(finding)) {
            logLines.push({ node: full });
          } else {
            const summary = <Text color="gray">▸ [{event.agentName}] finding: {oneLine(finding)} (Enter to expand)</Text>;
            logLines.push({ fold: { id: String(idx), summary, full: <><Text color="gray">▾ </Text>{full}</> } });
          }
          break;
        }
        case 'agent:bg_task': {
          // One entry per background task, keyed by task_id: render the 'start' as
          // ⏳ running, and once the matching 'end' has arrived (events is rebuilt on
          // every update) fold it into ✅/❌. Skip the 'end' itself.
          if (event.data.action !== 'start') break;
          const key = event.data.key as string;
          const ended = events.find(
            (e) => e.type === 'agent:bg_task' && e.data.action === 'end' && e.data.key === key,
          );
          const desc = (event.data.description as string) || 'background task';
          if (ended) {
            const status = ended.data.status as string;
            const node = <Text color="gray">{status === 'completed' ? '✅' : '❌'} [{event.agentName}] background task {status} — {desc}</Text>;
            logLines.push({ node });
          } else {
            const node = <Text color="yellow">⏳ [{event.agentName}] background task running — {desc}</Text>;
            logLines.push({ node });
          }
          break;
        }
        case 'approval:requested': {
          const resolved = isApprovalResolved(event, events);
          if (resolved) {
            logLines.push({
              node: <Text dimColor>✅ {event.data.text as string} (resolved)</Text>,
            });
          } else {
            logLines.push({
              node: <Text color="yellow" bold>⏳ {event.data.text as string}  [y] approve / [n] deny</Text>,
              approval: {
                approvalType: event.data.approvalType as 'edit_mode' | 'research_budget' | 'merge' | 'trigger' | 'max_mode',
                ref: event.data.ref as string | undefined,
                eventIndex: idx,
                // Merge approvals carry the PR identity; the API requires it on
                // resolution. Absent for other types (undefined → omitted).
                github: event.data.github as string | undefined,
                pr_number: event.data.pr_number as number | undefined,
              },
            });
          }
          break;
        }
        case 'approval:resolved':
          logLines.push({
            node: <Text>{event.data.approve ? '✅' : '❌'} Approval {event.data.approve ? 'granted' : 'denied'}: {event.data.type as string}</Text>,
          });
          break;
        case 'reminder:set':
          logLines.push({
            node: <Text color="magenta">⏰ Reminder set for {formatDateTime(event.data.trigger_at as string)} — {event.data.reason as string}</Text>,
          });
          break;
        case 'reminder:cancelled':
          logLines.push({
            node: <Text dimColor>⏰ Reminder cancelled</Text>,
          });
          break;
        case 'reminder:fired':
          logLines.push({
            node: <Text color="magenta">⏰ Reminder fired — {event.data.reason as string}</Text>,
          });
          break;
        default:
          break;
      }
    });
  } else if (fallbackLines.length > 0) {
    logLines.push({ node: <Text>{renderMarkdown(fallbackLines.join('\n'), mdWidth)}</Text> });
  }

  // Focusable rows: foldable rows and pending approvals (in display order).
  const focusableLines = logLines
    .map((l, i) => (l.fold || l.approval ? i : -1))
    .filter((i) => i >= 0);

  const focusedApproval = focusedLine !== null
    ? logLines[focusedLine]?.approval ?? null
    : null;
  const focusedFold = focusedLine !== null
    ? logLines[focusedLine]?.fold ?? null
    : null;

  // Initial load: fetch metadata + events
  const loadInitial = useCallback(async () => {
    try {
      const [detail, eventsResult] = await Promise.all([
        fetchTaskDetail(taskId),
        fetchTaskEvents(taskId),
      ]);
      setStatus(detail.metadata?.status || '');
      setReminder(detail.metadata?.reminder ?? null);
      setTitle(detail.metadata?.title ?? null);
      setAgents(detail.agents || []);
      setLiveStatus(''); // ephemeral — repopulates from the next `status` event
      setEvents(eventsResult.events);
      setEventCursor(eventsResult.total);

      // Fallback: if no events.jsonl yet, render from knowledge.log
      if (eventsResult.events.length === 0 && detail.knowledgeLog) {
        setFallbackLines(detail.knowledgeLog.split('\n').filter((l: string) => l.trim()));
      } else {
        setFallbackLines([]);
      }

      setError(null);
      // Scroll to bottom after initial load
      setTimeout(() => scrollRef.current?.scrollToBottom(), 50);
    } catch (err: any) {
      setError(err.message);
    }
  }, [taskId]);

  useEffect(() => {
    loadInitial();
  }, [loadInitial]);

  // Handle live SSE events from parent. `liveEvents` is an append-only queue, so
  // process only the delta since the last render and apply each event in order —
  // nothing is dropped when several arrive in the same tick.
  useEffect(() => {
    const queue = liveEvents ?? [];
    // Buffer was reset (task switch / fresh connect) — start from the top.
    if (processedRef.current > queue.length) processedRef.current = 0;
    const fresh = queue.slice(processedRef.current);
    if (fresh.length === 0) return;
    processedRef.current = queue.length;

    for (const ev of fresh) {
      // Live status is transient UI, not a log entry — never lands in scrollback.
      if (ev.type === 'status') {
        setLiveStatus((ev.data?.status as string) || '');
        continue;
      }

      setEvents((prev) => [...prev, ev]);
      setEventCursor((c) => c + 1);

      // Update agents bar from agent events
      if (ev.type === 'agent:active' || ev.type === 'agent:inactive') {
        setAgents((prev) => {
          const existing = prev.find((a) => a.agent === ev.agentName);
          const active = ev.type === 'agent:active';
          if (existing) {
            return prev.map((a) => a.agent === ev.agentName ? { ...a, active } : a);
          }
          return [...prev, { agent: ev.agentName!, active }];
        });
      }

      // Update status from task events
      if (ev.type === 'task:resumed') setStatus('in_progress');
      if (ev.type === 'task:completed') { setStatus('completed'); setLiveStatus(''); }
      if (ev.type === 'task:stopped') { setStatus('stopped'); setLiveStatus(''); }

      // Update reminder from reminder events
      if (ev.type === 'reminder:set') {
        setReminder({ trigger_at: ev.data.trigger_at as string, reason: ev.data.reason as string });
      }
      if (ev.type === 'reminder:cancelled' || ev.type === 'reminder:fired') {
        setReminder(null);
      }
    }

    // Auto-scroll to bottom when new events arrive (if user hasn't scrolled up)
    if (autoScroll.current) {
      setTimeout(() => scrollRef.current?.scrollToBottom(), 0);
    }
  }, [liveEvents]);

  // Keep the focused row in view: when focus moves (Tab/Shift+Tab) or a focused
  // fold expands/collapses, scroll minimally so the row is fully visible. Runs
  // after paint (setTimeout 0) so the ScrollView has re-measured item heights.
  useEffect(() => {
    if (focusedLine === null) return;
    const t = setTimeout(() => {
      const ref = scrollRef.current;
      if (!ref) return;
      const pos = ref.getItemPosition(focusedLine);
      if (!pos) return;
      const offset = ref.getScrollOffset();
      const vh = ref.getViewportHeight();
      if (pos.top < offset) {
        ref.scrollTo(pos.top);
      } else if (pos.top + pos.height > offset + vh) {
        ref.scrollTo(pos.top + pos.height - vh);
      }
    }, 0);
    return () => clearTimeout(t);
  }, [focusedLine, expandedFolds]);

  // Handle reconnect — fetch missed events
  useEffect(() => {
    if (onConnect !== undefined && onConnect !== prevOnConnect.current) {
      const wasDisconnected = prevOnConnect.current === false;
      prevOnConnect.current = onConnect;
      if (onConnect && wasDisconnected) {
        // Reconnected — fetch events we missed
        fetchTaskEvents(taskId, eventCursor).then((result) => {
          if (result.events.length > 0) {
            setEvents((prev) => [...prev, ...result.events]);
            setEventCursor(result.total);
          }
        }).catch(() => { /* ignore reconnect errors */ });
      }
    }
  }, [onConnect, taskId, eventCursor]);

  useInput((input, key) => {
    if (key.escape) {
      // Debounce: option+arrow sends escape before the arrow key arrives.
      // Schedule onBack, cancel if an arrow key comes within 50ms.
      if (escapeTimer.current) clearTimeout(escapeTimer.current);
      escapeTimer.current = setTimeout(() => {
        escapeTimer.current = null;
        onBack();
      }, 50);
      return;
    } else if (key.tab && key.shift) {
      // Shift+Tab: the reverse of Tab — move focus downward (top→bottom).
      // Checked before plain Tab since Shift+Tab also sets key.tab.
      if (inputActive) {
        if (focusableLines.length > 0) {
          setInputActive(false);
          setFocusedLine(focusableLines[0]);
        }
      } else if (focusedLine !== null) {
        const cur = focusableLines.indexOf(focusedLine);
        if (cur >= 0 && cur < focusableLines.length - 1) {
          setFocusedLine(focusableLines[cur + 1]);
        } else {
          setInputActive(true);
          setFocusedLine(null);
        }
      } else {
        setInputActive(true);
        setFocusedLine(null);
      }
    } else if (key.tab) {
      // Tab cycles bottom→top: input → last focusable row → … → first → input.
      // Starting from the bottom matches what the user sees first (newest
      // entries are at the bottom of the log).
      if (inputActive) {
        // Nothing to browse → stay in the input rather than stranding focus.
        if (focusableLines.length > 0) {
          setInputActive(false);
          setFocusedLine(focusableLines[focusableLines.length - 1]);
        }
      } else if (focusedLine !== null) {
        const cur = focusableLines.indexOf(focusedLine);
        if (cur > 0) {
          setFocusedLine(focusableLines[cur - 1]);
        } else {
          setInputActive(true);
          setFocusedLine(null);
        }
      } else {
        setInputActive(true);
        setFocusedLine(null);
      }
    } else if (!inputActive) {
      if (input === 'q' || input === 'Q') exit();
      if (focusedApproval && (input === 'y' || input === 'Y')) {
        sendApproval(taskId, focusedApproval.approvalType, true, mergeIdentity(focusedApproval), focusedApproval.ref).catch((err: any) => setError(err.message));
        setFocusedLine(null);
        setInputActive(true);
      } else if (focusedApproval && (input === 'n' || input === 'N')) {
        sendApproval(taskId, focusedApproval.approvalType, false, mergeIdentity(focusedApproval), focusedApproval.ref).catch((err: any) => setError(err.message));
        setFocusedLine(null);
        setInputActive(true);
      } else if (focusedFold && (key.return || key.rightArrow || key.leftArrow)) {
        const id = focusedFold.id;
        setExpandedFolds((prev) => {
          const next = new Set(prev);
          if (key.rightArrow) next.add(id);
          else if (key.leftArrow) next.delete(id);
          else next.has(id) ? next.delete(id) : next.add(id); // Enter toggles
          return next;
        });
      }
    }

    // Cancel pending escape if arrow key follows (option+arrow sequence)
    if (key.upArrow || key.downArrow) {
      if (escapeTimer.current) {
        clearTimeout(escapeTimer.current);
        escapeTimer.current = null;
      }
    }

    // Scroll with arrows (always available) — clear focused approval when scrolling
    const scrollStep = key.meta ? 10 : 1;
    if (key.upArrow) {
      setFocusedLine(null);
      const refUp = scrollRef.current;
      if (refUp) {
        const current = refUp.getScrollOffset();
        refUp.scrollTo(Math.max(0, current - scrollStep));
      }
    } else if (key.downArrow) {
      setFocusedLine(null);
      const refDown = scrollRef.current;
      if (refDown) {
        const current = refDown.getScrollOffset();
        const bottom = refDown.getBottomOffset();
        refDown.scrollTo(Math.min(bottom, current + scrollStep));
      }
    }
  });

  const handleSendMessage = async (message: string) => {
    try {
      await sendMessage(taskId, message);
    } catch (err: any) {
      setError(err.message);
    }
  };

  if (error) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red">Error: {error}</Text>
        <Text dimColor>Press Esc to go back</Text>
      </Box>
    );
  }

  // logHeight computed above, near hooks

  return (
    <Box flexDirection="column" height={termHeight}>
      {/* Header */}
      <Box paddingX={1}>
        <Text wrap="truncate-end">
          <Text bold>Task: {taskId}</Text>
          {title && <Text>  {title}</Text>}
          <Text dimColor>  status: </Text>
          <Text color={status === 'in_progress' ? 'yellow' : status === 'completed' ? 'green' : 'red'}>
            {status}
          </Text>
          {reminder && (
            <Text color="magenta">  ⏰ {formatDateTime(reminder.trigger_at)}</Text>
          )}
        </Text>
      </Box>

      {/* Agents bar */}
      <Box paddingX={1} gap={2}>
        {agents.length > 0 ? (
          agents.map((a) => (
            <Box key={a.agent} gap={1}>
              {a.active ? (
                <Text color="green"><Spinner type="dots" /></Text>
              ) : (
                <Text color="gray">○</Text>
              )}
              <Text color={a.active ? 'green' : 'gray'}>{a.agent}</Text>
            </Box>
          ))
        ) : (
          <Text dimColor>No agents</Text>
        )}
      </Box>

      {/* Event log — fills available space, scrollable with arrow keys */}
      {logLines.length === 0 ? (
        <Box height={logHeight} paddingX={1} marginTop={1}>
          <Text dimColor>No log entries yet</Text>
        </Box>
      ) : (
        <ScrollView
          ref={scrollRef}
          height={logHeight}
          paddingX={1}
          marginTop={1}
          onScroll={() => {
            const ref = scrollRef.current;
            if (ref) {
              const bottom = ref.getBottomOffset();
              const offset = ref.getScrollOffset();
              autoScroll.current = offset >= bottom;
              setLinesBelow(Math.max(0, bottom - offset));
            }
          }}
        >
          {logLines.map((line, i) => {
            const isFocused = i === focusedLine;
            const node = line.fold
              ? (expandedFolds.has(line.fold.id) ? line.fold.full : line.fold.summary)
              : line.node;
            return (
              // Focus is shown by a leading cursor (❯), NOT by inverting the
              // whole row — inverse fought the markdown ANSI colors and made an
              // expanded message hard to read.
              <Box key={i} marginBottom={1}>
                {/* Fixed 2-col gutter (flexShrink:0 so a wrapping body can't
                    collapse the cursor's trailing space); body grows + wraps. */}
                <Box flexShrink={0}><Text color="cyan" bold>{isFocused ? '❯ ' : '  '}</Text></Box>
                <Box flexGrow={1}><Text wrap="wrap">{node}</Text></Box>
              </Box>
            );
          })}
        </ScrollView>
      )}
      <Box paddingX={1} height={2} flexDirection="column" justifyContent="flex-end">
        {liveStatus ? (
          <Box gap={1}>
            <Text color="cyan"><Spinner type="dots" /></Text>
            <Text dimColor>Archie {liveStatus}</Text>
          </Box>
        ) : null}
        {linesBelow > 0 && (
          <Text dimColor>↓ {linesBelow} more below</Text>
        )}
      </Box>

      {/* Message input */}
      <Box paddingX={1}>
        <MessageInput
          onSubmit={handleSendMessage}
          active={inputActive}
          placeholder={inputActive ? 'Type message to PM...' : 'Browsing messages — Tab to cycle, Tab past the top to type'}
        />
      </Box>
    </Box>
  );
}

export type { AgentStatus };
