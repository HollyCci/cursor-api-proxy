import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VirginSessionPool,
  disableSessionPoolAccount,
  initSessionPool,
  poolAccountKey,
  shutdownSessionPool,
} from "./acp-session-pool.js";
import {
  normalizePoolModelKey,
  type AcpConnection,
} from "./acp-connection.js";

const node = process.execPath;
const cwd = process.cwd();
const fakeServerPath = join(cwd, "src", "lib", "__tests__", "fake-acp-server.mjs");

afterEach(() => {
  shutdownSessionPool();
  vi.useRealTimers();
});

function makePool(extra?: Partial<ConstructorParameters<typeof VirginSessionPool>[0]>) {
  return new VirginSessionPool({
    enabled: true,
    minIdle: 1,
    maxSessions: 2,
    idleTtlMs: 60_000,
    command: node,
    args: [fakeServerPath],
    skipAuthenticate: true,
    resolveAccountEnv: (key) => ({ CURSOR_CONFIG_DIR: `/tmp/fake-account/${key}` }),
    ...extra,
  });
}

describe("VirginSessionPool requestTimeoutMs", () => {
  it("forwards requestTimeoutMs into AcpConnection.start options", async () => {
    const seen: Array<{ requestTimeoutMs?: number }> = [];
    const fakeConn = {
      id: "fake",
      isDead: false,
      kill: vi.fn(),
      cancel: vi.fn(async () => undefined),
      createVirginSession: async () => ({
        sessionId: "s1",
        createdAt: Date.now(),
        effectiveModel: "composer-2.5",
      }),
      promptOnce: async () => ({ stdout: "ok", latencyMarks: {} }),
    } as unknown as AcpConnection;
    const pool = makePool({
      requestTimeoutMs: 300_000,
      startConnection: async (opts) => {
        seen.push({ requestTimeoutMs: opts.requestTimeoutMs });
        return fakeConn;
      },
    });
    await pool.ensureWarm("acc-timeout", "composer-2.5");
    await waitPooled(pool, "acc-timeout");
    expect(seen[0]?.requestTimeoutMs).toBe(300_000);
    pool.shutdown();
  });
});

async function waitPooled(pool: VirginSessionPool, account: string, n = 1) {
  for (let i = 0; i < 80; i++) {
    if ((pool.stats()[account]?.pooled ?? 0) >= n) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for pooled=${n} account=${account}`);
}

async function waitWarming(pool: VirginSessionPool, account: string, n = 1) {
  for (let i = 0; i < 80; i++) {
    if ((pool.stats()[account]?.warming ?? 0) >= n) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for warming=${n} account=${account}`);
}

function makeDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("VirginSessionPool", () => {
  it("checkouts a warmed virgin session once then cannot reuse same sessionId", async () => {
    const pool = makePool();
    await pool.ensureWarm("acc1");
    await waitPooled(pool, "acc1");
    expect(pool.stats().acc1?.pooled).toBeGreaterThanOrEqual(1);

    const a = pool.checkout("acc1");
    expect(a).not.toBeNull();
    const out = await a!.promptOnce("hi");
    expect(out.stdout).toContain("Hello from fake ACP");
    await a!.discard();

    const b = pool.checkout("acc1");
    if (b) {
      expect(b.sessionId).not.toBe(a!.sessionId);
      await b.discard();
    }
    pool.shutdown();
  });

  it("strict model match: wrong model misses", async () => {
    const pool = makePool({ defaultModel: "gpt-4" });
    await pool.ensureWarm("/abs/acc-model", "gpt-4");
    await waitPooled(pool, "/abs/acc-model");
    expect(pool.checkout("/abs/acc-model", "other-model")).toBeNull();
    const hit = pool.checkout("/abs/acc-model", "gpt-4");
    expect(hit).not.toBeNull();
    await hit!.discard();
    pool.shutdown();
  });

  it("poolAccountKey uses resolved absolute path", () => {
    expect(poolAccountKey("/tmp/a/../b")).toBe(join("/tmp", "b"));
    expect(poolAccountKey(undefined)).toBe("default");
  });

  it("normalizePoolModelKey", () => {
    expect(normalizePoolModelKey(undefined, undefined)).toBe("__default__");
    expect(normalizePoolModelKey("default", "x")).toBe("__default__");
    expect(normalizePoolModelKey("auto", undefined)).toBe("auto");
  });

  it("initSessionPool respects enabled flag", () => {
    expect(
      initSessionPool({
        enabled: false,
        minIdle: 1,
        maxSessions: 1,
        idleTtlMs: 60_000,
        command: node,
        args: [fakeServerPath],
      }),
    ).toBeNull();
  });

  it("skips dead connections on checkout", async () => {
    const pool = makePool();
    await pool.ensureWarm("acc-dead");
    await waitPooled(pool, "acc-dead");
    const before = pool.checkout("acc-dead");
    expect(before).not.toBeNull();
    before!.conn.kill();
    await before!.discard();
    const after = pool.checkout("acc-dead");
    if (after) {
      expect(after.conn.isDead).toBe(false);
      await after.discard();
    }
    pool.shutdown();
  });

  it("promptOnce failure after kill rejects then discard works", async () => {
    const pool = makePool();
    await pool.ensureWarm("acc-fail");
    await waitPooled(pool, "acc-fail");
    const co = pool.checkout("acc-fail");
    expect(co).not.toBeNull();
    co!.conn.kill();
    await expect(co!.promptOnce("x")).rejects.toThrow();
    await co!.discard();
    pool.shutdown();
  });
});

