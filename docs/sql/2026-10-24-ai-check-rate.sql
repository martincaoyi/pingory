-- D43 公开 AI Readability 检查端点限流表
-- 用途：GET /api/public/ai-check 的落库配额（多 isolate 下内存版限流形同虚设）
--
-- 语义：
--   · ip_hash      客户端 IP 的 SHA-256(ip + 盐)，绝不落原始 IP；全局桶固定为 '__global__'
--   · window_start 固定窗口起点：单 IP 用 10 分钟窗口，全局预算用 24 小时窗口
--   · hits         当前窗口累计次数（INSERT ... ON CONFLICT DO UPDATE 原子自增）
--
-- 清理：按 window_start 建索引，便于按时间批量删除过期窗口（本项目暂由运维侧手动执行，
--       不在代码里自动 DELETE，避免周期任务误删仍在使用的桶）。
-- 幂等：全部 IF NOT EXISTS，可重复执行。

CREATE TABLE IF NOT EXISTS ai_check_rate (
  ip_hash      TEXT        NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  hits         INTEGER     NOT NULL DEFAULT 0,
  PRIMARY KEY (ip_hash, window_start)
);

CREATE INDEX IF NOT EXISTS idx_ai_check_rate_window_start ON ai_check_rate (window_start);
