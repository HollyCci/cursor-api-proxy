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
