# Fleet 控制台

把 agent-fleet 从一个只有机器接口的网关，变成开发者能自己注册、登录、接入 agent、编排 workflow、看执行状态的产品。

| | |
|---|---|
| **状态** | 已实现，五期全部落地 |
| **日期** | 2026-09-11（实现完成 2026-09-12） |
| **前置** | [fleet-a2a-gateway.md](fleet-a2a-gateway.md)、[fleet-composition-layer.md](fleet-composition-layer.md) |
| **重点** | §2 身份这条新轴 · §3 三个表面的边界 · §9 安全 |

---

## 1. 现状与范围

网关和组合层都已实现并验证，但**整个系统只有一种身份：agent bearer token**。`fleet_users` 表从第一版就在，却没有一行代码碰它——人类这条轴是空的。运行观察器是个折中产物：它向用户要一个 *agent* 的 token，因为当时没有别的东西可要。

本文要加的东西：

1. 落地页
2. 用户注册 / 登录
3. Dashboard：接入自己的 agent、编排 workflow
4. 从 dashboard 给 workflow 或 agent 发消息，驱动执行
5. 在 dashboard 上看 workflow 的执行流程与状态

### 1.1 已定的三个决策

| | 决策 | 理由 |
|---|---|---|
| **C1** | React + Vite SPA | dashboard 要做编辑器和实时状态，这是它该有的形态。落地页同属这个构建产物，网关当静态资源托管。 |
| **C2** | 用 Better Auth，不自己写认证 | 密码存储、会话、OAuth、找回流程都不该是我们的代码。 |
| **C3** | workflow 用带校验的代码编辑器 + 状态图预览 | 格式本身就是给程序员写的，`validateDefinition` 现成。可视化画布是给非程序员的，那是后面的命题。 |

### 1.2 本期不做

- **可视化拖拽编排。** 我们的流程是带判断回环的状态机，画布恰好不擅长这个形状（组合层文档 §1.1）。
- **组织与邀请。** 一个用户 = 一个租户，见 §2.3。
- **计费。** schema 不为它留字段，等有形态了再说。

---

## 2. 身份：新增的一整条轴

### 2.1 Better Auth 是库，不是托管服务

需要先对齐预期：Better Auth **跑在我们自己的进程里，用我们自己的 Postgres**，不是 Auth0 那样的外部服务。

这对我们其实更好——用户数据不出 `agent-db`，没有外部可用性依赖，本地开发不需要联网。但它意味着**运维责任还在我们这边**：它的表要跟着我们的迁移走，它的密钥要跟 `FLEET_SECRET_KEY` 一样管理。

它会建自己的表（`user`、`session`、`account`、`verification`，插件还会再加）。这些表**不归租户所有**，因此：

- 不给它们加 RLS 策略（它们是全局的）
- 不给 `fleet_app` 角色授权（控制台在切进租户上下文**之前**就已经解析完用户身份了）

### 2.2 认证方式

`emailAndPassword` 加 GitHub OAuth（`socialProviders.github`）。用户是开发者，agent 本来就在 GitHub 上干活，OAuth 是主路径；邮箱密码作为不想授权 GitHub 时的退路。

`fleet_users.password_hash` 是 `NOT NULL`——它属于被废弃的那版设计，Better Auth 不会用它。见 §6。

### 2.3 租户模型：不用 organization 插件

Better Auth 有 `organization` 插件，能直接给出组织、成员、邀请。**本期不用。**

理由是 `tenant_id` 在我们这里是承重的：7 个迁移、每一条查询的 `WHERE`、RLS 策略、`UNIQUE (tenant_id, agent_id)` 全都挂在它上面。引入第二套组织模型意味着两个事实来源，而它们必须时刻一致——这是那种初期看不出、后期很难拆的耦合。

**本期：一个用户 = 一个租户。** 注册时创建一个 `tenants` 行，并在映射表里记下归属：

```sql
CREATE TABLE fleet_tenant_members (
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Better Auth 的 user.id 是 text
  user_id   TEXT   NOT NULL,
  role      TEXT   NOT NULL DEFAULT 'owner',
  PRIMARY KEY (tenant_id, user_id)
);
CREATE INDEX ON fleet_tenant_members (user_id);
```

多人协作要做的时候，升级路径是明确的：这张表变成多行，再决定是自己做邀请还是换成 organization 插件。**表结构现在就按多成员设计**，所以那次升级不需要改数据模型。

`fleet_users` 表届时删除——它从未被使用过。

---

## 3. 三个表面，边界要清楚

网关现在只有一个表面。加上控制台之后是三个，它们的认证方式和威胁模型都不同，**不要混在一起**：

