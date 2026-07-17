# Sub-Second Cursor Bridge — 延迟优化总计划（修订）

> **For agentic workers:** Execute phase-by-phase; each phase has a hard gate. Do not start Phase N+1 until Phase N metrics pass. Prefer measurement over intuition.

**Goal:** 将「cursor-api-proxy → Cursor」短补全热路径从今日 ~11s 降到可上线的 **档 A（p50 ≤ 3s）**；仅在实证支持时冲刺 **档 S（p50 ≤ 1s）**。

**Architecture:** 抛弃「每请求 spawn 一次 CLI」。改为 **常驻 ACP 进程 + 预热 virgin session 池**：checkout 后只 `prompt` 一次即 **丢弃 session**（禁止跨请求 sticky）。NewAPI / LibreChat 不改语义。Phase 3 协议直连仅为实验轨/最后手段。

## Fable 评审与实测门禁（2026-07-17）

**终裁：Go Step B（virgin 一次性池），附条件。**  
**代码评审（Request changes）阻塞项已修：** 每账号 env、严格模型匹配、空输出冷降级、每 session 独立 cwd、stdin error 监听。用户决定不做灰度。

| 项 | 决定 |
|---|---|
| sticky | **否决** |
| virgin 首 prompt p50 | ~3100ms（n=29）；档A **p50≤3500ms**（端到端 TTFT 地板≈上游） |
| >8s 尾部 | **观测项**（归因=上游 thought 静默，非池内）；不阻塞发布 |
| 配对冲重试 | **以后**（未证明慢是随机抖动前不做） |
| 池验收口径 | **池可控段**（请求进入→prompt 下发完成），不用端到端 p95 判池成败 |
| 池空 | 冷启动回退，不排队死等补池 |

脚本：`scripts/spike-virgin-ttft.mjs`、`scripts/spike-acp-reuse.mjs`。

**Tech Stack:** `cursor-api-proxy` fork、Cursor CLI ACP、Node.js、systemd、结构化延迟日志 / histogram。

## 评审结论（已吸收）

| 判断 | 结论 |
|---|---|
| 11s → 3～5s | **高可能**（若进程可复用） |
| 稳定 p50 ≤ 1s | **中低 / stretch**（取决于云端边际延迟） |
| 全场景 1s（含 tools） | **非目标** |
| 仅打开 `USE_ACP` | **不够**；冷 ACP 曾比 CLI 更慢（~12s vs ~9s），必须 **复用进程** |

---

## Global Constraints

### 成功档位（对外承诺用 A，不对 S 过度承诺）

| 档位 | 本机 proxy p50 / p95 | 含义 | 是否发布门禁 |
|---|---|---|---|
| **A（主成功）** | ≤ **3.0s** / ≤ **5.0s** | 温池可上线 | **是** |
| **S（冲刺）** | ≤ **1.0s** / ≤ **1.5s** | 仅当 Spike 证明云端边际够快 | 否（可选） |
| B（今日） | ~11s / — | spawn 模式 | — |

### 测量口径

- **主口径**：`POST /v1/chat/completions`，`stream:false`，`max_tokens=8`，prompt=`只回ok`，无 `tools`，`http://127.0.0.1:8765`
- **辅口径（国内 NewAPI）**：同上；预算 = 主口径 p50 **+ 500～800ms**（不写死 +300ms）
- **成功率**：连续 100 次 ≥ 99%
- **流式（档 A）**：TTFB p50 ≤ 2.0s；短回复完整 p50 ≤ 3.5s
- **流式（档 S，可选）**：TTFB p50 ≤ 800ms

### 请求类型 → SLO（禁止混谈）

| 请求类型 | pool | SLO |
|---|---|---|
| 短补全、无 tools | 命中热进程 | 档 A / 可选 S |
| 短补全、无 tools | 冷启动/补池 | 不计入热路径 SLO；单独报警 |
| 含 `tools` / MCP | 可用池 | **不纳入** 3s/1s；目标首包 tool_calls p50 ≤ 5s（档 A） |
| 大 prompt / 多轮 Agent | 不建议走 Cursor | 产品分流，无 Cursor 热路径 SLO |

### 硬约束

- **不做**：缓存假回复、截断冒充加速
- **不破坏**：账号池、tool_calls 桥接、LibreChat MCP
- **会话隔离（硬）**：**进程热 + 预热 virgin session，一次性 prompt 后丢弃**；禁止 sticky 复用历史。池未命中：限额内联 `session/new`（可破 SLO）→ 再 503；冷 spawn 仅运维回滚
- **止损**：Gate 2a 失败或热进程边际 p50 > 2s → 不冲 S；不在参数上空转 > 2 天
- **Phase 3**：实验轨，默认不排期，除非 Gate 2a 过且热边际证明瓶颈在云端协议

---

