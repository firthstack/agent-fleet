# Fleet 组合层

把 workflow 从「某个 agent 源码里的一段 TypeScript」变成「网关认识的定义」。本文先提出模型，然后用它完整表达现有的 develop → review → merge，最后如实记录哪些装不下。

| | |
|---|---|
| **状态** | 已实现并端到端验证 |
| **日期** | 2026-09-11 |
| **前置** | [fleet-a2a-gateway.md](fleet-a2a-gateway.md)（传输层，已实现） |
| **写作顺序** | 模型 → 表达现有流程 → 证伪结论。第 3 节是重点，第 7 节是实现记录 |

---

## 1. 问题

传输层已经完成：agent 注册、发现、跨租户隔离、回调与重试都在网关手里。但**「fleet」承诺的组合能力还不存在**。

现有的 develop → review → merge 编排硬编码在 `src/fleet/agents/workflow/handler.ts` 里：

```ts
findAgentBySkill("develop.issue") → sendAndWait(...)
findAgentBySkill("review.pr")     → sendAndWait(...)
findAgentBySkill("pr.merge")      → sendAndWait(...)
```

第三方今天能注册 agent、能让它们互相路由，但**组合不出任何东西**——想要一条自己的流程，得用 TypeScript 写一个自己的编排 agent 再部署。

### 1.1 为什么是状态机，不是 DAG

现有流程的真实形状不是有向无环图：review 返回 verdict，`approved` 往前走，`request_changes` **回到** revise，然后**再 review**，循环到上限或升级给人。

这是一个**由语义判断驱动的有界循环**。n8n 式的画布擅长「A 完了给 B」，恰恰不擅长这个形状。

而且 `WorkflowStatus` 枚举**已经把状态列出来了**——它现在是用命令式代码实现的，但本身就是数据形状：

```
queued → developing → pr_opened → reviewing ⇄ changes_requested → revising
                                      ↓
                                  approved → merge_requested → completed
                                      ↓
                          failed / cancelled / needs_human
```

组合层要做的，就是把这张图从代码里搬出来。

### 1.2 一条设计红线

**必须有代码逃生舱。** 声明式格式一旦挡住真实需求，用户的选择是绕开整个平台，而不是忍受它。任何状态都可以声明为「调用我自己的 agent 来决定下一步」。

---

## 2. 模型

一份定义由五部分组成：

| 部分 | 作用 |
|---|---|
| `vars` | 运行期变量。跨步骤携带的上下文 |
| `states` | 状态。每个要么调用一个 skill，要么只做判断 |
| `next` | 转移。按顺序求值的条件列表 |
| `limits` | 计数上限，显式而非埋在参数里 |
| `resume` | 恢复点。中断的 run 从哪里接着跑 |

### 2.1 状态

```yaml
<state-name>:
  status: <写入 workflow_runs.status 的值>
  call:                      # 可选。没有 call 就是纯判断状态
    skill: <skill id>
    payload: { ... }         # 模板，可引用 vars / run
  set: { <var>: <expr> }     # 可选。调用后无条件赋值
  next:                      # 按顺序求值，第一个匹配的生效
    - when: <expr>
      set:  { ... }          # 可选
      goto: <state> | fail: <reason> | escalate: <reason>
    - goto: ...              # 无 when 即兜底
```

三种终止方式：

- `goto: completed` — 正常完成
- `fail: <reason>` — 失败，reason 落库
- `escalate: <reason>` — 转人工（现有的 `needs_human`）

### 2.2 表达式

**刻意做得很小**：字段访问、比较、`&&` `||` `!`、`??`、算术。`result` 指本步结果，`vars` 指运行变量，`run` 指 run 自身元数据。

超出这个范围的一律走逃生舱，不扩语言。这类格式的腐化几乎都是从「再加一个内置函数」开始的。

### 2.3 逃生舱

```yaml
  deciding:
    call: { skill: my.custom_decision, payload: { ... } }
    next:
      - when: "result.goto != null"
        goto: "{{result.goto}}"      # 由你自己的 agent 决定下一个状态
```