| 前缀 | 谁在调 | 认证 | 备注 |
|---|---|---|---|
| `/a2a/*` | agent、workflow | agent bearer token | 机器接口，不接受 cookie |
| `/api/*` | 浏览器里的 dashboard | Better Auth 会话 cookie | 人类接口，需要 CSRF 防护 |
| `/api/auth/*` | 浏览器 | Better Auth 自己管 | 它的路由处理器 |
| `/`、`/app/*` | 浏览器 | 无 | 静态资源 |

### 3.1 为什么不让 `/a2a/*` 接受会话 cookie

让一个端点同时接受 cookie 和 bearer 是常见的省事做法，代价是：

- **机器接口凭空长出 CSRF 面。** 浏览器会自动带 cookie，而 `/a2a/*` 上没有任何 CSRF 防护——它本来不需要。
- **调用方身份变得含糊。** `fleet_tasks.caller_agent_id` 现在总是一个 agent。混进人类之后，审计里「谁发起的」就不再是一个类型。

控制台需要的能力（列 agent、发消息、启动 run）在 `/api/*` 下**另外实现一遍**，内部复用同样的 store 和 dispatcher。多写的是一层薄薄的路由，换来的是两个表面各自干净。

---

## 4. 页面

```
/                  落地页
/login             登录 / 注册
/app               dashboard 首页：agent 与 run 概览
/app/agents        agent 列表
/app/agents/new    接入一个 agent（填 URL + 凭证，服务端拉 card）
/app/agents/:id    agent 详情：card、技能与 schema、健康状态、轮换 token
/app/workflows     workflow 列表
/app/workflows/:name  编辑器 + 状态图预览 + 版本
/app/runs          run 列表（现有观察器的去处）
/app/runs/:id      run 详情：时间线、变量、卡在哪
```

落地页和 SPA 是同一个 Vite 产物。**现有的 `/` 运行观察器要让位**——它的功能并入 `/app/runs`，那个「向用户要 agent token」的折中随之消失。

---

## 5. 控制台 API

全部在 `/api/*` 下，认证是会话，租户由会话里的用户解析得到——**不接受客户端传的租户参数**。

| 端点 | 作用 |
|---|---|
| `GET /api/me` | 当前用户与其租户 |
| `GET /api/agents` | agent 列表（含健康状态） |
| `POST /api/agents` | 接入 agent：校验 URL（SSRF）、拉 card、落库、签发 token（**只返回一次**） |
| `POST /api/agents/:id/token` | 轮换入站 token |
| `DELETE /api/agents/:id` | 摘除 agent |
| `POST /api/agents/:id/messages` | 给 agent 直接发一条消息（§8） |
| `GET /api/workflows` | 定义列表 |
| `PUT /api/workflows/:name/:version` | 发布定义（发布前校验） |
| `POST /api/workflows/validate` | 只校验不保存，供编辑器实时用 |
| `POST /api/workflows/:name/runs` | 启动一个 run |
| `GET /api/runs` | run 列表 |
| `GET /api/runs/:id` | 一个 run |
| `GET /api/runs/:id/events` | run 的时间线 |

`/api/agents` 这条**必须复用已有的 `registration.ts`**——那里的 SSRF 检查（私有网段、内嵌 IPv4 的 IPv6、逐跳重校验、DNS rebinding）是有真实价值的，而「从浏览器提交一个 URL 让服务器去访问」正是它要防的场景。

---

## 6. 数据模型增量

```sql
-- Better Auth 自己的表由它的 CLI 生成，纳入我们的迁移序列一起管理。
-- 它们不加 RLS，也不授权给 fleet_app：控制台在切进租户上下文之前
-- 就已经解析完用户身份了。

CREATE TABLE fleet_tenant_members (
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id   TEXT   NOT NULL,
  role      TEXT   NOT NULL DEFAULT 'owner',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
CREATE INDEX ON fleet_tenant_members (user_id);

DROP TABLE fleet_users;   -- 从未被使用
```

`tenants` 加一列 `created_by TEXT` 记下开户的人，便于排查。

---

## 7. Workflow 编辑器

左边代码，右边状态图，下面校验结果。

**校验复用 `validateDefinition`**，通过 `POST /api/workflows/validate` 实时调用——不在前端重写一份规则。前端重写的规则一定会和后端漂移，而这个校验器已经在挡「`goto` 指向不存在的状态」「转移没有兜底分支」这类会在跑了几小时之后才炸的问题。

状态图从定义本身推导：状态是节点，`next` 里的 `goto` 是边，`fail` / `escalate` 指向终态。**回环必须画得出来**——`revising → pr_opened → reviewing` 那条线是这个格式存在的理由，图里看不到它就没有意义。

编辑器不做「保存草稿」。发布即是一个版本，在途的 run 绑定它们启动时的版本（组合层文档 §6），所以改版本身是安全的。

