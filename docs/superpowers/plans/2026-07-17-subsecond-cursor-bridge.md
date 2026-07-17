# Sub-Second Cursor Bridge — 压到 1s 总计划

> **For agentic workers:** Execute phase-by-phase; each phase has a hard gate. Do not start Phase N+1 until Phase N metrics pass. Prefer measurement over intuition.

**Goal:** 将「经 NewAPI → cursor-api-proxy → Cursor」的短补全（`max_tokens≤16`、无 tools）稳定压到 **p50 ≤ 1.0s、p95 ≤ 1.5s**（同机打新加坡 proxy 口径；国内入口另计 ≤ +300ms）。

**Architecture:** 抛弃「每请求 spawn 一次 CLI」的同步桥接模型，改为 **常驻 ACP Session Pool（温池）**：每个账号维持预热好的 `agent acp` 会话；请求只做 JSON-RPC 往返。必要时再叠加协议直连（绕过 CLI）与边缘预热。NewAPI / LibreChat 不改语义，只换代理执行面。

**Tech Stack:** 现有 `cursor-api-proxy` fork、Cursor CLI ACP、Node.js、systemd、Prometheus/结构化日志、NewAPI 分组路由。

## Global Constraints

- **1s 的定义（不可含糊）**
  - **主 SLO**：`POST /v1/chat/completions`，`stream:false`，`max_tokens=8`，prompt=`只回ok`，无 `tools`，经 **127.0.0.1:8765**（绕过 NewAPI）  
    - p50(total) ≤ **1000ms**  
    - p95(total) ≤ **1500ms**  
    - 成功率 ≥ **99%**（连续 100 次）
  - **辅 SLO（国内入口）**：经国内 NewAPI → 新加坡 proxy，同上 prompt：p50 ≤ **1300ms**（允许跨境 + 网关 ≤ +300ms）
  - **工具轮 / MCP**：不纳入 1s SLO（允许缓冲）；目标另定：首包 tool_calls p50 ≤ 3s
  - **流式**：首 token（TTFB）p50 ≤ **800ms**；完整短回复 p50 ≤ 1.2s
- **不做**：伪造加速（截断、缓存假回复、把静态「好」当模型输出）
- **不破坏**：账号池、tool_calls 桥接、LibreChat MCP、NewAPI 计费语义
- **诚实边界**：若 Phase 2 温池后 p50 仍 > 3s，则承认 CLI 路径无法达 1s，启动 Phase 3 协议直连或业务分流，而不是无限调参

---

## 0. 问题物理学（为什么现在是 11s）

```text
今日路径（每次请求）:
  accept HTTP
    → 选账号
    → spawn agent CLI          ← 固定 2–8s
    → 会话/鉴权/握手           ← 固定 2–5s
    → 模型生成 1 token           ← 往往 <1s
    → 拆进程
  ≈ 11–13s，与 max_tokens 几乎无关
```

| 成本类型 | 今日占比（估） | 1s 目标必须 |
|---|---|---|
| 进程冷启动 | ~40–60% | **消除**（温池） |
| 会话握手 | ~20–30% | **摊销到池生命周期** |
| 跨境 + NewAPI | ~5–10% | 国内入口优化，非主战场 |
| 真实推理 | ~10–20% | 已接近可接受 |

**优雅原则：** 把「每请求付固定税」改成「池子付固定税、请求只付边际成本」。

---

## 1. 目标架构（终态）

```text
                    ┌─────────────────────────────────────────┐
  客户端 / NewAPI   │  cursor-api-proxy (control plane)         │
                    │  - OpenAI /v1 兼容                        │
                    │  - 账号路由 / 熔断 / 指标                  │
                    │  - tool_calls 桥接（保持）                 │
                    └─────────────────┬───────────────────────┘
                                      │ 租约 session
                    ┌─────────────────▼───────────────────────┐
                    │  ACP Session Pool (data plane)            │
                    │  acc1: [S0热][S1热][S2暖]                 │
                    │  acc2: [S0热][S1暖]                       │
                    │  acc3: [S0热]                             │
                    │  - 最小空闲数 / 最大并发 / 空闲回收         │
                    │  - 健康探针 + sticky 可选                  │
                    └─────────────────┬───────────────────────┘
                                      │ JSON-RPC over stdio
                                      ▼
                               Cursor agent acp
                                      │
                                      ▼
                               Cursor 云端推理
```

**请求路径（热路径）：**

1. 鉴权、选账号（O(1)）
2. 从池中 `checkout` 已 ready 的 session（毫秒级）
3. `session/prompt`（或等价）推送本轮 messages
4. 收齐 assistant 文本 / thought（可选映射 reasoning）
5. `checkin` session（不杀进程）
6. 整形 OpenAI JSON/SSE 返回

