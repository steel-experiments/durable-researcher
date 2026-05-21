// ABOUTME: FIFO queue holding user-supplied steering messages between agent turns.
// ABOUTME: The TUI pushes; getSteeringMessages drains and injects them at the next turn boundary.

export type SteeringQueue = {
  push(message: string): void;
  drain(): string[];
  size(): number;
};

/** Create an in-process FIFO queue of user steering messages. */
export function createSteeringQueue(): SteeringQueue {
  let buffer: string[] = [];

  return {
    push(message: string) {
      const trimmed = message.trim();
      if (trimmed.length === 0) return;
      buffer.push(trimmed);
    },
    drain() {
      const out = buffer;
      buffer = [];
      return out;
    },
    size() {
      return buffer.length;
    },
  };
}