### 7.1 JSON 与 YAML

编辑器两种格式都收，切换时按当前格式解析再按目标格式重新输出。解析不过就**不切**、也不动那段文本——因为有人点了一下标签就丢掉他写了一半的定义，比停在旧格式上等他修好语法错误要糟得多。

**YAML 只是编辑期的便利，不是存储格式。** 发布时上行的是解析后的对象，`fleet_workflows.definition` 仍是 `json` 列，引擎读的也是它。所以 YAML 的注释和排版只活到这段文本被替换为止，重新打开看到的是从 JSON 重新序列化的结果。UI 上直说了这件事，而不是让人在标注过的定义上重新打开时自己发现。

这和 0007 把 `definition` 从 `jsonb` 改回 `json`（"发布什么就该读回什么"）看似矛盾，其实不是同一层：0007 保的是**键序**这种会改变语义的东西——它当时让 `issueUrl` 静默变成了 null；这里丢的是注释和缩排，不影响任何一次运行的结果。真要让 YAML 原样往返，需要另加一列存源文本与格式，那是另一个决定。

---

## 8. 从 dashboard 驱动执行

两种触发：

**启动一个 workflow run** —— `POST /api/workflows/:name/runs`，直接复用 driver 的 `start`。`sourceRef` 由前端生成（比如页面上的一次提交对应一个 id），这样重复点击不会开出两个 run。

**给单个 agent 发消息** —— 这里有个需要决定的点：`fleet_tasks.caller_agent_id` 现在总是一个 agent，而人类不是 agent。

**不要为控制台注册一个假 agent。** 那会让它出现在 catalog 里、被 skill 查找命中、可能被 workflow 派活。改为允许 caller 是用户：`caller_agent_id` 写成 `user:<user_id>`，和组合层已经在用的 `workflow:<run_id>` 是同一种写法。审计里「谁发起的」因此仍然是一个能读懂的值。

人类发起的消息**没有回调对象**（浏览器不是 webhook 目标）。所以它和 workflow 步骤一样，由轮询读结果：前端调 `GET /api/runs/...` 或一个对应的任务查询端点。

### 8.1 payload 按 card 的 inputSchema 校验

原先发消息只检查"card 里有没有这个 skill id"。skill 的 `inputSchema`（网关文档 §5）落了库、也显示在 agent 详情页上，却不参与任何判断——一个字段拼错的 payload 会一路飞到 agent，几分钟到几小时后以一个失败回调的形式回来。

现在两处都用它校验，共用 `src/fleet/validation/payload.ts`（ajv）：

**发消息**（`POST /api/agents/:id/messages`）值是字面量，完整校验，不符 400 并逐字段列出。校验发生在**写 task 行之前**，所以被拒的消息不会在账本里留下任何需要事后解释的东西。skill 没声明 schema 就不校验——`inputSchema` 在 card 上是可选的，我们不替 agent 作者发明规则。

**workflow 的 `call.payload`** 值多半是模板，`"{{vars.requirement}}"` 要到派发时才由 `resolveValue` 求值，类型在编辑期不可知。所以那些位置被**排除**而不是猜测：把模板位置替换成占位送进 ajv，再把落在模板路径上的错误滤掉。剩下仍然查得动的是**键集**（必填缺没缺、有没有 skill 没声明的键）和**字面量的类型**。

注意排除的粒度：键是写死的、只有值是模板，所以"多了一个 skill 没声明的键"这种错报在父对象上，即便那个键的值是模板也照样报出来。

### 8.2 编辑器还对照真实 fleet

`POST /api/workflows/validate` 现在返回两组结果：

- `issues` —— 定义对照它自己（`validateDefinition`），**阻断发布**
- `warnings` —— 定义对照这个租户**已连接的 agent**，**不阻断**

warnings 有两类：没有 agent 提供这个技能，以及 payload 不符合该技能的 schema。前者正是 dispatcher 在运行时会拒绝的 `no_agent`——区别是到那时 run 已经建好，然后卡死在第一个状态。

不阻断是故意的：定义完全可能先于服务它的 agent 写出来，用发布去强迫一个连接顺序不是网关该管的事。

---

## 9. 安全

这一节是本文最该被评审的部分。加人类身份会实打实地扩大攻击面。

### 9.1 CSRF

`/api/*` 靠 cookie 认证，所以每一个写操作都暴露在 CSRF 下。Better Auth 有 `trustedOrigins` 和自带的 CSRF 检查，**不要去动 `disableCSRFCheck`**。SPA 和 API 同源部署可以免掉一层麻烦。

### 9.2 SSRF 的入口从 CLI 变成了浏览器

接入 agent 现在是任何注册用户都能触发的操作——门槛从「有 agent token」降到「有一个账号」。`ssrf.ts` 那套检查从「有价值」变成「必需」。

