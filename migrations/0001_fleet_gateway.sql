-- Fleet 多租户 A2A 网关：基础 schema
-- 设计见 docs/fleet-a2a-gateway.md §10
--
-- 这是全新 schema，不承接旧的 fleet_messages / fleet_message_events。
-- tenant_id 从一开始就铺满所有表（§10 开头），即使初期只有一个默认租户。
-- RLS 策略在 0002 中单独启用（§11.3 第 6 步）。

CREATE TABLE IF NOT EXISTS tenants (
  id           BIGSERIAL PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,            -- 出现在网关 URL 中
  display_name TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fleet_users (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  username      TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fleet_users_role_check CHECK (role IN ('owner', 'member')),
  UNIQUE (tenant_id, username)                  -- 不再全局唯一
);

CREATE TABLE IF NOT EXISTS fleet_agents (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id        TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  endpoint_url    TEXT NOT NULL,                -- 真实地址，永不外泄
  card_json       JSONB NOT NULL,
  card_fetched_at TIMESTAMPTZ,
  health          TEXT NOT NULL DEFAULT 'unknown',
  last_seen_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fleet_agents_health_check
    CHECK (health IN ('unknown', 'healthy', 'unreachable', 'stale')),
  -- 关键：两个租户都可以有自己的 "dev-agent"
  UNIQUE (tenant_id, agent_id)
);

CREATE TABLE IF NOT EXISTS fleet_agent_skills (
  tenant_id    BIGINT NOT NULL,
  agent_id     TEXT NOT NULL,
  skill_id     TEXT NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL,
  input_schema JSONB,                           -- 来自 card，第三方对接的关键
  PRIMARY KEY (tenant_id, agent_id, skill_id),
  FOREIGN KEY (tenant_id, agent_id)
    REFERENCES fleet_agents (tenant_id, agent_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS fleet_agent_skills_by_skill
  ON fleet_agent_skills (tenant_id, skill_id);

-- 入站：agent 调网关时用的凭证
CREATE TABLE IF NOT EXISTS fleet_agent_tokens (
  id         BIGSERIAL PRIMARY KEY,
  tenant_id  BIGINT NOT NULL,
  agent_id   TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  FOREIGN KEY (tenant_id, agent_id)
    REFERENCES fleet_agents (tenant_id, agent_id) ON DELETE CASCADE
);

-- 出站：网关调 agent 时用的凭证，方案取自该 agent card 的 securitySchemes
CREATE TABLE IF NOT EXISTS fleet_agent_credentials (
  tenant_id  BIGINT NOT NULL,
  agent_id   TEXT NOT NULL,
  scheme     TEXT NOT NULL,
  secret_enc BYTEA NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, agent_id),
  CONSTRAINT fleet_agent_credentials_scheme_check
    CHECK (scheme IN ('bearer', 'apiKey', 'oauth2', 'mtls')),
  FOREIGN KEY (tenant_id, agent_id)
    REFERENCES fleet_agents (tenant_id, agent_id) ON DELETE CASCADE
);

-- 网关的核心新增状态：上游任务 ↔ 下游任务的映射（§7）
CREATE TABLE IF NOT EXISTS fleet_tasks (
  id                   BIGSERIAL PRIMARY KEY,
  tenant_id            BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  upstream_task_id     TEXT NOT NULL,           -- 网关发给调用方的
  caller_agent_id      TEXT NOT NULL,
  caller_callback_url  TEXT,
  caller_callback_auth JSONB,
  target_agent_id      TEXT NOT NULL,
  skill_id             TEXT NOT NULL,
  downstream_task_id   TEXT,                    -- 被调方返回的
  callback_token_hash  TEXT UNIQUE,             -- 一次一任务，终结即失效
  state                TEXT NOT NULL,
  attempt              INT NOT NULL DEFAULT 0,
  next_retry_at        TIMESTAMPTZ,
  deadline_at          TIMESTAMPTZ NOT NULL,
  result_json          JSONB,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fleet_tasks_state_check CHECK (state IN (
    'dispatching', 'running', 'done_pending_notify',
    'done', 'failed', 'timed_out', 'cancelled'
  )),
  UNIQUE (tenant_id, upstream_task_id)
);

CREATE INDEX IF NOT EXISTS fleet_tasks_retry_scan
  ON fleet_tasks (state, next_retry_at);
CREATE INDEX IF NOT EXISTS fleet_tasks_deadline_scan
  ON fleet_tasks (state, deadline_at);

CREATE TABLE IF NOT EXISTS fleet_task_events (
  id         BIGSERIAL PRIMARY KEY,
  tenant_id  BIGINT NOT NULL,
  task_id    BIGINT NOT NULL REFERENCES fleet_tasks(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload    JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fleet_task_events_by_task
  ON fleet_task_events (task_id, id);