状态名是数据，所以「让我的代码决定下一步」不需要格式做任何特殊支持。

---

## 3. 用这个格式表达现有流程

这是本文的重点。下面是 `handler.ts` 里那段编排的完整等价表达，**每一个分支都对应得上**。

```yaml
workflow: develop-review-merge
version: 1
description: 实现需求、评审、按意见修订直到通过，最后请人合并。

# 重投递的派发不能开出第二个 run（对应 getWorkflowRunBySource 去重）
dedupeBy: [source.type, source.ref]

vars:
  requirement:
    from: input.requirement
    required: true
  issueUrl:
    from: input.issueUrl
    # 对应 extractGitHubIssueUrl：输入没给就从需求文本里抽
    else: { regex: 'https?://github\.com/[\w.-]+/[\w.-]+/issues/\d+', over: vars.requirement }
  prUrl:     { from: input.prUrl, else: null }
  reviewUrl: { init: null }
  iteration: { init: 0 }
  findings:  { init: [] }

limits:
  maxIterations: 7

# 两个入口合并成一条起始判断：
#   workflow.develop   → 没有 prUrl → 从 developing 开始
#   workflow.review_pr → 有 prUrl   → 直接进 pr_opened
start:
  - when: "vars.prUrl != null"
    goto: pr_opened
  - goto: developing

states:

  developing:
    status: developing
    call:
      skill: develop.issue
      payload:
        requirement: "{{vars.requirement}}"
        issueUrl:    "{{vars.issueUrl}}"
        iteration:   "{{vars.iteration}}"
    next:
      - when: "result.ok && result.prUrl"
        set:  { prUrl: "{{result.prUrl}}" }
        goto: pr_opened
      - fail: develop_failed

  pr_opened:
    status: pr_opened
    next:
      - goto: reviewing

  reviewing:
    status: reviewing
    call:
      skill: review.pr
      payload:
        prUrl:       "{{vars.prUrl}}"
        requirement: "{{vars.requirement}}"
        iteration:   "{{vars.iteration}}"
    # 对应「reviewUrl 存在就记下来」那次额外的 recordState
    set:
      reviewUrl: "{{result.reviewUrl ?? vars.reviewUrl}}"
    next:
      - when: "!result.ok || !result.verdict"
        fail: review_failed
      - when: "result.verdict == 'approved'"
        goto: requesting_merge
      - when: "result.verdict == 'comment'"
        escalate: review_comment
      - when: "result.verdict == 'request_changes'"
        set:  { findings: "{{result.findings ?? []}}" }
        goto: changes_requested
      - fail: review_failed

  requesting_merge:
    status: merge_requested
    call:
      skill: pr.merge
      payload:
        prUrl:         "{{vars.prUrl}}"
        reviewUrl:     "{{vars.reviewUrl}}"
        workflowRunId: "{{run.id}}"
        reason: "codex review passed; external approval required before merge"
    next:
      - when: "result.ok"
        goto: completed
      - fail: merge_request_failed

  changes_requested:
    status: changes_requested
    set:
      iteration: "{{vars.iteration + 1}}"
    next:
      - when: "vars.iteration >= limits.maxIterations"
        escalate: max_iterations_exceeded
      - goto: revising

  revising:
    status: revising
    call:
      skill: develop.revise
      payload:
        requirement:    "{{vars.requirement}}"
        priorPrUrl:     "{{vars.prUrl}}"
        iteration:      "{{vars.iteration}}"
        reviewFindings: "{{vars.findings}}"
    next:
      - when: "result.ok && result.prUrl"
        set:  { prUrl: "{{result.prUrl}}" }
        goto: pr_opened          # 回到评审循环
      - fail: develop_failed

# 对应 runRetryFailedStep 里那两个分支
resume:
  - when: "run.status == 'reviewing' && vars.prUrl != null"
    goto: reviewing
  - when: "run.status == 'failed' && run.reason == 'develop_failed' && vars.prUrl == null"
    goto: developing
```

### 3.1 对照检查

