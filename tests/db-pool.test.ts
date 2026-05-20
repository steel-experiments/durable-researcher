// ABOUTME: Tests for the shared Postgres pool singleton.
// ABOUTME: Verifies single-instance behavior and reset-on-close. No DB connections are opened.

import { describe, it, expect, afterEach } from "vitest";
import { getDbPool, closeDbPool } from "../src/db-pool.js";

describe("getDbPool", () => {
  afterEach(async () => {
    await closeDbPool();
  });

  it("returns the same Pool instance across calls", () => {
    const a = getDbPool();
    const b = getDbPool();
    expect(a).toBe(b);
  });

  it("creates a fresh Pool after closeDbPool", async () => {
    const a = getDbPool();
    await closeDbPool();
    const b = getDbPool();
    expect(a).not.toBe(b);
  });

  it("survives multiple closeDbPool calls without throwing", async () => {
    getDbPool();
    await closeDbPool();
    await closeDbPool();
  });

  it("does not throw when closing without ever creating a pool", async () => {
    let threw = false;
    try {
      await closeDbPool();
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });
});
