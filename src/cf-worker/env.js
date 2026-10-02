// Worker 运行时地基（cf-worker 专属，Fly 路径不经过本文件任何逻辑）
// 职责：
//   1) 环境变量桥：把 Worker env 里的 string 值写入 process.env（nodejs_compat 下可写），
//      使现有业务模块（auth.js / email.js / alerts.js / monitors.js ...）读 process.env 的代码零改动。
//   2) 标记 Resend HTTP 通道：Workers 禁裸 TCP(465)，nodemailer/SMTP 不可用；
//      email.js / alerts.js 检测 globalThis.__USE_RESEND_HTTP__ 后走 Resend HTTP API。
//   3) Hyperdrive 连接注入：由 index.js 调 configurePool()（见 src/db.js）完成。

import { configurePool } from '../db.js';

let bridged = false;

export function bridgeEnv(env) {
  for (const k of Object.keys(env || {})) {
    const v = env[k];
    if (typeof v === 'string') process.env[k] = v;
  }
  // Workers 出口无 SMTP 能力：邮件统一走 Resend HTTP（email.js / alerts.js 运行时自适应）
  globalThis.__USE_RESEND_HTTP__ = true;
  bridged = true;
}

// 幂等：每个 isolate 首个请求/调度前调用一次；同一连接串不重复建池
export function setupDb(env) {
  if (!bridged) bridgeEnv(env);
  const cs = env && env.HYPERDRIVE && env.HYPERDRIVE.connectionString;
  if (cs) configurePool({ connectionString: cs });
}