| `handler.ts` 里的行为 | 上面的对应物 |
|---|---|
| `getWorkflowRunBySource` 去重 | `dedupeBy` |
| `extractGitHubIssueUrl` | `vars.issueUrl.else.regex` |
| 两个入口函数 | `start` 的条件判断 |
| `develop.issue` 抛异常 / `!ok` / 无 prUrl | 三种情况都落到 `fail: develop_failed` |
| 记录 reviewUrl 的额外 recordState | `reviewing.set` |
| verdict 三分支 | `reviewing.next` 前四条 |
| `iteration + 1` 与 `maxIterations` 判断 | `changes_requested` |
| `develop.revise` 后回到 `pr_opened` | `revising` 的 goto |
| `runRetryFailedStep` 的两个分支 | `resume` |

---

## 4. 证伪结论

写下来之后，有三件事装不下、或者装下了但暴露了问题。**这是这次练习真正的产出。**

### 4.1 装不下：从自由文本里抽 URL

`extractGitHubIssueUrl` 是一段正则。我在格式里加了 `regex/over` 原语才装下它。

**这是第一个滑坡。** 下一个需求会是「从 PR body 里抽 issue 号」，再下一个是「把 findings 按 severity 分组」，然后表达式语言就长成了一门半吊子编程语言。

**建议**：`regex` 保留（够常见），但划一条线——**任何需要第二个内置函数的场景一律走逃生舱**。这条线要写进规范，不然守不住。

### 4.2 装下了，但顺带改了一个行为

现有代码里 `merge_requested` 是在 `pr.merge` **返回之后**才记录的。用状态机表达时必须先给「正在请求合并」这个在途状态命名，于是它变成**调用前**记录。

**这是个改进，不是妥协。** 现在这条路径如果 Slack 挂了卡住，run 的状态停在 `approved`，运行观察器上看不出「已经在等合并了」。改完之后能看出来。

但它是一个真实的行为变化，迁移时要知道。

### 4.3 暴露了 schema 的一个缺陷

`resume` 的第二条要判断 `run.reason == 'develop_failed'`。而现在 `reason` 埋在 `run.result` 这个 JSONB 里（`resultReason()` 就是为了把它挖出来）。

失败原因是**一等的、要被查询和索引的**运行状态，不该藏在结果 blob 里。

**建议**：`workflow_runs` 加一列 `reason TEXT`。这跟组合层无关——现在的 `runRetryFailedStep` 也在做同样的挖掘，只是没人注意。

### 4.4 顺带白拿的三样东西

- **能力预检自动化。** 现在代码里手工检查三次 `findAgentBySkill`（`runDevelopmentWorkflow` 开头）。定义里引用了哪些 skill 是静态可得的，引擎自己就能在启动前查一遍。**这段手写代码可以删掉。**
- **恢复点从特例变成声明。** `runRetryFailedStep` 里那段 if-else 和末尾的 `throw new Error("can only retry...")`，变成 `resume` 列表——匹配不到就是不可恢复，不需要专门写一个错误。
- **迭代上限浮出水面。** 从一个函数参数变成定义里的 `limits`，改它不用改代码。

---

## 5. 与网关的集成

组合层**必须是网关的一等资源**，不能做成给 agent 用的 SDK。这是真正的分叉点：

- 做成 SDK → 编排逻辑留在某个 agent 进程里，网关对它是瞎的。以后想加可视化，没有东西可以挂靠。
- 做成网关认识的定义 + 运行时 → 可视化编辑器只是这个 API 的客户端；审计和可观测性免费获得；已经写好的重试、超时、deadline 三方共识直接延伸到每一步。

### 5.1 复用已有机制

每个 `call` 就是网关已经在做的那次派发（gateway 文档 §7）：

| 组合层概念 | 复用的传输层机制 |
|---|---|
| 一个 `call` | `fleet_tasks` 一行，走完整的 ①②③④ |
| 步骤超时 | `deadline_at`，已有的三方共识 |
| 步骤重试 | 已有的退避重试与 sweeper |
| 步骤事件 | `fleet_task_events` |
| 跨租户隔离 | 定义本身带 `tenant_id`，`call` 的目标解析仍走同租户 |

