// Worker 定时任务（scheduled handler 实现）—— server.js 两个 setInterval 的迁移
//   · startPolling（5s 轮询）   → Cron Trigger `* * * * *`（免费档粒度 1 分钟）
//   · startRetention（1h 清理）  → 每小时第 0 分钟顺带执行（同 leader 租约，防重复）
//   · startMonthlyReportTimer    → 每月 1 号（UTC）用 leader_lease 月度标记行幂等去重
//
// 关键约束与设计：
//   1) leader_lease 抢租约（复用 monitors.js tryAcquireLease，'poll' 名）：防多 isolate 同时跑检查双发告警；
//   2) 每 tick 限量取到期监控（CRON_MAX_MONITORS_PER_TICK，默认 30）：免费档每次调用 50 subrequest
//      上限，超出的监控留在库里（last_checked 未更新 ⇒ 下一 tick 仍为 due，不丢失）；
//   3) 检查复用 monitors.js checkMonitor（含落库 + onCheckResult 告警判定，initAlerts 注入回调），
//      SQL 与告警状态机零改动；CRON_CHECK_CONCURRENCY 控制并发（默认 6）；
//   4) 月报跨 isolate 幂等：向 leader_lease 插入 'monthly-report-YYYYMM' 标记行（ON CONFLICT DO
//      NOTHING），插入成功者才执行——与 server.js 的内存 lastReportMonth 等价且多 isolate 安全。

import crypto from 'crypto';
import { getPool } from '../db.js';
import { listDueMonitors, checkMonitor, tryAcquireLease } from '../monitors.js';
import { initAlerts, generateMonthlyReport } from '../alerts.js';
import { pruneMonitorChecks } from '../retention.js';
import { planHasStats } from '../plans.js';

let alertsReady = false;

export async function runCron() {
  // 告警回调只需注入一次（isolate 级）
  if (!alertsReady) {
    initAlerts();
    alertsReady = true;
  }

  // 1) 抢租约：失败（他人持有/查询异常）直接退出本 tick
  const holder = 'cfw-' + crypto.randomUUID();
  let leader = false;
  try {
    leader = await tryAcquireLease(holder, 'poll');
  } catch (e) {
    console.error('[cron] 租约检查失败:', e.message);
  }
  if (!leader) return { ran: false, reason: 'not-leader' };

  const now = new Date();

  // 2) 数据保留清理：每小时第 0 分钟（对齐 startRetention 默认 1h 间隔；仅 leader 执行）
  if (now.getUTCMinutes() === 0) {
    try {
      await pruneMonitorChecks();
    } catch (e) {
      console.warn('[cron] 保留清理失败（下一轮重试）:', e && e.message);
    }
  }

  // 3) 扫描到期监控并检查（限量 + 限并发）
  const maxPerTick = Math.max(1, Number(process.env.CRON_MAX_MONITORS_PER_TICK || 30));
  const concurrency = Math.max(1, Number(process.env.CRON_CHECK_CONCURRENCY || 6));
  const due = await listDueMonitors(Date.now(), maxPerTick);

  let idx = 0;
  const workerCount = Math.min(concurrency, Math.max(due.length, 1));
  const workers = Array.from({ length: workerCount }, async () => {
    while (idx < due.length) {
      const m = due[idx++];
      try {
        await checkMonitor(m);
      } catch (e) {
        console.error('[cron] 检查失败', m.id, e.message);
      }
    }
  });
  await Promise.all(workers);

  // 4) 月报：每月 1 号（UTC）触发；DB 标记行保证整月只跑一次、跨 isolate 幂等
  let monthlyTriggered = false;
  if (now.getUTCDate() === 1) {
    const ym = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    try {
      const pool = await getPool();
      const { rows } = await pool.query(
        `INSERT INTO leader_lease (name, holder, expires_at)
         VALUES ($1, $2, now() + interval '40 days')
         ON CONFLICT (name) DO NOTHING
         RETURNING name`,
        ['monthly-report-' + ym, holder]
      );
      if (rows.length) {
        monthlyTriggered = true;
        const { rows: users } = await pool.query('SELECT id, plan FROM users');
        for (const u of users) {
          if (planHasStats(u.plan)) {
            try { await generateMonthlyReport(u.id); }
            catch (e) { console.error('[cron] 月度报告失败:', e.message); }
          }
        }
      }
    } catch (e) {
      console.error('[cron] 月报标记/执行失败:', e.message);
    }
  }

  return { ran: true, checked: due.length, monthlyTriggered };
}
