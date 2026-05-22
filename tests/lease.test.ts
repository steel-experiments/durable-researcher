// ABOUTME: Tests for lease-detection helpers (workerId parsing, dead-PID detection).
// ABOUTME: Database-touching paths are exercised by integration runs, not unit tests.

import { describe, it, expect } from "vitest";
import * as os from "os";
import {
  defaultWorkerId,
  isPidDead,
  parseWorkerId,
} from "../src/lease.js";

describe("parseWorkerId", () => {
  it("splits `hostname:pid` into host and pid", () => {
    expect(parseWorkerId("MacBook-Pro.local:12345")).toEqual({
      host: "MacBook-Pro.local",
      pid: 12345,
    });
  });

  it("uses the last colon so hostnames containing colons round-trip", () => {
    expect(parseWorkerId("ip6:colon:host:42")).toEqual({
      host: "ip6:colon:host",
      pid: 42,
    });
  });

  it("returns null for missing or empty input", () => {
    expect(parseWorkerId(null)).toBeNull();
    expect(parseWorkerId("")).toBeNull();
  });

  it("returns null when there is no colon", () => {
    expect(parseWorkerId("just-a-host")).toBeNull();
  });

  it("returns null when the pid is not a positive integer", () => {
    expect(parseWorkerId("host:abc")).toBeNull();
    expect(parseWorkerId("host:0")).toBeNull();
    expect(parseWorkerId("host:-1")).toBeNull();
  });
});

describe("isPidDead", () => {
  it("returns false for the current process", () => {
    expect(isPidDead(process.pid)).toBe(false);
  });

  it("returns true for a PID that cannot exist (very high)", () => {
    // PIDs on macOS/Linux max out below 4_194_304; this one will not exist.
    expect(isPidDead(4_194_303)).toBe(true);
  });
});

describe("defaultWorkerId", () => {
  it("matches the absurd-sdk convention `${hostname}:${pid}`", () => {
    expect(defaultWorkerId()).toBe(`${os.hostname()}:${process.pid}`);
  });
});