## 0. 问题物理学

```text
今日（每次请求）:
  spawn agent + 握手  ≈ 固定 8–12s
  模型 1 token         ≈ 往往 <1–2s（未单独证实）
  → total ~11–13s
```

| 成本 | 今日（估） | 档 A 必须 | 档 S 必须 |
|---|---|---|---|
| 进程冷启动 | 高 | **消除** | 同左 |
| session/new+auth | 中 | 摊销或压到百 ms 级 | 同左且云端快 |
| 跨境 + NewAPI | 低～中 | 辅口径单独算 | 同左 |
| 真实推理 | 未知下限 | 接受 ≤2s | 必须实证 ≤700ms 边际 |

**原则：** 池子付固定税，请求付边际成本；**先证明边际，再谈 1s。**

---

## 1. 目标架构

```text
NewAPI / 客户端
      │
      ▼
cursor-api-proxy（控制面：路由、熔断、tool_calls、指标）
      │ checkout 热进程
      ▼
ACP Process Pool（数据面）
  accN: [P0 idle][P1 busy] …
  每请求: session/new → set model → prompt → 结束（进程回池，不杀）
      │
      ▼
Cursor 云端
```

**容量（小内存机必算）：**

```text
mem_budget ≈ accounts × maxProcessesPerAccount × rss_per_agent
默认建议: maxProcessesPerAccount=1～2（先保守）
cgroup 限额；超限减池，绝不静默 OOM
```

---

## 2. 分阶段路线图

### Phase 0 — 度量基线（0.5～1 天）**【必须】**

瀑布 span：`gateway_queue` / `account_select` / `spawn` / `session_ready` / `model_first_byte` / `model_complete` / `shape_response` / `total`。

脚本：`scripts/bench-latency.mjs`（n=100，p50/p95/p99 + 瀑布均值）。

**Gate 0：** `spawn+session_ready` ≥ 60% of total。否则重新归因。

---

### Phase 0.5 — ACP 复用 Spike（半天）**【Phase 2 准入】**

脚本：`scripts/spike-acp-reuse.mjs`（`--mode=new|sticky`）。

| 结果 | 决策 |
|---|---|
| sticky 温路径 p50 ≤ **2s** | 允许开工 Phase 2（冲档 A）——池内须 **预热 session** |
| sticky 温路径 p50 ≤ **700ms** | 允许在 Phase 2 后冲档 S |
| 仅 process 复用、每请求 `session/new` p50 > **2s** | **禁止**只做进程池；必须改为「空闲预热 session」或可接受的 sticky |
| 无法同进程多 prompt | Phase 2 方案作废，重新设计 |

#### 实测（2026-07-17，本机已登录 agent）

| 模式 | warm(2..10) p50 | 备注 |
|---|---|---|
| `--mode=new`（每请求 session/new） | **~4.1s**（另测 ~2.7s） | `session/new` 占 2～4s |
| `--mode=sticky`（同 session 多 prompt） | **~0.37s** | prompt 边际可达档 S |
| 冷 ACP 经 proxy（每请求 spawn） | p50 **~10.8s** | Gate 0：`(spawn+session_ready)/total ≈ 59%` |

**结论修订：** Phase 2 = **常驻进程 + 预热 virgin session（一次性）**。sticky 仅作 Spike 证据，**禁止产品路径**。上线前先测 virgin 首 prompt p50。

---

### Phase 1 — 减负（1～2 天）

| 动作 | 预期 |
|---|---|
| 无 tools 去掉多余 preamble / 无谓 preflight | 小幅 |
| 探测与业务隔离 | 降抖动 |
| NewAPI：多轮 Agent 默认国内组 | 产品层 |

**Gate 1：** p50 ≤ 8s，瀑布仍以 spawn 为主。

---

### Phase 2 — ACP 进程池（3～7 天）**【主战役 = 档 A】**

#### 池模型

```text
SessionSlot = { process, account, sessionId, state: created|pooled|checked_out|dead }
# 按 (process, account) 分键；checked_out 后只能进 dead，禁止回 pooled
AccountPool = {
  minIdleSessions: 1,
  maxSessions: 1..2,
  maxCheckoutMs: 2000,
  idleTtlMs: < vendor idle timeout,
  onMiss: inline_session_new_then_503,
}
```

#### 必备行为

1. checkout 原子；`requestId↔sessionId↔account` 一对一审计  
2. 预热：`session/new`（空历史）+ 可选 set model；**从未 prompt 才可 checkout**  
3. 热路径：一次 `session/prompt` → 显式 cancel/丢弃 → 异步补 virgin  
4. 事件 demux：仅投递当前 checked_out 的 sessionId，否则丢弃+告警  
5. 池未命中：限额内联 `session/new`；再 503 + `Retry-After`  
6. `CURSOR_BRIDGE_SESSION_POOL=true`；冷 spawn 仅运维回滚  
7. 隔离门禁用例（金丝雀泄漏 / 交错流 / abort 僵尸 / 双签出）红则禁止上线  
8. 指标：`pool_hit` / `inline_new` / `spawn_total` / RSS；命中与未命中延迟分报

