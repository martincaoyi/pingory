// 多区域探针 Worker（G3）
// 独立部署的轻量 HTTP 服务：只执行本地检查，不连库、不调度、不告警。
// 主服务在 PROBE_REGIONS 配置 baseUrl 后，会 POST /probe 把某次检查委托给本 worker。
//
// 部署：与主服务同一份代码，换 CMD 为 `node src/worker.js`，通过环境变量区分：
//   PROBE_REGION_NAME  本节点区域名（默认取 hostname）
//   PROBE_PORT         监听端口（默认 3100）
//   PROBE_SECRET       与主服务一致的共享密钥（可选；两端都设才启用校验）

import express from 'express';
import os from 'node:os';
import { runLocalCheck } from './monitors.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

const PROBE_SECRET = process.env.PROBE_SECRET || '';
const REGION = process.env.PROBE_REGION_NAME || os.hostname();

// 健康检查（供编排平台探测存活）
app.get('/health', (_req, res) => res.json({ ok: true, region: REGION, ts: Date.now() }));

// 主服务委托的探测端点
app.post('/probe', async (req, res) => {
  if (PROBE_SECRET && req.get('x-probe-secret') !== PROBE_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const { monitor } = req.body || {};
  if (!monitor || !monitor.type) {
    return res.status(400).json({ error: 'invalid monitor payload' });
  }
  const start = Date.now();
  try {
    const r = await runLocalCheck(monitor);
    const responseTime =
      r.responseTime != null
        ? r.responseTime
        : monitor.type === 'heartbeat'
          ? null
          : Date.now() - start;
    res.json({
      status: r.status,
      error: r.error || null,
      responseTime,
      warn: r.warn || null,
      region: REGION,
    });
  } catch (e) {
    res.json({ status: 'down', error: e.message, responseTime: Date.now() - start, region: REGION });
  }
});

const PORT = process.env.PROBE_PORT || 3100;
app.listen(PORT, () => {
  console.log(`[probe-worker] region=${REGION} listening on :${PORT} (auth=${PROBE_SECRET ? 'on' : 'off'})`);
});