同时要加**速率限制**：注册 agent 会发起出站请求，不限速就是一个开放的扫描代理。

### 9.3 租户越权

控制台的每一个端点都必须从**会话**解析租户，绝不接受请求里传来的租户标识。这条和网关 §3.1「路径里的 tenant 不是权威来源」是同一条规则，只是这里连路径里都不该出现它。

RLS 仍然是兜底，但它只在切进 `fleet_app` 角色之后生效——控制台的每个请求都要走 `withTenant`。

### 9.4 token 只显示一次

agent 的入站 token 签发后只返回一次。UI 要把这件事说清楚，并提供轮换。**不要为了「方便」把它存起来再展示**。

### 9.5 Better Auth 的密钥

`BETTER_AUTH_SECRET` 和 `FLEET_SECRET_KEY` 同级别——泄漏等于可以伪造任意用户的会话。用 `insta secrets set` 管理，不进 `.env` 文件。

---

## 10. 构建与部署

```
src/            网关（现有）
web/            Vite + React
  index.html
  src/
dist/           esbuild 产出的服务端代码（现有）
dist/web/       Vite 产出的前端资源
```

`npm run build` 串起两步。网关在非 `/api`、非 `/a2a` 的路径上托管 `dist/web`，未命中的路径回落到 `index.html`（SPA 路由）。

新增环境变量：`BETTER_AUTH_SECRET`、`FLEET_TRUSTED_ORIGINS`、`GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET`、`FLEET_WEB_ROOT`。

本文原先还列了 `BETTER_AUTH_URL`，实现时没有采纳：它和 `FLEET_PUBLIC_BASE_URL` 说的是同一件事，而"这个进程对外是什么地址"有两个来源就迟早会不一致——Better Auth 的 `baseURL` 直接由 `FLEET_PUBLIC_BASE_URL` 推导。

漂移守卫此前并不存在，现在补上了：`test/fleet/envExample.test.ts` 扫描 `src/` 里每一处环境变量读取，少一个就红。它同时匹配 `process.env.X` 和 `env.X`——本仓库多数模块把 `env` 作为参数注入（`env: NodeJS.ProcessEnv = process.env`），只认前者会漏掉绝大部分变量。

---

## 11. 分期

每一期结束时系统都是可用的，不存在「做完三期才能跑」的阶段。

| 期 | 内容 | 结束时可以 | 状态 |
|---|---|---|---|
| **1** | Better Auth 接入、`fleet_tenant_members`、`/api/me`、登录页、SPA 骨架 | 注册、登录、看到一个空 dashboard | ✅ |
| **2** | agent 接入与列表、token 轮换 | 从浏览器把自己的 agent 接进来 | ✅ |
| **3** | run 列表与详情（观察器搬家） | 看到执行状态，`/` 上那个要 agent token 的折中消失 | ✅ |
| **4** | workflow 编辑器、发布、启动 run | 完整闭环 | ✅ |
| **5** | 落地页 | 可以对外 | ✅ |

实现时偏离本文的两处，都记在这里：

- **第 5 期提前做了。** 排在最后的理由（产品没定型容易返工）成立，但落地页同时是第 1 期 SPA 骨架的载体，分开做等于把同一个构建产物搭两遍。
- **`/api/agents` 比 §5 的表多出 `PATCH` 与 `DELETE`。** 接入一个 agent 之后紧接着就是改地址和摘除，只给 `POST` 会让"接进来"这件事只有一半。

落地页排在最后是故意的：它是最容易写、也最容易因为产品还没定型而返工的东西。

---

## 12. 未决问题

- **实时更新用什么。** 现在观察器是 5 秒轮询。SSE 会更贴切（服务端已经知道 run 什么时候变），但要考虑连接数和反代。轮询先用着，不阻塞。
- **Better Auth 的表怎么进迁移序列。** 它的 CLI 生成 schema，而我们的 `scripts/migrate.mjs` 是按文件顺序重放的。最简单是把生成的 SQL 落成一个编号迁移文件，代价是它升级时要手工同步。需要验证一遍流程。
- **落地页要不要独立部署。** 放在同一个进程里最省事，但营销页和平台的发布节奏通常不同。
- **一个用户多个租户。** 本期一对一。`fleet_tenant_members` 已经能表达多对多，但 UI、切换器、邀请流程都还没有。
- ~~agent 健康状态的刷新由谁触发~~：已解决。`startFleetWorkers` 新增 `healthCheck` 巡检循环，默认每 5 分钟对每个租户的每个 agent 调一次 `registration.refresh()`（`src/index.ts` 里接线），失联的 agent 现在会被标记 `unreachable`，不再永远停在注册时写入的 `healthy`。