#### 验收

| 指标 | **Gate 2a（发布）** | **Gate 2b（冲刺 S，可选）** |
|---|---|---|
| 前提 | Spike 第2～10次 p50≤2s | Spike 边际 p50≤700ms |
| p50 / p95（本机） | ≤ **3s** / ≤ **5s** | ≤ **1s** / ≤ **1.5s** |
| 冷启动占比 | ≤ 10% | ≤ 1% |
| tool_calls E2E | 绿 | 绿 |
| 内存 | 低于 cgroup，无 OOM | 同左 |

**Gate 2a 过、2b 不过或不具备前提：** **接受档 A 为成功**，进入 Phase 4；**默认不进 Phase 3**。  
**仅当** 热路径瀑布证明 >70% 时间在云端协议且业务强需求 1s 时，才评估 Phase 3。

---

### Phase 3 — 协议直连（实验轨，默认不排期）

- 社区式直连视为 **高风控 / 高维护**  
- 须独立评审：封号、ToS、版本钉扎、一键回退池模式  
- **不得**与温池并列写成「自然下一阶段」

**Gate 3（若做）：** 档 S 达标 + 7 天无风控事件 + 可切回 Phase 2。

---

### Phase 4 — 产品与边缘（并行）

| 项 | 作用 |
|---|---|
| 多轮/画像禁止默认 Cursor | 保额度与体验 |
| 国内 NewAPI 辅口径标定 | +500～800ms 预算 |
| 流式体感 / 可选 reasoning 映射 | 体验，不替代档 A |
| 容量看板 | 防伪优化 |

---

## 3. 决策树

```text
Phase 0 瀑布
  └─ spawn 为主？
        ├─ 否 → 重新归因
        └─ 是 → Phase 0.5 Spike
              ├─ 边际 p50 >2s → 停止温池方案；分流 / 再设计
              ├─ 边际 ≤2s → Phase 1 + Phase 2 → Gate 2a（3s）
              │                 ├─ 失败 → 止损
              │                 └─ 成功 = 产品成功（档 A）
              │                       └─ 边际曾 ≤700ms？
              │                             ├─ 是 → 可选冲 Gate 2b（1s）
              │                             └─ 否 → 不冲 S；Phase 4
              └─ （极少）Gate 2a 过且强需求 1s 且瓶颈在协议 → 评估 Phase 3
```

---

## 4. 观测

- `cursor_bridge_request_duration_ms{phase,model,account,pool_hit}`  
- `cursor_bridge_pool_idle|busy|dead`、`spawn_total`、RSS  
- 每日 `bench-latency.mjs --n=50`；**档 A 红则禁止滚 `app/current`**

---

## 5. 风险（修订）

| 风险 | 应对 |
|---|---|
| 误以为开 ACP 即加速 | Spike 门禁；文档标明冷 ACP 更慢先例 |
| 会话串上下文 / 事件错配 | virgin 一次性 + sessionId 白名单 demux；sticky **已否决** |
| virgin 首 prompt 慢于 sticky | 上线前单独实测；不达 3s 则加深池或降 SLO |
| 1s 对外口号化 | 对外只承诺档 A；S 为内部冲刺 |
| 小机 OOM | maxProcesses 保守 + cgroup |
| Phase 3 诱惑 | 默认不排期 |
| 沉没成本 | 2 天微调上限 |

---

## 6. 节奏

| 阶段 | 工期 |
|---|---|
| Phase 0 + 0.5 | ~1 天（可同日） |
| Phase 1 | 1～2 天 |
| Phase 2 → Gate 2a | 3～7 天 |
| Gate 2b | 仅可选，0～3 天微调 |
| Phase 3 | 默认 0 |
| Phase 4 | 并行 |

**本周最小集：** Phase 0 瀑布 + Phase 0.5 Spike → 再决定是否写池子。

---

## 7. 总纲

> **先证明热进程边际，再承诺延迟。档 A（3s）是发布成功；档 S（1s）是有条件冲刺，不是默认 KPI。**

---

## 8. 下一步

1. ~~Phase 0 + 0.5~~ 完成；~~Fable 评审~~ **Go with changes** 已吸收  
2. **Phase 2 开工前：** 补测「预热 virgin → 首 prompt」p50（非 sticky）  
3. 按 Fable 阻塞项实现一次性 session 池；隔离门禁绿后再开开关  
4. 新加坡账号池环境复测  

回复「继续 Phase 2」即开工（先做 virgin 首 prompt 实测）。
