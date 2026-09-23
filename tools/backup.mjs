// P2-4 逻辑备份（2026-09-23）—— Supabase 免费档无 PITR，且保留策略会物理删
// monitor_checks 旧数据，误删/坏迁移时恢复手段弱。本脚本把关键表导出为
// gzip 压缩的 JSON 快照，作为最低成本的 DR 兜底。
//
// 用法（在项目根目录）：
//   node tools/backup.mjs
// 读取 .env 的 DATABASE_URL（Session Pooler 串，与 src/db.js 同一加载与 SSL 规则）。
// 输出：backups/backup-<时间戳>.json.gz
//
// 调度建议（任选其一，均可白嫖）：
//   1) Windows 任务计划 / Linux cron：每天跑一次 node tools/backup.mjs
//   2) GitHub Actions cron（私有仓库分钟数有限，建议每周一次）调本脚本
// 备份文件建议定期拷出本机（网盘/移动盘），本机盘坏 = 备份一起没。
import { mkdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { getPool } from '../src/db.js'; // 复用连接配置（dotenv + SSL 规则与线上一致）

const DAY = 24 * 60 * 60 * 1000;
// 只备「丢了会疼」的表；page_sessions/user_events（埋点分析）、
// leader_lease/schema_migrations（运行时状态）、email_budget 不备。
const TABLES = [
  ['users', 'SELECT * FROM users ORDER BY id', []],
  ['monitors', 'SELECT * FROM monitors ORDER BY id', []],
  ['monitor_events', 'SELECT * FROM monitor_events ORDER BY id', []],
  ['monitor_checks', 'SELECT * FROM monitor_checks WHERE ts >= $1 ORDER BY ts', [Date.now() - 35 * DAY]],
  ['feedback', 'SELECT * FROM feedback ORDER BY id', []],
  ['status_subscribers', 'SELECT * FROM status_subscribers ORDER BY id', []],
  ['maintenance_windows', 'SELECT * FROM maintenance_windows ORDER BY id', []],
  ['teams', 'SELECT * FROM teams ORDER BY id', []],
  ['referrals', 'SELECT * FROM referrals ORDER BY id', []],
  ['billing_events', 'SELECT * FROM billing_events ORDER BY id', []],
];

const pool = await getPool();
const dump = { generatedAt: new Date().toISOString(), tables: {} };
let totalRows = 0;
let failed = false;
try {
  for (const [name, sql, params] of TABLES) {
    try {
      const { rows } = await pool.query(sql, params);
      dump.tables[name] = rows;
      totalRows += rows.length;
      console.log(`[backup] ${name}: ${rows.length} 行`);
    } catch (e) {
      failed = true;
      console.error(`[backup] ${name} 失败: ${e.message}`);
    }
  }
} finally {
  await pool.end?.().catch(() => {});
}
if (totalRows === 0) {
  console.error('[backup] 0 行 —— 连接或权限有问题，中止（不写空备份）');
  process.exit(1);
}
const gz = gzipSync(JSON.stringify(dump));
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const dir = path.resolve(process.cwd(), 'backups');
mkdirSync(dir, { recursive: true });
const file = path.join(dir, `backup-${stamp}.json.gz`);
writeFileSync(file, gz);
console.log(`[backup] 完成 → ${file}（${(gz.length / 1024).toFixed(1)} KB，共 ${totalRows} 行）`);
process.exit(failed ? 1 : 0);
