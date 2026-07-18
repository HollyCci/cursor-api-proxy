# Account Plan-Disable（订阅失效进程内隔离）设计

**Date:** 2026-07-18  
**Status:** Approved for implementation (pending plan)  
**Review:** 架构 / 并发 / 运维 三方评审 → Approve with changes；用户确认采纳必改清单

## 问题

Cursor 账号返回 `Upgrade your plan to continue`（或等价订阅失效文案）后，该账号已不可用。  
当前 `AccountPool` 仅有约 60s 的 `rateLimitUntil`，且**全员限流时仍会回落选号**；`isRateLimited` 也不匹配该文案。结果是坏号继续进轮询、继续预热 ACP，浪费配额并拖慢全链路。

硬约束：

- 不跨请求复用已 prompt 的 session（上下文隔离不变）
- 不删本地 `configDir` / 凭据
- 不把普通 429 当成订阅失效

## 目标

1. 命中订阅失效信号后，**进程内永久禁用**该账号（重启或手动 enable 前不再调度）
2. 清空并禁止该账号的 ACP session pool refill
3. 全部账号禁用时，对上游返回**稳定 503**，不再发死号
4. 默认可观测：谁被禁、为何、还剩几个 usable

## 非目标

- 不写盘持久化禁号列表
- 不做自动探测恢复 / 订阅续费轮询
- 不改 `CURSOR_CONFIG_DIRS` 配置文件
- 首版不做 admin UI / `accounts enable` CLI（预留函数即可）
- 不解决 pool hit 率 / 1s 延迟（另案）

## 架构

```text
CLI/ACP 错误面
  → classifyAccountFailure(text)
       ├─ plan_upgrade → reportAccountDisabled + discardAccount(禁 refill)
       ├─ rate_limit   → reportRateLimit (现有 60s)
       └─ other        → 普通错误计数

AccountPool.getNextConfigDir
  → 剔除 disabled
  → 再在剩余上做 least-busy / rate-limit
  → 无可用非 disabled → undefined（handler → 503）

VirginSessionPool
  → disabledAccounts / epoch 门闩
  → ensureWarm / checkout / refillOne 全部 short-circuit
  → discardAccount: 清 pooled、作废 warming epoch、checked_out 不杀共享 conn
```

## 匹配规则

统一放在 `src/lib/account-failure.ts`（名称可微调）：

| 分类 | 规则 | 说明 |
|------|------|------|
| `plan_upgrade` | 主锚：`/upgrade your plan/i`；可选完整句 `Upgrade your plan to continue` | **禁止**单独匹配裸 `plan to continue` |
| `rate_limit` | 保持现有 `/\b429\b|rate.?limit|too many requests/i` | 与 plan 分开 |
| 判定顺序 | 先 `plan_upgrade`，再 `rate_limit` | 同响应两者都像时以 disable 为准 |

**检测面（必须覆盖）：**

- stderr
- sync stdout / 累积 assistant 文本（ACP pool 成功路径常 `stderr: ""`）
- RPC / `Error.message` / stream `.catch(err)`
- 流式：`onChunk` 累积命中

**误伤防护：**

- 不对「长成功回复正文里偶然提到套餐」永禁：优先与 **非 0 / RPC error / stderr 错误语境** 组合；或要求短回复几乎整段即该句
- 实现时用单测锁死：长成功含同句 → 不 disable；短错误/短 stdout 即该句 → disable

## AccountPool

新增字段（每账号）：

- `disabled: boolean`
- `disabledReason?: string`（如 `upgrade_plan`）
- `disabledAt?: number`

API：

- `reportAccountDisabled(configDir, reason)` — 幂等；重复命中可更新 reason/时间
- `reportAccountEnabled(configDir)` — 清 disabled；供后续手动恢复
- `getStats()` 增加 `isDisabled` / `disabledReason` / `disabledAt`
- `getUsableCount()` / 或 stats 派生

调度：

1. 过滤 `!disabled`
2. 在剩余集合上沿用 least-busy + 跳过未过期 rate-limit
3. **若无非 disabled 账号** → `undefined`（**禁止**把 disabled 混进「全 429 回退最早恢复者」）
4. 已选中的 in-flight 请求跑完即可；新调度永久跳过

## VirginSessionPool

