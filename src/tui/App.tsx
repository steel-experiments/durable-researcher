// ABOUTME: Main TUI component — live findings stream + steering input + agent status.
// ABOUTME: Subscribes to the research event bus and pushes user steering into the queue.

import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import type { ResearchEvent, ResearchEventBus } from "../event-bus.js";
import type { SteeringQueue } from "../steering-queue.js";
import type { ResearchNote } from "../types.js";
import type { UsageStats } from "../durable-turns.js";

export type TuiAppProps = {
  topic: string;
  maxSources: number;
  modelLabel: string;
  bus: ResearchEventBus;
  steeringQueue: SteeringQueue;
  /** Called when the user requests to quit while the task is still running. */
  onQuit?: () => void;
  /** Called when the user requests a post-completion extension run. */
  onExtend?: (instruction: string) => void;
};

type Activity =
  | { kind: "idle" }
  | { kind: "tool"; toolName: string; argSummary: string }
  | { kind: "thinking"; turn: number }
  | { kind: "finalizing" }
  | { kind: "verifying" }
  | { kind: "rewriting" };

type VerificationLine = {
  attempt: number;
  passRate: number;
  supported: number;
  total: number;
  willRewrite: boolean;
  status?: "passed" | "failed" | "no_claims";
  reason?: string;
};

/** One row in the live activity stream — a finished tool call (success or error). */
type ActivityLogEntry = {
  toolName: string;
  argSummary: string;
  summary: string;
  isError: boolean;
  /** ms timestamp; rendered as relative elapsed since run start. */
  ts: number;
};

const MAX_ACTIVITY_LOG = 50;
const ACTIVITY_VISIBLE = 6;
const NOTE_PREVIEW_CHARS = 110;
const EXTENSION_PRESETS = [
  "Find more sources and strengthen under-supported claims.",
  "Use primary sources only where possible.",
  "Find opposing evidence and alternative interpretations.",
  "Update the report with the latest available information.",
  "Expand the research, then rewrite the report with the new evidence.",
];

const CONFIDENCE_ICON: Record<ResearchNote["confidence"], string> = {
  high: "●",
  medium: "◐",
  low: "○",
};

const CONFIDENCE_COLOR: Record<ResearchNote["confidence"], string> = {
  high: "green",
  medium: "yellow",
  low: "gray",
};

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.slice(0, 30);
  }
}

/** Render wall-clock elapsed (used in the header timer). */
function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const ss = (s % 60).toString().padStart(2, "0");
  return `${m}:${ss}`;
}

/**
 * Render a per-event offset in the activity stream as `+M:SS`. Without the leading `+`
 * the eye reads `4:41` as HH:MM, which is wrong and clashes with the header's wall-clock
 * timer rendered right above it.
 */