**组合层不需要自己实现任何可靠性机制**，它只是在 `fleet_tasks` 之上加了一层「下一步是什么」。

### 5.2 新增的表

```sql
CREATE TABLE fleet_workflows (            -- 定义
  id, tenant_id, name, version, definition JSONB,
  UNIQUE (tenant_id, name, version)
);

CREATE TABLE fleet_workflow_runs (        -- 运行实例
  id, tenant_id, workflow_id,
  state TEXT,                             -- 当前状态名
  status TEXT,                            -- 状态声明的 status
  reason TEXT,                            -- §4.3
  vars JSONB,                             -- 运行变量当前值
  source_type, source_ref,                -- 去重键
  UNIQUE (tenant_id, source_type, source_ref)
);
```

现有 workflow-agent 的 SQLite `workflow_runs` 是它的前身。迁移时机取决于是否还保留「个人 agent 自带编排」这条路（D6 的划线可能要重新考虑——编排一旦成为平台能力，它的状态还算不算个人 agent 的私有状态？这是个未决问题）。

---

## 6. 未决问题

- **引擎跑在哪。** 状态机推进是长任务（小时级），不能占着请求连接。最自然的是复用网关已有的 worker 循环：每次 `call` 完成的回调（③）触发一次状态推进。这样引擎是完全事件驱动的，没有常驻 saga——**顺带解决了 gateway 文档 §13.1 那个「workflow-agent 重启丢在途 saga」的问题**。值得优先验证这条路。
- **D6 的划线要不要动。** 见 §5.2。
- **可视化先做哪个。** 我的判断是**先做运行观察器，不是编辑器**——数据（`fleet_tasks` + `fleet_task_events` + run 的状态变迁）已经全在手上，而用户第一次真正需要的是「它跑了 40 分钟，卡在哪，为什么」。编辑器可以晚很久。
- **版本化与在途 run。** 定义改版时，在途的 run 按旧版跑完还是迁移？倾向前者（run 绑定 `workflow_id` 含版本），但要确认。
- **表达式语言的实现选型。** 自己写一个小求值器，还是用 CEL / JSONLogic？自己写的风险是慢慢长大，用现成的风险是引入一整套语义。

---

## 7. 实现记录

设计落地后，模型本身没有改动——§2 的五个部分和 §3 的定义原样可用。但实现过程中有四处值得记下来。

### 7.1 端到端验证的范围

`test/fleet/workflowEndToEnd.test.ts` 跑的是**真实 Postgres + 真实 HTTP + 真实 A2A agent 运行时**：网关派发给用 `createA2AServer` 起的三个桩 agent，它们回调真实的 `/a2a/callbacks/{token}`，driver 从真实的认领队列里取走完成的步骤再派发下一步。唯一是桩的是 agent 的业务逻辑——而那恰好是 fleet 不负责的部分。

修订循环的事件序列如实产出：

```
created → developing → pr_opened → reviewing → changes_requested
        → revising → pr_opened → reviewing → requesting_merge → completed
```

### 7.2 推进的依据是任务，不是 run

`applyDecision` 在派发**之前**写 run 的状态（这样卡住的步骤在观察器上可见）。于是派发失败时，run 比被重试的那个任务领先一个状态——按 run 恢复就会从错的地方继续。

所以任务上记了 `workflow_from_state`，推进一律以它为准。run 的状态回归纯观察用途。

**但"派发失败就重试"这条只对一部分失败成立。** `WorkflowDispatchError` 有三个码，重试价值完全不同：

| 码 | 含义 | 重试有用吗 |
|---|---|---|
| `dispatch_failed` | agent 不可达、请求超时 | **有** —— 同一次派发过一会儿可能就成了 |
| `no_agent` | 租户里没有任何 agent 提供这个技能 | 没有 |
| `ambiguous_agent` | 多个 agent 提供，而定义没指名 | 没有 |

