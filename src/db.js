// 数据库层：连接 Supabase Postgres，初始化表结构
// 首次运行自动建表；后续启动静默通过

import 'dotenv/config';
import { Pool } from 'pg';

// 模块级连接池：业务查询与会话存储（connect-pg-simple）共用同一 pool
// ssl.rejectUnauthorized=false：仍走 TLS 加密，但不校验 CA 链。
// 背景：pg v8 把连接串里的 sslmode=require 当作 verify-full，而 Supabase 池化器
// 证书链的 CA 不在 Node 默认信任库内，会报 self-signed certificate in certificate chain。
// 这是 Supabase 官方 Node 示例采用的通用做法，仅关闭 CA 校验、加密不受影响。
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  // ===== 连接池显式上限与超时（P0-1，2026-09-23）=====
  // 背景：此前这个 Pool 是**零配置**的，全部走默认值，而默认值恰好是致命的：
  // 读 node_modules/pg-pool/index.js:206-209 源码确认 —— connectionTimeoutMillis 为假值时，
  // 拿不到空闲连接的请求会直接 _pendingQueue.push() 然后 return，**连超时定时器都不建**。
  // ⇒ 「池满」的表现不是报错，而是请求**永久挂起**（前端表现为加载不出、前置代理 502）。
  //   2026-09-23 14:17 访客看到的失败弹窗、以及 API 间歇 502，机制上都能对上这一条。
  //
  // Supabase 官方额度（免费档 Nano，2026-09-23 查证官方文档 compute-and-disk / connection-management）：
  //   · Database Max Connections = 60（此额度**包含** Supabase 自身服务 Auth/Storage/PostgREST/health checker 的连接）
  //   · Supavisor 客户端连接上限 = 200
  //   · 官方建议 pool size 不超过 Database Max Connections 的 80%（不使用 PostgREST 时）
  // ⇒ Fly 双实例 × max=6 = 12 条客户端连接，远低于 200 上限，且无需任何付费项。
  //
  // 关键一项是 connectionTimeoutMillis：把「永久挂起」变成「10 秒快速失败」，
  // 失败会沿 wrap() → 全局错误中间件返回 503，而不是把连接和请求一起拖死。
  max: Number(process.env.PG_POOL_MAX || 6),
  connectionTimeoutMillis: Number(process.env.PG_CONN_TIMEOUT_MS || 10000), // 池满 10s 快速失败，不再无限等待
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30000),      // 默认 10s 偏短：跨境链路下频繁重建连接会推高认证失败率
  statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS || 15000), // 服务端：慢查询不许一直占着连接
  idle_in_transaction_session_timeout: Number(process.env.PG_IDLE_TX_TIMEOUT_MS || 30000), // 服务端：防止事务挂起占锁占连接
  query_timeout: Number(process.env.PG_QUERY_TIMEOUT_MS || 15000),         // 客户端：同上，兜第二道
  // 便于在 pg_stat_activity 里认出本服务的连接（官方推荐做法，排查连接占用的第一步）
  application_name: process.env.PG_APP_NAME || 'pingory',
});

async function getPool() {
  return pool;
}

// 保活：Supabase 免费档仅在「连续 7 天零查询」时才暂停计算；本服务每 4 分钟查询一次，
// 永不满足该条件，因此数据库不会休眠。同时防止连接池空闲超时断开。
let keepAliveTimer = null;
export function startKeepAlive(intervalMs = 4 * 60 * 1000) {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(async () => {
    try {
      const p = await getPool();
      await p.query('SELECT 1');
    } catch (e) {
      console.warn('[db] keepalive 查询失败（连接可能已断开，下次请求会自动重连）:', e.message);
    }
  }, intervalMs);
  // 不阻止进程退出
  if (keepAliveTimer.unref) keepAliveTimer.unref();
}

// 初始化容错（2026-09-22 事故根因之一，P1-14）：
// 启动瞬间的数据库抖动（跨境网络 / 连接池刚建连）会让整段 DDL 失败；
// 旧实现直接抛出，而 server.js 的启动 IIFE 当时没有 .catch() ⇒ unhandled rejection ⇒ exit_code=1 秒崩。
// 现在：内部按指数退避重试若干次；用尽后抛给 server.js 的 bootstrap 循环继续重试（进程不退出）。
const INIT_RETRY_DELAYS_MS = [2000, 4000, 8000, 16000, 30000]; // 5 次重试，累计等待 60s

