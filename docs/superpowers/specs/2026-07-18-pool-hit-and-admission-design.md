# Pool Hit + Admission Control 设计

**Date:** 2026-07-18  
**Status:** Approved for planning (gpt-5.6-sol xhigh + 用户确认)  
**Context:** 竞品调研后的下一迭代；不切换主线到 `@cursor/sdk`

## 问题

新加坡生产短补全在 sync 偶发 `pool_hit=true`（~2.3s），但整体仍常见 `pool_hit=false`。根因不是缺 Docker / `/responses`，而是：

1. **`stream:true` 完全不走 virgin session pool**
2. **账号调度不感知池库存**（7 账号 + MIN_IDLE=1 放大 miss）
3. **miss 后无界冷启**，缺少背压
4. **模型契约松**：共享 `lastRequestedModelRef`、预热只按 `defaultModel`
5. **`ensureWarm` + `refillInFlight` 去重使 MIN_IDLE>1 一次补不满**

硬约束不变：禁止跨请求复用已 prompt 的 session（virgin one-shot）。

## 目标

- 提高 **eligible** 请求的 `pool_hit`（分母不含 tool-bridge / agent-mode / 非 ask）
- sync 与 stream 共用同一种一次性 checkout
- 超载时稳定 429/503，而不是冷启动风暴
- 可观测：miss reason、库存、冷启、排队

## 非目标

- 主线替换为 `@cursor/sdk`（最多后续 1 天 spike）
- 逆向私有协议 / 托管 key 转售
- 盲目提高 MIN_IDLE 而不修 refill
- 以牺牲成功率为代价刷 hit 指标

## 优先级（Sol 重排）

1. 真实 pool 指标  
2. stream 接入 virgin pool  
3. 池感知调度 + 有界背压  
4. `cursor-fast` lane（模型严格对齐）  
5. Gateway home 隔离 + doctor（安全/确定性；TTFT 次要）

后置：`/v1/responses`、Docker/GHCR、跨平台 install UX。

## 验收总纲

| 指标 | 目标 |
|------|------|
| eligible sync+stream `pool_hit`（暖就绪后串行） | ≥ 95% |
| short pool-hit TTFT p50 / p95 | ≤ 2.5s / ≤ 5s |
| 2× 突发 | 无无界冷启；超载 → 429/503 + Retry-After |
| 观测开销 | p95 < 5ms |
| Gateway home | 注入用户 MCP/rules 后冷热路径均不可见 |

## 参考

- Sol 意见会话（2026-07-18）
- 竞品：leeguooooo（home/presets/日志）、tageecc（运维 UX）、standardagents（SDK，仅 spike）