后两个此前也走重试路径，代价是一个真实事故：run 卡在 `requesting_merge`，因为 `pr.merge` 没有对应的 agent。run 行在派发**之前**已经写进去了，于是它前进了一格；派发抛错后重试把同一个状态重写了 5 次、约 8 分钟，然后放弃。而**这一步压根没有 task 行**——dispatcher 在 `createTask` 之前就抛了——超时清扫又只看 `fleet_tasks`，所以放弃之后再没有任何东西能推动它。它永远停在一个看起来还活着的状态上。

现在这两个码直接把 run 判为 `failed`，`reason` 写成点名了技能的那句话，并抛 `WorkflowRunFailed` 让驱动它的那个 task 退出认领队列（否则它会被反复认领、以同样方式一路失败到尝试上限）。时间线仍然记下它到达过的状态，再记 `failed`——run 确实进入过那一格，看不见它等于隐瞒了它走到哪。

遗留：`start()` 里的 `dispatch_failed` 仍会搁浅。首步没有 task 行可供重试，所以它和上面的情形一样无人接手，只是原因是暂时性的。

### 7.2.1 每租户的并发名额

把编排搬进平台，顺手丢掉了一个没人注意到的东西：**原来那个 workflow agent 内部排队**，于是整个 fleet 天然有一个并发上限。搬进来之后 `POST /runs` 在请求内同步派发，N 个并发提交就是 N 个立即派发。实测五次提交，五个调用在 38 毫秒内全部压到同一个 agent 上。

后果不只是慢。agent 若有共享状态（同一个 git 工作区、同一个分支），并发是互相破坏而不是排队；被压垮变慢之后步骤逼近 6 小时 deadline，于是过载表现成"工作流随机失败"而不是"变慢"。

现在每个租户有一个并发上限（`FLEET_MAX_CONCURRENT_RUNS_PER_TENANT`，默认 10）。**超出的提交仍然被受理**——run 建出来、有 sourceRef、在列表里看得见——只是 `admitted_at` 为 NULL，不派发任何东西。名额腾出来之后由 worker 按提交顺序拉起。

几个要点：

- **名额只按租户算。** 一个账号的突发不该决定平台对其他人的行为。
- **计数与写入在同一个事务里，由租户维度的 `pg_advisory_xact_lock` 串起来。** 少了它，两个网关会同时读到"还差一个"然后双双放行。锁只跨两条廉价语句，绝不跨派发。
- **排空排在推进之后。** 同一跳里刚腾出的名额立刻交接，而不是白等 15 秒。
- **`input_payload` 单独存一列。** 排队的 run 要算出与立即启动**完全相同**的起始决策，而 `vars` 存的是走完 start 转移之后的值——拿它重算会把转移里的 `set` 应用第二次。
- **崩溃窗口有兜底。** `admitted_at` 写在派发之前，进程死在中间会留下一个占着名额却无人驱动的 run；排空器把"已获名额但仍是 `queued`"的 run 一并认领回来重新驱动。

### 7.3 重放的完成回调必须是空操作

网关是至少一次投递，同一个完成可能到两次。第二次推进会再派发一次下一步——**一个需求开出两个 PR**。

`fleet_workflow_runs.awaiting_task_id` 记住 run 当前在等哪个任务，不匹配的完成直接跳过。注意它的更新语义：patch 里**不传**表示保留（派发失败后重试要靠它），传 `null` 才是清空。

### 7.4 两个认领队列必须互斥

workflow 的步骤和普通的调用方通知共用一张表、一套认领机制。如果不加区分，一个 workflow 步骤完成后会**被两个消费者同时取走**——driver 推进状态机，notifier 再打一次 webhook。

通知队列的条件加了 `AND workflow_run_id IS NULL`，driver 的加了 `IS NOT NULL`。两条对向的测试盯着这个互斥。

### 7.5 声明式改写差点丢掉一处可观测性

`pr_opened` 是引擎「走过但不派发」的决策状态，最初 driver 只为派发的状态记事件，于是它从运行历史里消失了——而被替换的命令式代码是记的，且「PR 已开出」对运行观察器是实打实的里程碑。

修法是让引擎汇报它走过的完整路径（`Decision.path`），driver 逐个记事件。**这类丢失只有靠断言完整事件序列才能发现**，断言最终状态是发现不了的。
