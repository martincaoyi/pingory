// 换库（Supabase）后重建公开 demo 状态页：
//   1. 取超级管理员 id（role='admin'）
//   2. 将其 public_slug 设为 'demo'、开启状态页
//   3. 幂等插入 10 个公开监控（固定 id，重跑不重复）
//
// 用法（本地执行，连接串走环境变量，不落盘）：
//   DATABASE_URL="postgresql://postgres.<ref>:<pw>@aws-?-<region>.pooler.supabase.com:5432/postgres" \
//   node tools/seed-demo.cjs
//   连接串不要带 ?sslmode=require（pg v8 会当 verify-full 覆盖 rejectUnauthorized:false 致崩）
//
// 注意：必须用 Session Pooler（端口 5432，host 从面板原样复制，不要自己拼），
// 不要用 Direct connection（免费档只解析 IPv6）/ Transaction Pooler（6543，不支持预处理语句）。

const { Client } = require('pg');

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('缺少 DATABASE_URL 环境变量');
  process.exit(1);
}

// 10 个 demo 监控（与营销存档一致）。固定 id 保证幂等。
const DEMOS = [
  { id: 'demo-pingory',    name: 'Pingory',          url: 'https://pingory.com' },
  { id: 'demo-postgres',   name: 'PostgreSQL',       url: 'https://www.postgresql.org' },
  { id: 'demo-github',     name: 'GitHub',           url: 'https://github.com' },
  { id: 'demo-cloudflare', name: 'Cloudflare',       url: 'https://www.cloudflare.com' },
  { id: 'demo-dockerhub',  name: 'Docker Hub',       url: 'https://hub.docker.com' },
  { id: 'demo-npm',        name: 'npm',              url: 'https://registry.npmjs.org/' },
  { id: 'demo-kernel',     name: 'Linux Kernel',     url: 'https://www.kernel.org' },
  { id: 'demo-wikipedia',  name: 'Wikipedia',        url: 'https://www.wikipedia.org' },
  { id: 'demo-hn',         name: 'Hacker News',      url: 'https://news.ycombinator.com' },
  { id: 'demo-letsencrypt',name: "Let's Encrypt",    url: 'https://letsencrypt.org' },
];

async function main() {
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const { rows } = await client.query(
    "SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1"
  );
  if (rows.length === 0) {
    console.error('未找到超级管理员（seedAdmin 未运行？）。请先让应用启动一次完成初始化。');
    await client.end();
    process.exit(1);
  }
  const adminId = rows[0].id;

  await client.query(
    "UPDATE users SET public_slug = 'demo', status_page_enabled = true, status_page_title = 'Pingory Status' WHERE id = $1",
    [adminId]
  );

  for (const d of DEMOS) {
    await client.query(
      `INSERT INTO monitors (id, url, name, interval, type, status_public, user_id, config, channels, created_at)
       VALUES ($1, $2, $3, 60, 'http', true, $4, '{}', '[]', now())
       ON CONFLICT (id) DO UPDATE SET url = EXCLUDED.url, name = EXCLUDED.name, status_public = true, user_id = EXCLUDED.user_id`,
      [d.id, d.url, d.name, adminId]
    );
    console.log('  ✓', d.name, d.url);
  }

  const { rows: cnt } = await client.query(
    'SELECT count(*)::int AS n FROM monitors WHERE user_id = $1',
    [adminId]
  );
  console.log(`demo 重建完成：admin=${adminId}，公开监控 ${cnt[0].n} 个`);
  await client.end();
}

main().catch((e) => {
  console.error('seed-demo 失败：', e.message);
  process.exit(1);
});