**冷路径（仅池耗尽 / 会话死亡）：** 异步补池，当前请求可排队 ≤ 2s 或 failover 下一账号。

---

## 2. 分阶段路线图（带硬门禁）

### Phase 0 — 度量基线（0.5～1 天）**【必须先做】**

**产出：** 延迟瀑布图，精确到子阶段毫秒。

在 proxy 打点（structured log / Prometheus histogram）：

| span | 含义 |
|---|---|
| `gateway_queue` | 进入 handler → 开始执行 |
| `account_select` | 选号 |
| `spawn` | 进程创建到可写 stdin |
| `session_ready` | ACP initialize/authenticate 完成 |
| `model_first_byte` | 首个有效输出 |
| `model_complete` | 生成结束 |
| `shape_response` | 转 OpenAI 格式 |
| `total` | 端到端 |

**脚本：** `scripts/bench-latency.mjs` — 100 次短补全，输出 p50/p95/p99 与瀑布均值。

**Gate 0：** 瀑布图证明 `spawn+session_ready` ≥ 60% total。若不成立，重新归因后再进 Phase 1。

---

### Phase 1 — 快赢与减负（1～2 天）**【不指望到 1s，但清噪音】**

| 动作 | 预期收益 |
|---|---|
| 无 tools 路径禁用一切非必要 preamble / 多余 list-models | 50～200ms |
| 短请求跳过无关 preflight（maxMode 写盘等） | 50～300ms |
| 探测与业务隔离（独立低配模型/更长间隔） | 降低排队抖动 |
| NewAPI：Agent/画像默认国内组；Cursor 仅能力组 | 产品层不再用 Cursor 扛多轮 |
| 并发上限与队列可见性 | p95 毛刺下降 |

**Gate 1：** 同口径 p50 ≤ **8s**，瀑布仍显示 spawn 为主因。  
**非目标：** 此阶段不宣布接近 1s。

---

### Phase 2 — ACP 温池（核心，3～7 天）**【冲击 1s 的主战役】**

#### 2.1 池模型

```text
SessionState = idle | busy | draining | dead
AccountPool = {
  minIdle: 1,          # 每账号至少 1 条热会话
  maxSessions: 3,      # 防账号风控与内存打爆
  maxCheckoutMs: 2000,
  idleTtlMs: 15*60*1000,
  warmPrompt: "ping",  # 可选：启动后发一次极短 prompt 预热云端
}
```

#### 2.2 优雅细节（「无比完善」落在这里）

1. **租约而非拥有**：checkout/checkin；超时强制 reclaim  
2. **死亡替换**：ACP 断开 / 连续错误 → 标记 dead → 异步补池  
3. **公平选号**：热会话优先；无热会话才冷启动（冷启动不挡其它账号）  
4. **背压**：池耗尽时 429/503 + `Retry-After`，禁止无限 spawn 雪崩  
5. **与 tool_calls 共存**：有 tools 仍可复用同一 session；缓冲策略保留  
6. **安全**：session 不跨账号；token 不进日志；池内环境变量隔离  
7. **滚动发布**：`CURSOR_BRIDGE_SESSION_POOL=true` 开关；失败秒级回滚到 spawn 模式  

#### 2.3 验收

| 指标 | Gate 2a（可上线） | Gate 2b（冲击 1s） |
|---|---|---|
| p50 total（本机 proxy） | ≤ 3.0s | ≤ **1.0s** |
| p95 total | ≤ 5.0s | ≤ **1.5s** |
| 冷启动占比 | ≤ 5% 请求 | ≤ 1% |
| 内存 | 可解释，每 session 有预算 | 同左 |
| 回归 | tool_calls E2E 绿 | 同左 |

**若 Gate 2a 过、2b 不过：** 进入 Phase 3，不在池参数上空转超过 2 天。

---

### Phase 3 — 协议直连 / 旁路 CLI（高风险高收益，1～2 周）

**仅当 Phase 2 证明「会话已热、但仍 >1s」且瀑布显示成本在 Cursor 云端协议层时启动。**

方向（按优雅与合规优先级）：

1. **官方/半官方长期连接**（若 CLI ACP 支持 session 复用多轮 prompt — 优先吃干榨尽）  
2. **研究 Cursor 云端流式 RPC 直连**（类似社区 Cursor-To-OpenAI）：常驻 HTTP/2 双向流  
   - 必须：独立风控评估、指纹/版本策略、可熔断  
   - 必须：与账号池、额度、地区策略统一  
