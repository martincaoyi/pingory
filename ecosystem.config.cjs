// PM2 进程守护配置（传统 VPS 部署）
// 启动：pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: 'uptime-monitor',
      script: 'server.js',
      instances: 1,
      autorestart: true,
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
    },
    // 多区域探针（按需启用：每个节点一台机器，PROBE_REGION_NAME 不同）
    // {
    //   name: 'probe-worker',
    //   script: 'src/worker.js',
    //   autorestart: true,
    //   env: {
    //     PROBE_REGION_NAME: 'us-east',
    //     PROBE_PORT: 3100,
    //   },
    // },
  ],
};