// ===== 版本化迁移（P1-⑥，2026-09-23）=====
// 旧行为：每次进程启动都跑下面这一整段（≈100 条 CREATE/ALTER + 1 条 DELETE）。
//   双机同时启动 = 两份全量 DDL 并发打库，而启动往往发生在崩溃重启时（数据库本来就紧张）
//   ⇒ 二次冲击，放大故障窗口（2026-09-23 两台机器各崩两次，重启又会再打一遍 DDL）。
// 新行为：
//   · schema_migrations 记版本；版本已是最新 ⇒ 直接跳过（正常启动不再碰 DDL）
//   · 确实需要迁移时先用 pg_advisory_lock 串行化，双机不会同时迁移
//   · 原夹在 DDL 里的「孤儿监控清理 DELETE」改为迁移期一次性执行，不再出现在每次启动路径上
//     （且 monitors.user_id 已补 ON DELETE CASCADE 外键，此后新产生的孤儿会随用户删除自动清理）
// 简化模型：DDL 全部幂等（IF NOT EXISTS / ADD COLUMN IF NOT EXISTS），
// 因此「迁移」= 重跑一遍幂等基线 + 记录版本号；中途失败后重跑是安全的（不会重复生效）。
const SCHEMA_VERSION = 1;
const MIGRATION_LOCK_KEY = 8675309;   // 本应用专用常量，仅用于串行化迁移
const MIGRATION_LOCK_WAIT_MS = 30000; // 抢不到锁时的最长等待（每 1s 重试一次）

