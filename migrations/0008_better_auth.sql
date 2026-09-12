-- Better Auth 的表 + 租户归属映射（docs/fleet-console.md §2、§6）
--
-- 这些表由 `npx @better-auth/cli generate` 产出，原样落成一个编号迁移，
-- 这样它们和我们自己的表走同一套重放机制。Better Auth 升级时需要重新生成
-- 并追加一个新的迁移文件——它不会自己改这里。
--
-- 表名加了 auth_ 前缀（auth.ts 里的 modelName）。默认名是 user / session /
-- account / verification：user 是 Postgres 保留字，四个名字也都泛到会和这个
-- schema 里别的东西撞。
--
-- 生成的 create 语句被加上了 if not exists：其余七个迁移都是幂等的，
-- 重放整个序列是测试和本地重建的常规操作。
--
-- 它们**刻意不加 RLS、不授权给 fleet_app**：这些表不归任何租户所有，而控制台
-- 在切进租户安全上下文之前就已经解析完用户身份了。

create table if not exists "auth_user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" boolean not null, "image" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);

create table if not exists "auth_session" ("id" text not null primary key, "expiresAt" timestamptz not null, "token" text not null unique, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null, "ipAddress" text, "userAgent" text, "userId" text not null references "auth_user" ("id") on delete cascade);

create table if not exists "auth_account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "auth_user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz, "scope" text, "password" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null);

create table if not exists "auth_verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" timestamptz not null, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);

create index if not exists "auth_session_userId_idx" on "auth_session" ("userId");

create index if not exists "auth_account_userId_idx" on "auth_account" ("userId");

create index if not exists "auth_verification_identifier_idx" on "auth_verification" ("identifier");
-- 谁属于哪个租户。
--
-- 不用 Better Auth 的 organization 插件：tenant_id 在我们这里是承重的（7 个
-- 迁移、每条查询的 WHERE、RLS 策略、UNIQUE (tenant_id, agent_id) 都挂在它上
-- 面），引入第二套组织模型等于两个必须时刻一致的事实来源。
--
-- 本期一个用户 = 一个租户，但这张表现在就按多成员设计，将来做协作不必改数据
-- 模型。
CREATE TABLE IF NOT EXISTS fleet_tenant_members (
  tenant_id  BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    TEXT   NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
  role       TEXT   NOT NULL DEFAULT 'owner',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fleet_tenant_members_role_check CHECK (role IN ('owner', 'member')),
  PRIMARY KEY (tenant_id, user_id)
);

-- 登录后要按用户找租户，这是最热的那条查询。
CREATE INDEX IF NOT EXISTS fleet_tenant_members_by_user
  ON fleet_tenant_members (user_id);

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS created_by TEXT;

-- fleet_users 从第一版就在，但没有一行代码碰过它。Better Auth 也不会用它的
-- password_hash。
DROP TABLE IF EXISTS fleet_users;
