// ABOUTME: Main TUI component — live findings stream + steering input + agent status.
// ABOUTME: Subscribes to the research event bus and pushes user steering into the queue.

import React, { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import type { ResearchEvent, ResearchEventBus } from "../event-bus.js";
import type { SteeringQueue } from "../steering-queue.js";
import type { ResearchNote } from "../types.js";

export type TuiAppProps = {
  topic: string;
  maxSources: number;
  modelLabel: string;
  bus: ResearchEventBus;
  steeringQueue: SteeringQueue;
  /** Called when the user requests to quit while the task is still running. */
  onQuit?: () => void;
};

type Activity =
  | { kind: "idle" }
  | { kind: "tool"; toolName: string; argSummary: string }
  | { kind: "thinking"; turn: number }
  | { kind: "finalizing" };

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

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const ss = (s % 60).toString().padStart(2, "0");
  return `${m}:${ss}`;
}

export function TuiApp({
  topic,
  maxSources,
  modelLabel,
  bus,
  steeringQueue,
  onQuit,
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
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Latest coarse-grained phase ("Loading checkpoint…", "Verifying citations…", …).
  // Shown next to AGENT when no fine-grained activity (tool/thinking) is live.
  const [statusText, setStatusText] = useState<string>("Starting...");
  // Rolling tail of the assistant's streamed text — last ~200 chars, reset between
  // turns/tool calls so we don't fossilize old output.
  const [thinkingText, setThinkingText] = useState<string>("");

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
          setThinkingText("");
          break;
        case "tool-end":
          setActivity({ kind: "thinking", turn });
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
      const canSteer = !done && activity.kind !== "finalizing";
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
          findings.slice(-15).map((note, i) => {
            const sourceHost = note.sourceUrls[0] ? hostOf(note.sourceUrls[0]) : "—";
            return (
              <Box key={`${note.title}-${i}`} flexDirection="row" justifyContent="space-between">
                <Text>
                  <Text color={CONFIDENCE_COLOR[note.confidence]}>
                    {CONFIDENCE_ICON[note.confidence]}{" "}
                  </Text>
                  <Text color="gray">[{note.confidence.padEnd(4, " ")}]</Text>{" "}
                  <Text>{note.title}</Text>
                </Text>
                <Text color="gray">{sourceHost}</Text>
              </Box>
            );
          })
        )}
        {findings.length > 15 && (
          <Text color="gray">  …and {findings.length - 15} earlier</Text>
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
          ) : done ? (
            <Text color="green">complete — press enter to exit</Text>
          ) : (
            // No fine-grained activity yet — show the most recent phase string
            // ("Loading checkpoint…", "Verifying citations…") instead of bare "idle".
            <Text color="gray">{statusText}</Text>
          )}
        </Text>
        <Text color="gray">
          {sources}/{maxSources} sources · turn {turn} · {modelLabel}
        </Text>
        {/* Stream the assistant's text-in-flight when present so the user sees
            *something* during the gap between turn start and the next tool call. */}
        {!done && thinkingText.length > 0 && (
          <Text color="cyan" dimColor>
            {thinkingText.replace(/\s+/g, " ").trim()}
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
      {steeringMode ? (
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
              ? "[enter] exit  [q] quit"
              : activity.kind === "finalizing"
              ? "finalizing task…"
              : "[s] steer  [r] write report now  [q] quit"}
          </Text>
        </Box>
      )}
    </Box>
  );
}