const SCHEMA_DDL = `
    CREATE TABLE IF NOT EXISTS monitors (
      id          TEXT PRIMARY KEY,
      url         TEXT NOT NULL,
      name        TEXT,
      interval    INTEGER NOT NULL DEFAULT 60,
      status      TEXT NOT NULL DEFAULT 'unknown',
      last_checked BIGINT,
      last_response_time INTEGER,
      last_error  TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS monitor_events (
      id            BIGSERIAL PRIMARY KEY,
      monitor_id    TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
      event_type    TEXT NOT NULL,   -- 'status_change' | 'alert'
      from_status   TEXT,
      to_status     TEXT,
      response_time INTEGER,
      error         TEXT,
      detail        TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_monitor_events_monitor_id ON monitor_events(monitor_id);
    CREATE INDEX IF NOT EXISTS idx_monitor_events_created_at  ON monitor_events(created_at DESC);

    -- 用户表
    CREATE TABLE IF NOT EXISTS users (
      id                     TEXT PRIMARY KEY,
      email                  TEXT NOT NULL UNIQUE,
      password_hash          TEXT NOT NULL,
      plan                   TEXT NOT NULL DEFAULT 'free',  -- free | starter | pro
      paddle_customer_id     TEXT,
      paddle_subscription_id TEXT,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- monitors 增加归属用户（历史数据 user_id 为 NULL，视为匿名）
    ALTER TABLE monitors ADD COLUMN IF NOT EXISTS user_id TEXT;
    CREATE INDEX IF NOT EXISTS idx_monitors_user_id ON monitors(user_id);

    -- 轮询增量取数所需的索引（P1-④）：last_checked 是「是否到期」的唯一判据列
    CREATE INDEX IF NOT EXISTS idx_monitors_last_checked ON monitors(last_checked);

    -- ===== Phase 1 扩展字段（G1 多检查类型 / G2 告警逻辑 / G4 渠道 / G5 状态页）=====
    ALTER TABLE monitors ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'http';
    ALTER TABLE monitors ADD COLUMN IF NOT EXISTS config TEXT;          -- JSON：各类型专属配置
    ALTER TABLE monitors ADD COLUMN IF NOT EXISTS channels TEXT;        -- JSON：启用的告警渠道及参数
    ALTER TABLE monitors ADD COLUMN IF NOT EXISTS status_public BOOLEAN NOT NULL DEFAULT false;  -- 是否上公开状态页
    ALTER TABLE monitors ADD COLUMN IF NOT EXISTS last_alert_at BIGINT; -- 上次告警时间戳（升级告警去重用）
    ALTER TABLE monitors ADD COLUMN IF NOT EXISTS alert_count INTEGER NOT NULL DEFAULT 0;        -- 连续告警次数
    ALTER TABLE monitors ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0; -- 连续失败次数（降误报：Free 需连续 2 次才告警）
    ALTER TABLE monitors ADD COLUMN IF NOT EXISTS last_success_at BIGINT; -- Heartbeat 最后成功上报时间

    -- ===== 用户扩展：公开状态页 =====
    ALTER TABLE users ADD COLUMN IF NOT EXISTS public_slug TEXT;            -- 公开状态页 slug（唯一）
    ALTER TABLE users ADD COLUMN IF NOT EXISTS status_page_enabled BOOLEAN NOT NULL DEFAULT false;

    CREATE INDEX IF NOT EXISTS idx_users_public_slug ON users(public_slug);

    -- ===== 用户扩展：账号安全 + 超级管理员（G-SEC / G-ADMIN）=====
    -- email_verified：注册后需验证邮箱才视为可信账号
    -- verify_token / verify_expires：邮箱验证令牌（一次性）
    -- role：'user' | 'admin'（超级管理员，可进 /admin 后台）
    -- twofa_secret：预留 TOTP 第二因子密钥（当前未启用，列已留好）
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_token TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_expires BIGINT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS twofa_secret TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT;
    -- pending_email：改邮箱时暂存待确认的新邮箱（confirm 后写入 email 并置 verified）
    ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_email TEXT;
    -- alert_channels：账户级告警渠道凭据（JSON：{slack:{url},telegram:{botToken,chatId},...}）
    -- 凭据配一次、每个监控只勾选开关（P0-5 Plan A，2026-09-14）
    ALTER TABLE users ADD COLUMN IF NOT EXISTS alert_channels TEXT;
    -- OAuth 用户（Google/GitHub 注册）password_hash 存 NULL，须放开建表时的 NOT NULL（幂等，可重复执行）
    ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

    -- ===== 客户反馈（G-FEEDBACK）=====
    -- 页面内反馈组件入库 + 邮件通知管理员；status: new | seen | done
    CREATE TABLE IF NOT EXISTS feedback (
      id          TEXT PRIMARY KEY,
      user_id     TEXT,
      email       TEXT,
      message     TEXT NOT NULL,
      page        TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      status      TEXT NOT NULL DEFAULT 'new'
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback(created_at DESC);

    -- ===== G7 状态页增强：自定义域名 / 白标 / 私有 / 订阅者 =====
    -- status_custom_domain：用户绑定的自定义域名（CNAME + 证书由运维侧配置，代码按 Host 解析）
    -- status_white_label：去品牌（隐藏 "Powered by Pingory"）
    -- status_password_hash：私有状态页访问密码（scrypt）
    ALTER TABLE users ADD COLUMN IF NOT EXISTS status_custom_domain TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS status_white_label BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS status_password_hash TEXT;
    -- status_page_title：公开状态页标题（自定义展示名）
    -- 🔴 状态页标题**不得回退到 email** —— 那会把用户邮箱直接印在公开页面上（P1-5 修复）
    -- 回退链：status_page_title → name → 前端通用文案（Service Status）
    ALTER TABLE users ADD COLUMN IF NOT EXISTS status_page_title TEXT;

    CREATE TABLE IF NOT EXISTS status_subscribers (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      email       TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id, email)
    );
    CREATE INDEX IF NOT EXISTS idx_status_subscribers_user ON status_subscribers(user_id);

    -- ===== G8 维护窗口：计划性停机期间不误报告警 =====
    -- monitor_ids：JSON 数组（指定监控）或 'all'（该用户全部）
    CREATE TABLE IF NOT EXISTS maintenance_windows (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      monitor_ids TEXT,
      title       TEXT,
      start_at    BIGINT NOT NULL,
      end_at      BIGINT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_mw_user ON maintenance_windows(user_id);

    -- ===== G9 团队席位 + Account API =====
    -- api_key：Account API 鉴权（Bearer）
    -- team_id / team_role：团队归属（owner | member）
    ALTER TABLE users ADD COLUMN IF NOT EXISTS api_key TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS team_id TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS team_role TEXT NOT NULL DEFAULT 'owner';

    -- ===== 超级管理员控制台增强（P0-1）：封禁 / 配额覆盖 / 最后登录 =====
    -- banned：封禁后拒绝登录
    -- monitor_limit：覆盖套餐默认监控数（NULL = 用套餐默认）
    -- last_login：最后成功登录时间戳（毫秒）
    ALTER TABLE users ADD COLUMN IF NOT EXISTS banned BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS monitor_limit INTEGER;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login BIGINT;

    CREATE TABLE IF NOT EXISTS teams (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_users_api_key ON users(api_key);
    CREATE INDEX IF NOT EXISTS idx_users_team_id ON users(team_id);

    -- 监控归属团队（团队共享可见）
    ALTER TABLE monitors ADD COLUMN IF NOT EXISTS team_id TEXT;
    CREATE INDEX IF NOT EXISTS idx_monitors_team_id ON monitors(team_id);

    -- ===== 推荐码系统（替代 MSP 代理模式：更轻量，10% 提成）=====
    -- referral_code：每个用户唯一，用于生成推广链接（?ref=CODE）
    -- referred_by：指向推荐人用户 id（无则为 NULL），构成推荐关系
    ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by TEXT;

    CREATE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code);
    CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users(referred_by);

    -- 推荐记录：被推荐人付费转化后，给推荐人记一笔 10% 提成（status: pending -> paid）
    CREATE TABLE IF NOT EXISTS referrals (
      id          TEXT PRIMARY KEY,
      referrer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      referred_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status      TEXT NOT NULL DEFAULT 'pending',   -- pending（待付费）| paid（已发提成）
      commission  NUMERIC NOT NULL DEFAULT 0,          -- 提成金额（货币最小单位，如分）
      currency    TEXT NOT NULL DEFAULT 'USD',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (referred_id)                              -- 同一被推荐人只计一次提成
    );
    CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id);

    -- ===== 会话存储（connect-pg-simple：多实例共享登录态，避免 Fly 双机 session 不共享）=====
    CREATE TABLE IF NOT EXISTS "session" (
      "sid"    varchar NOT NULL COLLATE "default" PRIMARY KEY,
      "sess"   json NOT NULL,
      "expire" timestamp(6) NOT NULL
    );
    CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
    -- 兼容已存在（缺主键）的表：幂等补主键（ON CONFLICT 写入需要 sid 唯一）
    DO $$ BEGIN
      ALTER TABLE "session" ADD PRIMARY KEY ("sid");
    EXCEPTION WHEN duplicate_table THEN NULL; WHEN others THEN NULL; END $$;

    -- ===== 每次检查的明细（G6 趋势图 / 响应时间历史）=====
    CREATE TABLE IF NOT EXISTS monitor_checks (
      id            BIGSERIAL PRIMARY KEY,
      monitor_id   TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
      ts           BIGINT NOT NULL,        -- 检查时间戳（毫秒）
      status       TEXT NOT NULL,          -- up / down
      response_time INTEGER,               -- 响应时间（ms），down 时为 NULL
      region       TEXT,                   -- 探针区域
      error        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_monitor_checks_monitor_ts ON monitor_checks(monitor_id, ts DESC);
    -- 数据保留清理（P2-⑧）需要按 ts 单独筛过期行：上面那条索引前导列是 monitor_id，用不上
    CREATE INDEX IF NOT EXISTS idx_monitor_checks_ts ON monitor_checks(ts);

    -- ===== 归一化账单事件账本（方案C：provider-agnostic，不依赖具体收款方）=====
    -- 设计要点：每条支付/订阅事件都归一化写入此表，provider 字段区分 paddle / creem / 未来渠道。
    -- owner 收入/增长分析只读此表，与具体收款方完全解耦——换收款方无需改分析逻辑。
    -- 幂等：同一 (provider, provider_event_id) 只记一次，webhook 重放安全（ON CONFLICT DO NOTHING）。
    CREATE TABLE IF NOT EXISTS billing_events (
      id                TEXT PRIMARY KEY,
      user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider         TEXT NOT NULL,                  -- paddle | creem | ...
      event_type       TEXT NOT NULL,                  -- subscription_active | subscription_canceled | payment | refund | ...
      plan             TEXT,                           -- starter | pro | null
      billing_cycle    TEXT NOT NULL DEFAULT 'monthly',-- monthly | annual
      amount_cents     NUMERIC NOT NULL DEFAULT 0,      -- 货币最小单位（如分）
      currency         TEXT NOT NULL DEFAULT 'USD',
      provider_event_id TEXT,                          -- 收款方原始事件 id（幂等去重键；手动补录为 NULL）
      ts               TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_billing_events_ts ON billing_events(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_billing_events_user ON billing_events(user_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_events_provider_event ON billing_events(provider, provider_event_id);

    -- ===== 简单页面分析（来源国家 / 停留时长） =====
    -- 无 cookie，用 sessionStorage 生成一次性 session id；只记当日聚合，不写个人轨迹。
    CREATE TABLE IF NOT EXISTS page_sessions (
      id                TEXT PRIMARY KEY,
      country           TEXT,                       -- CF-IPCountry 等双字母国家码
      user_id           TEXT REFERENCES users(id) ON DELETE SET NULL,
      started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      duration_seconds  INTEGER NOT NULL DEFAULT 0,
      page_count        INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_page_sessions_started_at ON page_sessions(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_page_sessions_last_seen ON page_sessions(last_seen_at DESC);

    -- ===== 用户行为事件（admin 判断用户是否真正在使用 SaaS）=====
    CREATE TABLE IF NOT EXISTS user_events (
      id            TEXT PRIMARY KEY,
      user_id       TEXT REFERENCES users(id) ON DELETE CASCADE,
      event_type    TEXT NOT NULL,
      metadata      JSON,
      ip            TEXT,
      user_agent    TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_user_events_user_id ON user_events(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_events_type ON user_events(event_type);
    CREATE INDEX IF NOT EXISTS idx_user_events_created_at ON user_events(created_at DESC);

    -- ===== 告警邮件发送配额（P1-12）=====
    -- 背景：SMTP 用 Resend 免费档 = 100 封/天。一次事故（监控长时间宕机 × 多订阅者）
    -- 即可打爆额度；额度耗尽后 Resend 拒发，告警会静默丢失。
    -- 双实例共享计数 → 必须落库（内存计数在多实例下不可靠）；按 UTC 日期分桶，跨天自动归零。
    -- scope：'global'（全站总闸）或 'acct:<userId>'（单账号闸，防单个账号吃光全局额度）
    CREATE TABLE IF NOT EXISTS email_budget (
      scope       TEXT NOT NULL,
      day         DATE NOT NULL,
      used        INTEGER NOT NULL DEFAULT 0,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (scope, day)
    );

    -- ===== 轮询 leader 租约（P1-12）=====
    -- 背景：Fly 双实例都会执行 startPolling()，而并发锁 inFlight 是内存级 → 两台机器
    -- 各自检查、各自派发告警 ⇒ 每封告警发两份（且内存级 warning 冷却在双实例下失效）。
    -- 方案：DB 租约，仅持有租约的实例跑轮询；leader 挂掉后租约到期，另一实例接管。
    CREATE TABLE IF NOT EXISTS leader_lease (
      name        TEXT PRIMARY KEY,
      holder      TEXT,
      expires_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
`;