3. **双执行面**：`executor=acp-pool | direct-stream`，按模型切换  

**Gate 3：** 主 SLO 达标；风控 7 天无异常封号；可一键切回 Phase 2。

---

### Phase 4 — 边缘与产品协同（并行，持续）

这些**单独到不了 1s**，但让 1s 在真实用户侧「可感知」：

| 项 | 作用 |
|---|---|
| 国内 NewAPI 就近入口 | 辅 SLO +300ms 预算 |
| 流式默认 + 思考字段映射 | 体感；TTFB SLO |
| 投机预热：TCP/TLS 到上游、DNS cache | 小收益 |
| 业务侧：多轮禁止走 Cursor | 保护池子与额度 |
| 容量规划：账号数 × maxSessions | 避免伪优化 |

---

## 3. 里程碑与决策树

```text
Phase 0 瀑布
    │
    ├─ spawn 不是主因 ──► 重新归因（排队/模型/NewAPI）
    │
    └─ spawn 是主因
            │
         Phase 1 减负
            │
         Phase 2 温池
            │
            ├─ p50≤1s ──► 成功；进入 Phase 4 打磨与观测
            │
            ├─ 1s < p50 ≤3s ──► Phase 3 评估（协议直连）或接受「产品档」3s
            │
            └─ p50>3s 且会话已热 ──► 宣布 CLI 路径无法达 1s
                                      业务强制分流 + 评估直连/弃用 Cursor 做热路径
```

**产品诚实档位（可对外承诺）：**

| 档位 | p50 | 定位 |
|---|---|---|
| S（目标） | ≤1s | 短聊天热路径 |
| A（可上线优秀） | ≤3s | 温池成功但未达物理极限 |
| B（今日） | ~11s | spawn 模式，仅能力型使用 |

---

## 4. 观测与回归（贯穿全程）

**仪表盘（最小集）：**

- `cursor_bridge_request_duration_ms{phase,model,account,pool_hit}`  
- `cursor_bridge_pool_idle / busy / dead`  
- `cursor_bridge_spawn_total`  
- `cursor_bridge_tool_bridge_total`  
- 错误率：401/429/5xx、ACP disconnect  

**每日回归：**

```bash
node scripts/bench-latency.mjs --n=50 --target=http://127.0.0.1:8765
# 断言：p50<=SLO, p95<=SLO
```

**发布门禁：** bench 红则禁止滚新版本到 `app/current`。

---

## 5. 风险与优雅应对

| 风险 | 应对 |
|---|---|
| 常驻 session 触发风控 | 每账号会话上限；定期 rotate；模拟正常空闲；熔断回 spawn |
| 内存（3 账号 × 3 session） | cgroup 限额；idle TTL；优先减 maxSessions 而非关池 |
| ACP 协议变更 | 版本钉死 CLI；协议适配层单测；双执行面 |
| 温池与 tool_calls 交互 | 同一代码路径；集成测试「池命中 + MCP」 |
| 「1s」被理解成全场景 | SLO 文档置顶；工具轮单独 SLA |
| 投入沉没 | Gate 失败硬停；最多 2 天微调后升级/止损 |

---

## 6. 资源与节奏（建议）

| 阶段 | 工期 | 人力 |
|---|---|---|
| Phase 0 | 0.5–1d | 1 |
| Phase 1 | 1–2d | 1 |
| Phase 2 | 3–7d | 1–2 |
| Phase 3 | 0 或 1–2w | 视 Gate 2b |
| Phase 4 | 并行持续 | 0.2 |

**本周最小优雅集：** Phase 0 + Phase 1 启动 + Phase 2 设计评审与 spike（验证 ACP 能否多轮复用同一进程）。

**Spike 成功标准（半天）：** 手工保持一个 `agent acp` 进程，连续 10 次 prompt，**第 2～10 次 p50 ≤ 2s**。达不到则 Phase 2 方案需重选，勿盲写池子。

---

## 7. 一句话总纲

> **用温池消灭固定税，用瀑布图指挥优先级，用硬门禁防止自我安慰；1s 是热路径短补全的物理目标，不是所有 Cursor 场景的口号。**

---

## 8. 立即下一步（你拍板即可开工）

1. **批准本计划的 SLO 定义**（本机 proxy 1.0s / 国内入口 1.3s）  
2. **开工 Phase 0**：落地瀑布打点 + `bench-latency.mjs`  
3. **半天 ACP 复用 spike**：决定 Phase 2 是否可行  

回复「按此执行」或指出要改的 SLO/范围后，从 Phase 0 开始落地。
