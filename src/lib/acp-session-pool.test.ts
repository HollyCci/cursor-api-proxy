import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  VirginSessionPool,
  initSessionPool,
  poolAccountKey,
  shutdownSessionPool,
} from "./acp-session-pool.js";
import { normalizePoolModelKey } from "./acp-connection.js";

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