// 迁移期一次性数据迁移：孤儿监控清理。
// 原先这条写在 DDL 里 ⇒ **每次进程启动**都执行一次（`NOT IN (子查询)` 在大表上是 O(n×m)）。
// 移到迁移路径后只在版本升级时执行一次；此后由 ON DELETE CASCADE 外键保证不再产生孤儿。
const ORPHAN_MONITORS_SQL =
  'DELETE FROM monitors WHERE user_id IS NOT NULL AND user_id NOT IN (SELECT id FROM users)';

// monitors.user_id 补外键级联（历史是裸列，删用户后监控会变孤儿 → 后台显示「匿名」）。
// 幂等 + 独立 try/catch：约束加不上也不能拖垮启动（迁移已先做孤儿清理，因此此处必然可加）。
const MONITORS_FK_SQL = `
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'monitors_user_id_fkey') THEN
      ALTER TABLE monitors ADD CONSTRAINT monitors_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
    END IF;
  END $$;
`;

async function readSchemaVersion(client) {
  const { rows } = await client.query('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations');
  return Number(rows[0] && rows[0].v) || 0;
}

// 抢迁移锁。用 pg_try_advisory_lock 轮询而不是阻塞式 pg_advisory_lock：
// 前者每条语句都是瞬时的，不会撞上连接上的 statement_timeout（15s）；
// 后者在另一实例长时间持锁时会被 statement_timeout 打断成报错。
// ⚠️ advisory lock 是**会话级**的，因此调用方必须全程使用同一个 client（见 initDbOnce）。
async function acquireMigrationLock(client) {
  for (let waited = 0; waited <= MIGRATION_LOCK_WAIT_MS; waited += 1000) {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [MIGRATION_LOCK_KEY]);
    if (rows[0] && rows[0].ok) return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

async function runMigration(client) {
  const locked = await acquireMigrationLock(client);
  if (!locked) throw new Error('等待迁移锁超时（另一实例可能正在迁移）');
  try {
    // 拿到锁后再读一次版本：另一台实例可能刚好已经迁移完成
    if (await readSchemaVersion(client) >= SCHEMA_VERSION) {
      console.log('[db] 另一实例已完成迁移，本实例跳过 DDL');
      return;
    }

    await client.query(SCHEMA_DDL);

    try {
      const r = await client.query(ORPHAN_MONITORS_SQL);
      if (r.rowCount) console.log(`[db] 孤儿监控清理：删除 ${r.rowCount} 行`);
    } catch (e) {
      console.warn('[db] 孤儿监控清理跳过：', e.message);
    }

    try {
      await client.query(MONITORS_FK_SQL);
    } catch (e) {
      console.warn('[db] monitors.user_id 外键添加跳过：', e.message);
    }

    await client.query('INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING', [SCHEMA_VERSION]);
    console.log(`[db] 迁移完成 → v${SCHEMA_VERSION}`);
  } finally {
    // 归还连接前必须解锁，否则这条会话会一直持锁（连接被复用时就危险了）
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
  }
}

async function initDbOnce() {
  // 必须独占一个连接：advisory lock 是会话级的，用 pool.query 可能拿到不同连接
  // ⚠️ getPool() 是 async 的，这里必须 await 两次（返回的是 Promise<Pool>，漏 await 会得到
  //    "getPool(...).connect is not a function" ⇒ 启动失败重试整轮 ⇒ 生产表现为启动死循环）
  const pool = await getPool();
  const client = await pool.connect();
  let ok = false;
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    INTEGER PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    const current = await readSchemaVersion(client);
    if (current >= SCHEMA_VERSION) {
      console.log(`[db] 表结构已是最新（v${current}），跳过 DDL`);
    } else {
      await runMigration(client);
    }
    ok = true;
  } finally {
    client.release();
    if (ok) console.log('[db] 表结构就绪'); // 这条日志被排障/监控依赖，成功时必须出现
  }
}

// 带退避重试的初始化入口（唯一对外导出的那个）。签名与行为对外不变：
// 成功即 resolve，重试全部用尽才 reject（由 server.js 的启动循环接管继续重试）。
async function initDb() {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await initDbOnce();
      if (attempt > 1) console.log(`[db] 表结构初始化在第 ${attempt} 次尝试成功`);
      return;
    } catch (e) {
      const waitMs = INIT_RETRY_DELAYS_MS[attempt - 1];
      if (waitMs === undefined) {
        console.error(`[db] 初始化连续失败 ${attempt} 次，交回启动层继续重试：`, e && e.message);
        throw e;
      }
      console.warn(`[db] 初始化失败（第 ${attempt} 次）：${e && e.message}；${waitMs / 1000}s 后重试`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

export { getPool, initDb };