describe("VirginSessionPool checkoutDetailed miss reasons", () => {
  it("reports not_enabled when pool disabled", () => {
    const pool = makePool({ enabled: false });
    expect(pool.checkoutDetailed("acc1", "composer-2.5")).toEqual({
      ok: false,
      reason: "not_enabled",
    });
    expect(pool.checkout("acc1")).toBeNull();
    pool.shutdown();
  });

  it("reports disabled when account is disabled", () => {
    const pool = makePool();
    pool.disableAccount("/acc1");
    expect(pool.checkoutDetailed("/acc1", "composer-2.5")).toEqual({
      ok: false,
      reason: "disabled",
    });
    pool.shutdown();
  });

  it("reports empty when no idle and no warming for model", () => {
    const pool = makePool();
    expect(pool.checkoutDetailed("acc-empty", "composer-2.5")).toEqual({
      ok: false,
      reason: "empty",
    });
    pool.shutdown();
  });

  it("reports warming when only warming slots exist for model", async () => {
    const createGate = makeDeferred();
    const fakeConn = {
      id: "fake-warm",
      isDead: false,
      kill: vi.fn(),
      cancel: vi.fn(async () => undefined),
      createVirginSession: async () => {
        await createGate.promise;
        return {
          sessionId: "sess-warm",
          createdAt: Date.now(),
          sessionCwd: undefined,
          effectiveModel: "composer-2.5",
        };
      },
      promptOnce: async () => ({ stdout: "", latencyMarks: {} }),
    } as unknown as AcpConnection;

    const pool = makePool({
      defaultModel: "composer-2.5",
      startConnection: async () => fakeConn,
    });
    void pool.ensureWarm("acc-warming", "composer-2.5");
    await waitWarming(pool, "acc-warming");

    expect(pool.checkoutDetailed("acc-warming", "composer-2.5")).toEqual({
      ok: false,
      reason: "warming",
    });
    expect(pool.checkout("acc-warming", "composer-2.5")).toBeNull();

    createGate.resolve();
    pool.shutdown();
  });

  it("reports model_mismatch when idle exists for a different model", async () => {
    const pool = makePool({ defaultModel: "gpt-4" });
    await pool.ensureWarm("/abs/acc-mm", "gpt-4");
    await waitPooled(pool, "/abs/acc-mm");
    expect(pool.checkoutDetailed("/abs/acc-mm", "other-model")).toEqual({
      ok: false,
      reason: "model_mismatch",
    });
    pool.shutdown();
  });

  it("reports dead when matching idle session has a dead connection", async () => {
    let connRef: { isDead: boolean } | null = null;
    const pool = makePool({
      startConnection: async () => {
        connRef = {
          id: "flip-dead",
          isDead: false,
          kill: vi.fn(),
          cancel: vi.fn(async () => undefined),
          createVirginSession: async () => ({
            sessionId: "sess-flip",
            createdAt: Date.now(),
            sessionCwd: undefined,
            effectiveModel: "__default__",
          }),
          promptOnce: async () => ({ stdout: "", latencyMarks: {} }),
        } as unknown as { isDead: boolean };
        return connRef as unknown as AcpConnection;
      },
    });
    await pool.ensureWarm("acc-flip");
    await waitPooled(pool, "acc-flip");
    expect(connRef).not.toBeNull();
    connRef!.isDead = true;
    expect(pool.checkoutDetailed("acc-flip")).toEqual({
      ok: false,
      reason: "dead",
    });
    pool.shutdown();
  });


  it("reports capacity when at maxSessions with no matching idle", async () => {
    const createGate = makeDeferred();
    const fakeConn = {
      id: "cap-conn",
      isDead: false,
      kill: vi.fn(),
      cancel: vi.fn(async () => undefined),
      createVirginSession: async () => {
        await createGate.promise;
        return {
          sessionId: `sess-cap-${Date.now()}`,
          createdAt: Date.now(),
          sessionCwd: undefined,
          effectiveModel: "composer-2.5",
        };
      },
      promptOnce: async () => ({ stdout: "ok", latencyMarks: {} }),
    } as unknown as AcpConnection;

    const pool = makePool({
      minIdle: 1,
      maxSessions: 1,
      defaultModel: "composer-2.5",
      startConnection: async () => fakeConn,
    });
    // Hold one checked_out slot at capacity: warm fully, checkout, then miss.
    createGate.resolve();
    await pool.ensureWarm("acc-cap", "composer-2.5");
    await waitPooled(pool, "acc-cap");
    const held = pool.checkout("acc-cap", "composer-2.5");
    expect(held).not.toBeNull();
    expect(pool.checkoutDetailed("acc-cap", "composer-2.5")).toEqual({
      ok: false,
      reason: "capacity",
    });
    await held!.discard();
    pool.shutdown();
  });

  it("checkoutDetailed returns ok with value on hit", async () => {
    const pool = makePool();
    await pool.ensureWarm("acc-hit");
    await waitPooled(pool, "acc-hit");
    const result = pool.checkoutDetailed("acc-hit");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sessionId).toBeTruthy();
      await result.value.discard();
    }
    pool.shutdown();
  });

  it("ensureWarm fills up to minIdle for a model", async () => {
    let sessionSeq = 0;
    const fakeConn = {
      id: "minidle-conn",
      isDead: false,
      kill: vi.fn(),
      cancel: vi.fn(async () => undefined),
      createVirginSession: async () => {
        sessionSeq += 1;
        return {
          sessionId: `sess-minidle-${sessionSeq}`,
          createdAt: Date.now(),
          sessionCwd: undefined,
          effectiveModel: "composer-2.5",
        };
      },
      promptOnce: async () => ({ stdout: "", latencyMarks: {} }),
    } as unknown as AcpConnection;

    const pool = makePool({
      minIdle: 2,
      maxSessions: 4,
      defaultModel: "composer-2.5",
      startConnection: async () => fakeConn,
    });
    await pool.ensureWarm("acc1", "composer-2.5");
    expect(sessionSeq).toBe(2);
    expect(pool.stats()["acc1"]?.pooled).toBe(2);
    expect(pool.stats()["acc1"]?.warming ?? 0).toBe(0);
    pool.shutdown();
  });

  it("ensureWarm retries a transient create failure then converges", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const fakeConn = {
        id: "retry-conn",
        isDead: false,
        kill: vi.fn(),
        cancel: vi.fn(async () => undefined),
        createVirginSession: async () => {
          calls += 1;
          if (calls === 1) throw new Error("transient warm failure");
          return {
            sessionId: `sess-retry-${calls}`,
            createdAt: Date.now(),
            sessionCwd: undefined,
            effectiveModel: "composer-2.5",
          };
        },
        promptOnce: async () => ({ stdout: "", latencyMarks: {} }),
      } as unknown as AcpConnection;

      const pool = makePool({
        minIdle: 1,
        maxSessions: 2,
        defaultModel: "composer-2.5",
        startConnection: async () => fakeConn,
      });
      const done = pool.ensureWarm("acc-retry", "composer-2.5");
      await vi.advanceTimersByTimeAsync(100);
      await done;
      expect(calls).toBe(2);
      expect(pool.stats()["acc-retry"]?.pooled).toBe(1);
      expect(pool.stats()["acc-retry"]?.warming ?? 0).toBe(0);
      pool.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ensureWarm stops after 3 permanent failures without rejecting", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const fakeConn = {
        id: "fail-conn",
        isDead: false,
        kill: vi.fn(),
        cancel: vi.fn(async () => undefined),
        createVirginSession: async () => {
          calls += 1;
          throw new Error("permanent warm failure");
        },
        promptOnce: async () => ({ stdout: "", latencyMarks: {} }),
      } as unknown as AcpConnection;

      const pool = makePool({
        minIdle: 1,
        maxSessions: 2,
        defaultModel: "composer-2.5",
        startConnection: async () => fakeConn,
      });
      const done = pool.ensureWarm("acc-perm", "composer-2.5");
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(300);
      await expect(done).resolves.toBeUndefined();
      expect(calls).toBe(3);
      expect(pool.stats()["acc-perm"]?.pooled ?? 0).toBe(0);
      expect(pool.stats()["acc-perm"]?.warming ?? 0).toBe(0);
      pool.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("concurrent ensureWarm shares one converge and does not over-create", async () => {
    let calls = 0;
    const fakeConn = {
      id: "coalesce-conn",
      isDead: false,
      kill: vi.fn(),
      cancel: vi.fn(async () => undefined),
      createVirginSession: async () => {
        calls += 1;
        return {
          sessionId: `sess-coalesce-${calls}`,
          createdAt: Date.now(),
          sessionCwd: undefined,
          effectiveModel: "composer-2.5",
        };
      },
      promptOnce: async () => ({ stdout: "", latencyMarks: {} }),
    } as unknown as AcpConnection;

    const pool = makePool({
      minIdle: 2,
      maxSessions: 4,
      defaultModel: "composer-2.5",
      startConnection: async () => fakeConn,
    });
    await Promise.all([
      pool.ensureWarm("acc-coalesce", "composer-2.5"),
      pool.ensureWarm("acc-coalesce", "composer-2.5"),
    ]);
    expect(calls).toBe(2);
    expect(pool.stats()["acc-coalesce"]?.pooled).toBe(2);
    pool.shutdown();
  });

  it("ensureWarm respects maxSessions when minIdle is higher", async () => {
    let calls = 0;
    const fakeConn = {
      id: "cap-conn",
      isDead: false,
      kill: vi.fn(),
      cancel: vi.fn(async () => undefined),
      createVirginSession: async () => {
        calls += 1;
        return {
          sessionId: `sess-cap-${calls}`,
          createdAt: Date.now(),
          sessionCwd: undefined,
          effectiveModel: "composer-2.5",
        };
      },
      promptOnce: async () => ({ stdout: "", latencyMarks: {} }),
    } as unknown as AcpConnection;

    const pool = makePool({
      minIdle: 5,
      maxSessions: 2,
      defaultModel: "composer-2.5",
      startConnection: async () => fakeConn,
    });
    await pool.ensureWarm("acc-cap", "composer-2.5");
    expect(calls).toBe(2);
    expect(pool.stats()["acc-cap"]?.pooled).toBe(2);
    pool.shutdown();
  });

  it("ensureWarm does not create after shutdown during backoff", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const fakeConn = {
        id: "shutdown-conn",
        isDead: false,
        kill: vi.fn(),
        cancel: vi.fn(async () => undefined),
        createVirginSession: async () => {
          calls += 1;
          throw new Error("fail before shutdown");
        },
        promptOnce: async () => ({ stdout: "", latencyMarks: {} }),
      } as unknown as AcpConnection;

      const pool = makePool({
        minIdle: 1,
        maxSessions: 2,
        defaultModel: "composer-2.5",
        startConnection: async () => fakeConn,
      });
      const done = pool.ensureWarm("acc-shutdown", "composer-2.5");
      for (let i = 0; i < 20 && calls < 1; i++) {
        await Promise.resolve();
      }
      expect(calls).toBe(1);
      pool.shutdown();
      await vi.advanceTimersByTimeAsync(500);
      await expect(done).resolves.toBeUndefined();
      expect(calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("VirginSessionPool disable / epoch gates", () => {
  it("checkout returns null after disableAccount", () => {
    const pool = makePool();
    pool.disableAccount("/acc1");
    expect(pool.isAccountDisabled("/acc1")).toBe(true);
    expect(pool.checkout("/acc1", "composer-2.5")).toBeNull();
    pool.shutdown();
  });


  it("ensureWarm is a no-op when account is disabled", async () => {
    const pool = makePool();
    pool.disableAccount("acc-disabled");
    await pool.ensureWarm("acc-disabled");
    await new Promise((r) => setTimeout(r, 50));
    expect(pool.stats()["acc-disabled"]).toBeUndefined();
    pool.shutdown();
  });

  it("refillOne with stale epoch does not leave state===pooled", async () => {
    const createGate = makeDeferred();
    const kill = vi.fn();
    const cancel = vi.fn(async () => undefined);
    const fakeConn = {
      id: "fake-conn",
      isDead: false,
      kill,
      cancel,
      createVirginSession: async () => {
        await createGate.promise;
        return {
          sessionId: "sess-stale-epoch",
          createdAt: Date.now(),
          sessionCwd: undefined,
          effectiveModel: "__default__",
        };
      },
      promptOnce: async () => ({ stdout: "", latencyMarks: {} }),
    } as unknown as AcpConnection;

    const pool = makePool({
      startConnection: async () => fakeConn,
    });

    void pool.ensureWarm("acc-epoch");
    await waitWarming(pool, "acc-epoch");
    pool.disableAccount("acc-epoch");
    createGate.resolve();

    for (let i = 0; i < 40; i++) {
      if ((pool.stats()["acc-epoch"]?.warming ?? 0) === 0) break;
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(pool.stats()["acc-epoch"]?.pooled ?? 0).toBe(0);
    expect(pool.stats()["acc-epoch"]?.warming ?? 0).toBe(0);
    expect(pool.checkout("acc-epoch")).toBeNull();
    expect(cancel).toHaveBeenCalledWith("sess-stale-epoch");
    expect(kill).toHaveBeenCalled();
    pool.shutdown();
  });

  it("PoolCheckout.discard does not ensureWarm when account disabled", async () => {
    const pool = makePool();
    await pool.ensureWarm("acc-discard");
    await waitPooled(pool, "acc-discard");
    const co = pool.checkout("acc-discard");
    expect(co).not.toBeNull();

    pool.disableAccount("acc-discard");
    expect(pool.stats()["acc-discard"]?.checkedOut).toBe(1);
    expect(pool.stats()["acc-discard"]?.pooled ?? 0).toBe(0);

    await co!.discard();
    await new Promise((r) => setTimeout(r, 80));

    expect(pool.stats()["acc-discard"]?.pooled ?? 0).toBe(0);
    expect(pool.stats()["acc-discard"]?.warming ?? 0).toBe(0);
    expect(pool.checkout("acc-discard")).toBeNull();
    pool.shutdown();
  });

  it("enableAccount clears disabled mark", () => {
    const pool = makePool();
    pool.disableAccount("acc-reenable");
    expect(pool.isAccountDisabled("acc-reenable")).toBe(true);
    pool.enableAccount("acc-reenable");
    expect(pool.isAccountDisabled("acc-reenable")).toBe(false);
    pool.shutdown();
  });

  it("disableSessionPoolAccount wraps getSessionPool().disableAccount", () => {
    const pool = initSessionPool({
      enabled: true,
      minIdle: 1,
      maxSessions: 2,
      idleTtlMs: 60_000,
      command: node,
      args: [fakeServerPath],
      skipAuthenticate: true,
    });
    expect(pool).not.toBeNull();
    disableSessionPoolAccount("acc-global");
    expect(pool!.isAccountDisabled("acc-global")).toBe(true);
  });
});
