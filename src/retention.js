// 数据保留策略（P2-⑧，2026-09-23）
//
// 背景：全仓此前**没有任何保留策略** —— 没有任何 DELETE / retention / 定时清理任务，
// 而 monitor_checks 是增长最快的表（Pro 档 30 秒检查 ⇒ 单监控 2880 行/天；免费档 5 分钟 ⇒ 288 行/天）。
// 表只会变大 ⇒ 趋势图查询变慢、VACUUM 压力上升、最终表现为接口超时（慢性病，最后变成急性）。
//
// 方案（与项目既有模式一致：session 表就是靠 connect-pg-simple 的定时 prune 保持有界的）：
//   · 定时（默认每小时）分批删除过期明细，保留期/批大小/轮次都可用 env 覆盖
//   · 分批删（每批走 `id IN (SELECT ... LIMIT n)`）⇒ 单条语句短小，不产生长事务/长锁，
//     也不会一次撞上 statement_timeout（15s）
//   · 只在 poll leader 上执行（复用同一把 DB 租约）⇒ 双机不重复劳动
//   · 启动后延迟首次执行，让服务先稳定下来
//
// 目前只覆盖 monitor_checks（增长最快的一张）。其它表（page_sessions / user_events /
// monitor_events）按同一模式往 TABLES 里加即可，但需先各自确认「查历史」的产品语义允许多久的保留期。

import { getPool } from './db.js';

const RETENTION_DAYS = Math.max(1, Number(process.env.RETENTION_CHECKS_DAYS || 30));
const BATCH_SIZE = Math.max(100, Number(process.env.RETENTION_BATCH_SIZE || 5000));
const MAX_BATCHES_PER_RUN = Math.max(1, Number(process.env.RETENTION_MAX_BATCHES || 20));
const RUN_INTERVAL_MS = Math.max(60 * 1000, Number(process.env.RETENTION_INTERVAL_MS || 60 * 60 * 1000));
const FIRST_RUN_DELAY_MS = Math.max(0, Number(process.env.RETENTION_FIRST_DELAY_MS || 5 * 60 * 1000));

// 清理一张按 BIGINT 毫秒时间戳（ts 列）分界的明细表。
// 返回实际删除行数；调用方只关心「是否出错」，行数用于日志。
export async function pruneByTs(table, tsColumn, cutoffMs, { batchSize = BATCH_SIZE, maxBatches = MAX_BATCHES_PER_RUN } = {}) {
  const pool = await getPool();
  let deleted = 0;
  for (let i = 0; i < maxBatches; i += 1) {
    // 先选主键再删：LIMIT 只作用于子查询里的选区，DELETE 因此只触及有限行数
    const { rowCount } = await pool.query(
      `DELETE FROM ${table}
        WHERE id IN (
          SELECT id FROM ${table}
           WHERE ${tsColumn} < $1
           ORDER BY ${tsColumn} ASC
           LIMIT $2
        )`,
      [cutoffMs, batchSize]
    );
    deleted += rowCount || 0;
    // 本批没删满 ⇒ 说明已无更多过期行，收工（正常情况下一次就到位）
    if (!rowCount || rowCount < batchSize) break;
  }
  return deleted;
}

export async function pruneMonitorChecks(nowMs = Date.now()) {
  const cutoff = nowMs - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const deleted = await pruneByTs('monitor_checks', 'ts', cutoff);
  if (deleted) {
    console.log(`[retention] monitor_checks 清理 ${deleted} 行（保留 ${RETENTION_DAYS} 天，早于 ${new Date(cutoff).toISOString()}）`);
  }
  return deleted;
}

// 启动定时清理。isLeaderFn 用于复用轮询的 leader 租约（仅 leader 执行，避免双机重复）。
export function startRetention(isLeaderFn = () => true) {
  const tick = async () => {
    if (!isLeaderFn()) return; // standby：不清理
    try {
      await pruneMonitorChecks();
    } catch (e) {
      // 清理失败不影响服务：下一轮再来（WARN 而不是抛错，避免拖垮进程）
      console.warn('[retention] 清理失败（下一轮重试）:', e && e.message);
    }
  };
  const first = setTimeout(tick, FIRST_RUN_DELAY_MS);
  const timer = setInterval(tick, RUN_INTERVAL_MS);
  if (first.unref) first.unref();
  if (timer.unref) timer.unref();
  console.log(`[retention] 已启动：monitor_checks 保留 ${RETENTION_DAYS} 天，每 ${RUN_INTERVAL_MS / 60000} 分钟清理一次`);
  return timer;
}
