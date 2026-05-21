// ABOUTME: Mounts the Ink TUI for a live research run, returns a waitForExit promise.
// ABOUTME: Used by the CLI in place of the streaming-log output when running in a TTY.

import React from "react";
import { render } from "ink";
import { TuiApp, type TuiAppProps } from "./App.js";

export type RunTuiHandle = {
  /** Resolves when the TUI unmounts (user quits or task completes). */
  waitForExit: Promise<void>;
  /** Programmatic unmount (e.g. on fatal task error). */
  unmount: () => void;
};

/** Mount the Ink TUI and return a handle the caller awaits. */
export function runTui(props: TuiAppProps): RunTuiHandle {
  const instance = render(<TuiApp {...props} />, {
    exitOnCtrlC: false, // App handles ctrl-c itself so the queue is honored
  });
  return {
    waitForExit: instance.waitUntilExit().then(() => undefined),
    unmount: () => instance.unmount(),
  };
}