- `disableAccount(accountKey)` / `enableAccount(accountKey)`
- per-account **epoch**：disable 时 bump；`refillOne` 完成入池前校验 epoch，失败则丢弃
- `ensureWarm` / `checkout` / `refillOne`：账号 disabled 则立即 return
- `discardAccount`：
  - `pooled`：cancel + remove
  - `warming`：靠 epoch 作废，完成后不入池
  - `checked_out`：**不**强杀共享 `AcpConnection`；持有方 `discard` 时不得 refill；`checkedOut+warming==0` 后再 kill conn
- `PoolCheckout.discard`：若账号已 disabled，**禁止** `ensureWarm`

## Handler 行为

涉及：`chat-completions.ts`、`anthropic-messages.ts`；检测逻辑尽量下沉到 `agent-runner` / ACP 边界，避免只挂 stderr。

| 场景 | 行为 |
|------|------|
| 选号前 `getNext` 为 `undefined`（全禁用） | **503** + `code: "no_usable_accounts"`（或 `all_accounts_disabled`，二选一写死）；可选 `Retry-After` 较长或不设短间隔 |
| sync 结束命中 plan_upgrade | disable + discardAccount；本请求错误响应 |
| stream `onChunk` 命中 | disable + 停止刷内容 + 错误收尾；**已 `writeHead(200)` 则用 SSE/Anthropic error 事件**，code 与同步一致 |
| 未向客户端写出模型内容 | **允许恰好 1 次**换号 failover |
| 已写出首字节 | **只 disable，不换号** |

与 rate-limit：upgrade → 永久 disable；429 → 仍 60s penalty。

## 可观测性（上线硬钩子）

1. **默认可 grep 日志**（不依赖 `CURSOR_BRIDGE_VERBOSE`），状态变化打一次：  
   `account`（basename）、`reason=upgrade_plan`、`disabledAt`、`usableCount`、`disabledCount`、`totalCount`
2. 只读容量面（实现时二选一即可）：  
   - 扩展 `/api/status` 或新增 `GET /api/accounts`：`usable` / `disabled[]` / `rateLimited`  
   - 或 `/health` 在 `usableCount===0` 时非 200
3. `sessions.log` / 请求错误路径尽量带 account basename（若改动成本低则做）

## 手动恢复

- 进程重启：全部 disabled 清零（与现有内存 rate-limit 一致）
- `reportAccountEnabled` + `sessionPool.enableAccount` 预留；首版可不挂 CLI/UI
- 运维手册一句：禁号不写盘；**重启 = 解除隔离**；误禁代价 = 坏号重新进池直到再命中

## 验收（摘自评审）

1. A 命中 upgrade → A 永禁；下一请求只到 B  
2. A disable 时 in-flight refill/discard→ensureWarm → A 无新 pooled  
3. A 有 checked_out 时 discardAccount → 不杀共享 conn；结束后不 refill  
4. ACP pool 成功、`stderr=""`、stdout 为 upgrade → 仍 disable  
5. 流式中途 chunk 命中 → 错误收尾；并发下一请求不再选 A  
6. 长成功回答偶然含同句 → 不 disable  
7. 全部禁用 → 选号前 503 + 稳定 code，不写 SSE 成功帧  
8. 双账号、A 触发且未出首字节 → 恰好 1 次 failover 到 B  

## 实现文件（预期）

| 文件 | 职责 |
|------|------|
| `src/lib/account-failure.ts`（新） | 分类匹配 |
| `src/lib/account-pool.ts` | disabled 状态与调度 |
| `src/lib/acp-session-pool.ts` | epoch / discardAccount / 禁 refill |
| `src/lib/agent-runner.ts` | 错误串可达、池路径检测钩子 |
| `src/lib/handlers/chat-completions.ts` | 503、failover、流式中止 |
| `src/lib/handlers/anthropic-messages.ts` | 同上 |
| `src/lib/admin-dashboard.ts` 或 status | usable/disabled 暴露 |
| `src/lib/account-pool.test.ts` 等 | 单测 |
| `src/lib/account-failure.test.ts`（新） | 匹配与误伤夹具 |

## 评审决议摘要

- 匹配：去掉裸 `plan to continue`；仅错误语境 / 短失败文本  
- 检测：必须覆盖 ACP/RPC/stdout，不能只扫 handler stderr  
- 池：禁 refill + epoch，否则隔离无效  
- 调度：disabled 绝对优先于 rate-limit 回退  
- 上游：0 usable → 503，非通用 500  
- 首版只靠重启恢复：Accept（有日志 + 容量面）  
- failover 1 次（未出首字节）：首版做  
