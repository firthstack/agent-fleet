// 本地注册一个 agent，直到控制台的 agent onboarding 落地为止。
//
//   FLEET_AGENT_TOKEN=<agent 的 bearer> \
//     npx tsx scripts/register-agent.ts <tenant-slug> <agent-id> <endpoint-url> [display name]
//
// endpoint 必须现在就能取到 /.well-known/agent-card.json —— 注册即拉卡，
// 卡里的 skills 就是 workflow 匹配用的索引。
//
// 两个方向的凭据不要混：
//
//   FLEET_AGENT_TOKEN  网关调 agent 时出示的，必须和 agent 进程启动时那个
//                      FLEET_AGENT_TOKEN 一模一样，否则 agent 会 401 掉网关。
//   打印出来的 token   agent 回调网关时出示的，只显示这一次（库里是哈希）。

import dotenv from "dotenv";
import { GatewayStore } from "../src/fleet/site/gatewayStore.js";
import { fleetDatabaseUrlFromEnv } from "../src/fleet/site/db.js";
import { fleetSecretBoxFromEnv } from "../src/fleet/site/secretBox.js";
import { createRegistrationService } from "../src/fleet/site/registration.js";

dotenv.config();

const [slug, agentId, endpointUrl, ...rest] = process.argv.slice(2);
if (!slug || !agentId || !endpointUrl) {
  console.error(
    "usage: npx tsx scripts/register-agent.ts <tenant-slug> <agent-id> <endpoint-url> [display name]",
  );
  process.exit(1);
}

const store = new GatewayStore({
  connectionString: fleetDatabaseUrlFromEnv(),
  secretBox: fleetSecretBoxFromEnv(),
});

try {
  const tenant = await store.getTenantBySlug(slug);
  if (!tenant) {
    console.error(`no such tenant: ${slug}（控制台右上角显示的就是它）`);
    process.exit(1);
  }

  const svc = createRegistrationService({
    store,
    // 本地 agent 跑在 http://127.0.0.1 上，默认策略只放行 https 且拒绝私有地址。
    ssrfPolicy: { allowInsecure: true },
  });

  // 没有 credential，网关调 agent 时就不带 Authorization，而 agent 端是
  // bearerAuthenticator —— 注册会成功，第一次派活才 401，排查起来很绕。
  const inbound = process.env.FLEET_AGENT_TOKEN?.trim();
  if (!inbound) {
    console.error(
      "FLEET_AGENT_TOKEN is required: 它是网关调这个 agent 时出示的 bearer，\n" +
        "必须和 agent 进程启动时用的那个一致。",
    );
    process.exit(1);
  }

  const { agent, token } = await svc.register({
    tenantId: tenant.id,
    agentId,
    endpointUrl,
    credential: { scheme: "bearer", secret: inbound },
    ...(rest.length > 0 ? { displayName: rest.join(" ") } : {}),
  });

  console.log(`registered ${agent.agentId} (${agent.displayName}) → ${agent.endpointUrl}`);
  console.log(`skills: ${agent.card.skills?.map((s) => s.id).join(", ") || "(none)"}`);
  console.log(`\ncallback token (只显示这一次) —— agent 回调网关用:\n${token}`);
} finally {
  await store.close();
}