function formatRelativeOffset(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const ss = (s % 60).toString().padStart(2, "0");
  return `+${m}:${ss}`;
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Short label for the tool stream — keeps lines uniform and scannable. */
const TOOL_LABEL: Record<string, string> = {
  plan_research: "plan",
  prefetch_sources: "prefetch",
  scout: "scout",
  web_search: "search",
  browse_url: "browse",
  screenshot: "screenshot",
  record_claims: "claims",
  evaluate_progress: "evaluate",
  submit_report: "submit",
  verify_claims: "verify",
};

function toolLabel(name: string): string {
  return TOOL_LABEL[name] ?? name;
}

export function TuiApp({
  topic,
  maxSources,
  modelLabel,
  bus,
  steeringQueue,
  onQuit,
  onExtend,
}: TuiAppProps) {
  const app = useApp();
  const [findings, setFindings] = useState<ResearchNote[]>([]);
  const [activity, setActivity] = useState<Activity>({ kind: "idle" });
  const [turn, setTurn] = useState(0);
  const [sources, setSources] = useState(0);
  const [startedAt] = useState(() => Date.now());
  const [elapsed, setElapsed] = useState(0);
  const [steeringMode, setSteeringMode] = useState(false);
  const [steeringDraft, setSteeringDraft] = useState("");
  const [extendMode, setExtendMode] = useState(false);
  const [extendDraft, setExtendDraft] = useState("");
  const [extendPresetIndex, setExtendPresetIndex] = useState(0);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Latest coarse-grained phase ("Loading checkpoint…", "Verifying citations…", …).
  // Shown next to AGENT when no fine-grained activity (tool/thinking) is live.
  const [statusText, setStatusText] = useState<string>("Starting...");
  // Rolling tail of the assistant's streamed text — last ~200 chars, reset between
  // turns/tool calls so we don't fossilize old output.
  const [thinkingText, setThinkingText] = useState<string>("");
  // Tail of finished tool calls, newest last. Bounded to MAX_ACTIVITY_LOG.
  const [activityLog, setActivityLog] = useState<ActivityLogEntry[]>([]);
  const [usage, setUsage] = useState<UsageStats | null>(null);
  const [verification, setVerification] = useState<VerificationLine | null>(null);
  // Pending tool calls keyed by toolCallId so parallel calls of the same tool don't
  // collide and lose their per-call argSummary.
  const pendingToolRef = useRef<Map<string, string>>(new Map());

  // Ticker for elapsed time
  useEffect(() => {
    const id = setInterval(() => setElapsed(Date.now() - startedAt), 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  // Subscribe to bus
  useEffect(() => {
    const unsubscribe = bus.subscribe((event: ResearchEvent) => {
      switch (event.type) {
        case "turn-start":
          setTurn(event.turn);
          setSources(event.sources);
          setActivity({ kind: "thinking", turn: event.turn });
          setThinkingText("");
          break;
        case "tool-start":
          setActivity({
            kind: "tool",
            toolName: event.toolName,
            argSummary: event.argSummary,
          });
          // Stash the args so the matching tool-end can render the full row.
          // Keyed by toolCallId so parallel calls of the same tool don't collide.
          pendingToolRef.current.set(event.toolCallId, event.argSummary);
          setThinkingText("");
          break;
        case "tool-end": {
          setActivity({ kind: "thinking", turn });
          const argSummary = pendingToolRef.current.get(event.toolCallId) ?? "";
          pendingToolRef.current.delete(event.toolCallId);
          const entry: ActivityLogEntry = {
            toolName: event.toolName,
            argSummary,
            summary: event.summary,
            isError: event.isError,
            ts: Date.now() - startedAt,
          };
          setActivityLog((prev) => {
            const next = [...prev, entry];
            return next.length > MAX_ACTIVITY_LOG
              ? next.slice(next.length - MAX_ACTIVITY_LOG)
              : next;
          });
          break;
        }
        case "usage-update":
          setUsage(event.usage);
          break;
        case "browse-added":
          setSources((n) => n + 1);
          break;
        case "note-added":
          setFindings((prev) => [...prev, event.note]);
          break;
        case "agent-text":
          // Keep a rolling tail — most useful is the latest sentence-or-so.
          setThinkingText((prev) => {
            const combined = prev + event.delta;
            return combined.length > 240 ? combined.slice(-240) : combined;
          });
          break;
        case "agent-status":
          setStatusText(event.text);
          break;
        case "snapshot":
          // Authoritative state from the persister after replay — overwrites
          // whatever the TUI accumulated locally.
          setFindings(event.notes);
          setSources(event.sources);
          setTurn(event.turn);
          break;
        case "report-text":
          setActivity({ kind: "finalizing" });
          setThinkingText("");
          break;
        case "phase":
          if (event.phase === "verifying") {
            setActivity({ kind: "verifying" });
            setThinkingText("");
          } else if (event.phase === "rewriting") {
            setActivity({ kind: "rewriting" });
            setThinkingText("");
          } else if (event.phase === "complete") {
            // Don't flip done here — wait for task-complete so the worker has
            // actually returned. `complete` just marks the pipeline finished.
            setActivity({ kind: "idle" });
          }
          break;
        case "verification-result":
          setVerification({
            attempt: event.attempt,
            passRate: event.passRate,
            supported: event.supported,
            total: event.total,
            willRewrite: event.willRewrite,
            status: event.status,
            reason: event.reason,
          });
          break;
        case "task-complete":
          setDone(true);
          setActivity({ kind: "idle" });
          break;
        case "task-error":
          setErrorMessage(event.message);
          setDone(true);
          break;
      }
    });
    return unsubscribe;
  }, [bus, turn]);

  // Brief confirmation flash after queuing a steering message
  useEffect(() => {
    if (!confirmation) return;
    const id = setTimeout(() => setConfirmation(null), 2500);
    return () => clearTimeout(id);
  }, [confirmation]);

  useInput(
    (input, key) => {
      if (extendMode) {
        if (key.escape) {
          setExtendDraft("");
          setExtendMode(false);
        }
        if (key.upArrow || key.downArrow) {
          const delta = key.upArrow ? -1 : 1;
          const next = (extendPresetIndex + delta + EXTENSION_PRESETS.length) % EXTENSION_PRESETS.length;
          setExtendPresetIndex(next);
          setExtendDraft(EXTENSION_PRESETS[next]);
        }
        return;
      }
      if (steeringMode) {
        if (key.escape) {
          setSteeringDraft("");
          setSteeringMode(false);
        }
        return;
      }
      if (input === "q" || (key.ctrl && input === "c")) {
        if (onQuit) onQuit();
        app.exit();
        return;
      }
      const canSteer =
        !done &&
        activity.kind !== "finalizing" &&
        activity.kind !== "verifying" &&
        activity.kind !== "rewriting";
      if (input === "s" && canSteer) {
        setSteeringMode(true);
        return;
      }
      if (input === "r" && canSteer) {
        steeringQueue.push(
          "Stop all tool use immediately. Write the final research report NOW using the notes you have collected.",
        );
        setConfirmation("Report requested — agent will finalize after the current turn.");
        return;
      }
      if (done && !errorMessage && input === "e") {
        setExtendPresetIndex(0);
        setExtendDraft(EXTENSION_PRESETS[0]);
        setExtendMode(true);
        return;
      }
      if (done && (key.return || input === "q")) {
        app.exit();
      }
    },
    { isActive: true },
  );

  return (
    <Box flexDirection="column" width="100%">
      {/* Header */}
      <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="row" justifyContent="space-between">
        <Text>
          <Text color="cyan" bold>research: </Text>
          <Text>"{topic}"</Text>
        </Text>
        <Text color="gray">{formatElapsed(elapsed)}</Text>
      </Box>

      {/* Findings */}
      <Box borderStyle="round" borderColor="gray" paddingX={1} flexDirection="column" minHeight={10}>
        <Box justifyContent="space-between">
          <Text bold>FINDINGS ({findings.length})</Text>
          <Text color="gray">live</Text>
        </Box>
        {findings.length === 0 ? (
          <Text color="gray">  (no findings yet — {statusText.toLowerCase()})</Text>
        ) : (
          findings.slice(-8).map((note, i) => {
            const sourceHost = note.sourceUrls[0] ? hostOf(note.sourceUrls[0]) : "—";
            const preview = note.content.replace(/\s+/g, " ").trim().slice(0, NOTE_PREVIEW_CHARS);
            const truncated = note.content.length > NOTE_PREVIEW_CHARS;
            return (
              <Box key={`${note.title}-${i}`} flexDirection="column">
                <Box flexDirection="row" justifyContent="space-between">
                  <Text>
                    <Text color={CONFIDENCE_COLOR[note.confidence]}>
                      {CONFIDENCE_ICON[note.confidence]}{" "}
                    </Text>
                    <Text color="gray">[{note.confidence.padEnd(4, " ")}]</Text>{" "}
                    <Text>{note.title}</Text>
                  </Text>
                  <Text color="gray">{sourceHost}</Text>
                </Box>
                {preview.length > 0 && (
                  <Text color="gray">     {preview}{truncated ? "…" : ""}</Text>
                )}
              </Box>
            );
          })
        )}
        {findings.length > 8 && (
          <Text color="gray">  …and {findings.length - 8} earlier</Text>
        )}
      </Box>

      {/* Activity stream — last N finished tool calls so the user can see what
          the agent is actually doing instead of only counters. */}
      <Box borderStyle="round" borderColor="gray" paddingX={1} flexDirection="column">
        <Box justifyContent="space-between">
          <Text bold>ACTIVITY</Text>
          <Text color="gray">{activityLog.length} call{activityLog.length === 1 ? "" : "s"}</Text>
        </Box>
        {activityLog.length === 0 ? (
          <Text color="gray">  (no tool calls yet)</Text>
        ) : (
          activityLog.slice(-ACTIVITY_VISIBLE).map((entry, i) => (
            <Box key={`${entry.ts}-${i}`} flexDirection="row">
              <Text color="gray">{formatRelativeOffset(entry.ts).padStart(7, " ")} </Text>
              <Text color={entry.isError ? "red" : "cyan"}>{toolLabel(entry.toolName)}</Text>
              {entry.argSummary.length > 0 && (
                <Text color="gray">{" "}{entry.argSummary}</Text>
              )}
              <Text color="gray">{" → "}</Text>
              <Text color={entry.isError ? "red" : "gray"}>{entry.summary}</Text>
            </Box>
          ))
        )}
      </Box>

      {/* Status */}
      <Box borderStyle="round" borderColor="gray" paddingX={1} flexDirection="column">
        <Text>
          <Text color="magenta" bold>AGENT  </Text>
          {activity.kind === "tool" ? (
            <Text>
              {activity.toolName}
              <Text color="gray">({activity.argSummary})</Text>
            </Text>
          ) : activity.kind === "thinking" ? (
            <Text color="gray">thinking…</Text>
          ) : activity.kind === "finalizing" ? (
            <Text color="gray">finalizing…</Text>
          ) : activity.kind === "verifying" ? (
            <Text color="yellow">verifying citations…</Text>
          ) : activity.kind === "rewriting" ? (
            <Text color="yellow">rewriting report (citation fix)…</Text>
          ) : done ? (
            <Text color="green">complete — press enter to exit</Text>
          ) : (
            // No fine-grained activity yet — show the most recent phase string
            // ("Loading checkpoint…", "Verifying citations…") instead of bare "idle".
            <Text color="gray">{statusText}</Text>
          )}
        </Text>
        <Text color="gray">
          {sources}/{maxSources} sources{sources > maxSources ? " after current batch" : ""} · turn {turn} · {modelLabel}
          {usage && (usage.inputTokens > 0 || usage.outputTokens > 0) ? (
            <Text color="gray">
              {" · "}
              <Text color="white">{formatTokens(usage.inputTokens)}</Text>
              {" in / "}
              <Text color="white">{formatTokens(usage.outputTokens)}</Text>
              {" out"}
              {usage.cacheReadTokens > 0 && (
                <Text color="gray">
                  {" · "}
                  <Text color="green">{formatTokens(usage.cacheReadTokens)}</Text>
                  {" cached"}
                </Text>
              )}
            </Text>
          ) : null}
        </Text>
        {/* Stream the assistant's text-in-flight when present so the user sees
            *something* during the gap between turn start and the next tool call. */}
        {!done && thinkingText.length > 0 && (
          <Text color="cyan" dimColor>
            {thinkingText.replace(/\s+/g, " ").trim()}
          </Text>
        )}
        {verification && (
          <Text color={verification.status === "passed" ? "green" : "yellow"}>
            verify #{verification.attempt}: {verification.supported}/{verification.total}{" "}
            supported ({Math.round(verification.passRate * 100)}%)
            {verification.willRewrite
              ? " — rewriting"
              : verification.status === "passed"
                ? " — passed"
                : " — failed"}
            {verification.reason ? `: ${verification.reason}` : ""}
          </Text>
        )}
        {errorMessage && (
          <Text color="red">error: {errorMessage}</Text>
        )}
        {confirmation && (
          <Text color="yellow">{confirmation}</Text>
        )}
      </Box>

      {/* Steering input or help */}
      {extendMode ? (
        <Box borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column">
          <Text color="yellow" bold>extend research (up/down presets, enter to start, esc to cancel)</Text>
          <Box flexDirection="row">
            <Text color="cyan">{"> "}</Text>
            <TextInput
              value={extendDraft}
              onChange={setExtendDraft}
              onSubmit={(value) => {
                const trimmed = value.trim();
                onExtend?.(
                  trimmed.length > 0
                    ? trimmed
                    : EXTENSION_PRESETS[0],
                );
                setExtendDraft("");
                setExtendMode(false);
                app.exit();
              }}
            />
          </Box>
        </Box>
      ) : steeringMode ? (
        <Box borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column">
          <Text color="yellow" bold>steer the agent (enter to send, esc to cancel)</Text>
          <Box flexDirection="row">
            <Text color="cyan">{"> "}</Text>
            <TextInput
              value={steeringDraft}
              onChange={setSteeringDraft}
              onSubmit={(value) => {
                const trimmed = value.trim();
                if (trimmed.length > 0) {
                  steeringQueue.push(trimmed);
                  setConfirmation(`Queued: "${trimmed.slice(0, 60)}${trimmed.length > 60 ? "…" : ""}"`);
                }
                setSteeringDraft("");
                setSteeringMode(false);
              }}
            />
          </Box>
        </Box>
      ) : (
        <Box paddingX={1}>
          <Text color="gray">
            {done
              ? errorMessage
                ? "[enter] exit  [q] quit"
                : "[e] extend research  [enter] exit  [q] quit"
              : activity.kind === "finalizing"
              ? "finalizing task…"
              : activity.kind === "verifying"
              ? "verifying citations… [q] quit"
              : activity.kind === "rewriting"
              ? "rewriting (citation fix)… [q] quit"
              : "[s] steer  [r] write report now  [q] quit"}
          </Text>
        </Box>
      )}
    </Box>
  );
}
