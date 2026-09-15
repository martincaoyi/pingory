# Pingory · 部署操作手册

> 本文档描述从源码到生产环境的完整部署步骤。
>
> **版本**：v1.1
> **最后更新**：2026-09-15
> **前置条件**：域名已购买（.com 推荐 Cloudflare）、主机已就位（Linux x64，或直接用 Docker）；数据库可自备，也可用 `docker-compose.yml` 内置的 Postgres

---

## 1. 环境清单

| 组件 | 推荐选择 | 费用 | 备注 |
|---|---|---|---|
| VPS | Hetzner CX22 / Oracle Free Tier / DigitalOcean $6 月 | ¥50–45/月 | Node.js 18+、2GB 内存足够 |
| 域名 | `.com`（Cloudflare Registrar $9.15/年） | ¥66/年 | 禁 .xyz/.top/.site/.online（Spamhaus 滥用榜） |
| 数据库 | Neon Free（Postgres） | 免费 | 5 分钟无查询自动休眠；本项目用 keepalive 保活 |
| CDN / DNS | Cloudflare（免费） | 免费 | 代理模式 + 强制 HTTPS |
| 邮件 | Paddle MoR 自带通知；告警邮件用阿里云 SMTP 或个人 Gmail | 免费 | 生产建议换企业邮箱 |
| 支付 | Paddle Sandbox → 切 Live | 费率 ~5%+5p | Merchant of Record，自动代扣 VAT |

---

## 2. VPS 初始化

```bash
# SSH 登录 VPS
ssh root@your-vps-ip

# 安装 Node.js 18+（以 Ubuntu 为例）
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt-get install -y nodejs git

# 安装 PM2（进程守护）
npm install -g pm2

# 创建非 root 用户（安全）
adduser app && usermod -aG sudo app
```

---

## 3. 代码部署

```bash
# 切换到 app 用户
su - app

# 克隆/上传项目（建议用 Git，或 rsync 本地 docs/）
mkdir -p ~/uptime-monitor
cd ~/uptime-monitor

# 从本地复制（推荐）
rsync -avz --exclude 'node_modules' --exclude '.env' \
  ./uptime-monitor/ \
  app@your-vps-ip:~/uptime-monitor/

# 安装依赖
npm ci --production

# 创建 .env（见第 4 节）
nano .env
```

---

## 4. 环境变量清单

创建 `~/uptime-monitor/.env`，内容参考 `.env.example`：

```bash
# ===== 服务本身（必填）=====
NODE_ENV=production
PORT=3000
SESSION_SECRET=<随机字符串，建议 64 字符>
STATUS_PAGE_SECRET=<另一个随机字符串，建议 64 字符>  # 私有状态页令牌密钥（G7）
DATABASE_URL=postgresql://neondb_owner:密码@ep-xxx.neon.tech/neondb?sslmode=require
APP_URL=https://yourdomain.com      # 邮件里的链接前缀（不填默认 https://pingory.com）

# ===== 邮件（SMTP）=====
SMTP_HOST=smtp.resend.com          # 任意 SMTP 服务商（生产用 Resend：smtp.resend.com）
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=resend
SMTP_PASS=<Resend API Key，re_ 开头>
SMTP_FROM="Pingory Alerts <alerts@yourdomain.com>"  # 必须是已验证域名下的地址
ALERT_TO_EMAIL=admin@yourdomain.com  # 客户反馈通知收件人（非告警收件人；告警发往监控归属账号的注册邮箱）

# ===== 支付 · Creem（推荐，当前生产通道）=====
PAYMENT_PROVIDER=creem             # ⚠️ 不设则默认 paddle —— 用 Creem 必须显式写这一行
CREEM_ENVIRONMENT=live             # test（测试）或 live（正式）
CREEM_API_KEY=creem_live_xxx       # Creem → Developers → API Keys
CREEM_WEBHOOK_SECRET=whsec_xxx     # Creem → Developers → Webhooks 创建后生成
CREEM_STARTER_PRODUCT=prod_xxx         # Starter 月付 $4/月
CREEM_STARTER_ANNUAL_PRODUCT=prod_xxx  # Starter 年付 $40/年
CREEM_PRO_PRODUCT=prod_xxx             # Pro 月付 $6/月
CREEM_PRO_ANNUAL_PRODUCT=prod_xxx      # Pro 年付 $60/年

# ===== 支付 · Paddle（备用通道；仅 PAYMENT_PROVIDER=paddle 时启用，不用可整段省略）=====
# PADDLE_ENVIRONMENT=live
# PADDLE_API_KEY=pdl_live_xxx            # Paddle Dashboard → Developer Tools → API Keys
# PADDLE_CLIENT_TOKEN=pk_live_xxx        # Paddle Dashboard → Developer Tools → Client Token
# PADDLE_WEBHOOK_SECRET=pdl_ntfset_xxx   # ⚠️ 含 pdl_ 前缀
# STARTER_PRICE_ID=pri_xxx               # Starter 月付
# PRO_PRICE_ID=pri_xxx                   # Pro 月付
# STARTER_ANNUAL_PRICE_ID=pri_xxx        # Starter 年付
# PRO_ANNUAL_PRICE_ID=pri_xxx            # Pro 年付

# ===== 超级管理员（可选）=====
ADMIN_EMAIL=admin@yourdomain.com   # 设置且账号不存在时，启动自动建 role=admin 超管
ADMIN_PASSWORD=<至少 8 位>

# ===== OAuth 社交登录（可选）=====
GITHUB_CLIENT_ID=xxx               # 回调 <APP_URL>/api/auth/oauth/github/callback
GITHUB_CLIENT_SECRET=xxx
GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com   # 回调 <APP_URL>/api/auth/oauth/google/callback
GOOGLE_CLIENT_SECRET=xxx

# ===== 多区域探针（G3，可选）=====
# PROBE_REGIONS=[{"name":"local","baseUrl":null},{"name":"us-east","baseUrl":"https://probe-us.example.com"}]
# PROBE_SECRET=<所有节点填同一值才启用 /probe 校验>
# —— 以下三项仅「部署 worker 节点」时用（node src/worker.js），主服务不读 ——
# PROBE_REGION_NAME=us-east        # 本节点区域名，需与 PROBE_REGIONS 里的 name 一致
# PROBE_PORT=3100                  # 探针服务监听端口（默认 3100）
```

**关键注意事项**：
- **`PAYMENT_PROVIDER` 必须显式写**：代码里默认值是 `paddle`（`server.js:431`），不写就会走 Paddle 分支
- `DATABASE_URL` 中 `sslmode=require`（生产建议 `verify-full`）
- `SESSION_SECRET` 每次生产环境必须不同（不要用 dev 的值）
- `.env` 绝对不要提交到 Git（已有 `.gitignore`）
- 支付变量**整段留空也能启动**（`/api/creem-config` 返回 inactive，页面不显示结账入口）——纯自用部署不需要配支付

---

## 5. Cloudflare DNS 配置

1. 登录 Cloudflare → 添加站点（你的域名）
2. 把 Nameserver 改到 Cloudflare（域 registrar 处修改）
3. 在 Cloudflare DNS 里加 A 记录：`your-app.yourdomain.com` → VPS IP
4. SSL/TLS 设为 **Full (strict)**
5. 启用 **Always Use HTTPS** 和 **Automatic HTTPS Rewrites**
6. 禁用 **Proxy** 仅对 `/api/paddle/webhook` 路径（避免 Cloudflare 5s 挑战拦截 webhook）

---

## 6. PM2 守护进程

```bash
cd ~/uptime-monitor
pm2 start server.js --name uptime-monitor
pm2 save
pm2 startup   # 按提示执行输出命令，实现开机自启
pm2 monit     # 查看日志
```

**常用命令**：
```bash
pm2 logs uptime-monitor          # 实时日志
pm2 restart uptime-monitor       # 重启（改代码后）
pm2 delete uptime-monitor        # 停止并删除
```

---

## 7. 支付 Webhook 生产配置

### 7.1 Creem（当前生产通道）

1. 登录 Creem → **Developers → Webhooks** → 新建 webhook
2. URL 填 `https://yourdomain.com/api/creem/webhook`
3. 订阅事件（代码实际处理这几个，`server.js:544-557`）：`subscription.active` / `subscription.trialing` / `subscription.paid`（这三类 → 升档）、`subscription.canceled` / `subscription.expired` / `subscription.paused`（→ 降回 free）、`refund.created`（仅记账）。**未列出的事件会被安全忽略**，可全选也可只勾这几项。
4. 复制 **Webhook secret**（`whsec_` 开头）填入 `.env` 的 `CREEM_WEBHOOK_SECRET`
5. 在控制台发一次测试事件，确认线上返回 200

### 7.2 Paddle（备用通道，仅在 `PAYMENT_PROVIDER=paddle` 时需要）

1. 登录 Paddle Dashboard → **Developer Tools → Notifications**
2. 点击 **Create destination**：
   - URL：`https://yourdomain.com/api/paddle/webhook`
   - Event types：勾选 `subscription.activated` / `subscription.canceled` / `subscription.updated` / `transaction.paid`
3. 创建后复制 **Webhook secret**（以 `pdl_ntfset_` 开头）填入 `.env`
4. 点 **Send test notification** 验证 200 响应

**⚠️ 生产验证要点**：
- 时间戳容差：Paddle 通道已放宽到 300 秒（防 Cloudflare/CDN 延迟）
- 若 webhook 返回非 200，支付商会重试；检查 `pm2 logs` 里 `[webhook]` / `[creem webhook]` 前缀的日志
- 切换通道只需改 `PAYMENT_PROVIDER`，两条通道代码并存、互不影响

---

## 8. 健康检查与监控

```bash
# 手动触发一次轮询验证
curl http://localhost:3000/api/monitors   # 需先登录获取 Cookie

# 查看 Neon 连接池
psql "$DATABASE_URL" -c "SELECT count(*) FROM monitors;"

# 测试邮件
curl -X POST http://localhost:3000/api/test-email   # （可选：在 server.js 加测试端点）
```

---

## 9. 故障排查速查

| 症状 | 排查点 |
|---|---|
| 注册/登录慢（>10s） | Neon 休眠：检查 `src/db.js:startKeepAlive()` 是否每 4 分钟发 `SELECT 1` |
| webhook 返回 400/401（验签失败） | Creem 通道：检查 `CREEM_WEBHOOK_SECRET`；Paddle 通道：检查 `PADDLE_WEBHOOK_SECRET` 是否含完整 `pdl_ntfset_` 前缀。日志里 `[creem webhook] 验签失败` 会打印收到的签名前 24 位与本地计算值，可直接比对 |
| 支付后 plan 没变 | 先看 `event_type` 是否在代码处理列表内（见第 7 节）；Creem 搜日志 `[creem webhook]`，Paddle 搜 `subscription.`；另检查 `PAYMENT_PROVIDER` 与实际收款通道是否一致 |
| 页面不显示结账入口 | `/api/creem-config`（或 `/api/paddle-config`）返回 `active:false` → 对应通道的环境变量未配齐 |
| 告警邮件收不到 | SMTP 配置：检查 `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS`；用 Resend 时 `SMTP_USER=resend`、`SMTP_PASS` = Resend API Key（`re_` 开头） |
| `Invalid Date` 前端显示 | Neon BIGINT → JS Number 转换：`rowToMonitor` 里 `lastChecked: Number(row.last_checked)` |
| 配额不生效 | 检查 `PLAN_LIMITS` 定义与 `users.plan` 字段是否一致 |
| 端口冲突 | 检查 `PORT` 环境变量；`lsof -i :3000` |

---

## 10. 备份与恢复

```bash
# 数据库备份（Neon 内置，控制台可下载）
# 或手动：
pg_dump "$DATABASE_URL" > backup-$(date +%Y%m%d).sql

# 代码备份（Git）
git add -A && git commit -m "checkpoint: $(date)"
```

---

## 11. 后续优化（上线后）

- [ ] 接入 Cloudflare Turnstile 反垃圾（替代 reCAPTCHA）
- [x] 加 `/status` 公开状态页（P1 G5 已完成）
- [x] 加健康检查端点 `/health`（已落地，供 Uptime Robot 监控本服务）
- [x] 多语言 i18n：英语 + 西/葡/德/法/日/韩（G10 已完成，前端语言包 public/i18n/*.json）
- [x] Slack / Webhook / Telegram / Discord / Teams / PagerDuty 告警渠道（P1 G4 已完成）
- [x] G7 状态页增强：自定义域名 / 白标 / 私有密码 / 订阅者（已完成）
- [x] G8 维护窗口：计划停机期间不误报告警（已完成）
- [x] G9 团队席位 + Account API（api_key 鉴权，已完成）

## 12. 容器化部署（Docker / Compose / Render / PM2）

```bash
# 一条命令起「数据库 + 主服务 + 两个示例探针节点」
docker compose up -d --build

# 仅主服务（需自备 DATABASE_URL）
docker build -t pingory . && docker run -d -p 3000:3000 --env-file .env pingory
```

- `docker-compose.yml` 含 3 类服务：`db`（内置 `postgres:16-alpine`，数据存 `pgdata` 卷）+ `app`（主服务）+ `probe-us` / `probe-eu`（多区域 worker，按需增删）。
- `app` 的 `DATABASE_URL` 默认指向内置 `db`（`depends_on: service_healthy` 保证库就绪后再启动）；若 `.env` 里显式设置了 `DATABASE_URL`（Neon / Supabase / 自建库），则优先用该值，此时 `db` 服务可整段删除。
- 多区域 worker 与主服务同镜像，CMD 换为 `node src/worker.js`，通过 `PROBE_REGION_NAME` 区分；`probe-*` 只做探测、不连库，因此**不需要** `DATABASE_URL`。
- 生产另可选 Render（`render.yaml`，`healthCheckPath: /health`）或传统 VPS+PM2（`ecosystem.config.cjs`）。
- 部署多区域需在 `.env` 配 `PROBE_REGIONS`（各节点 baseUrl）与一致的 `PROBE_SECRET`（可选鉴权）。

---

## 13. 自定义域名（G7）+ 部署辅助文件

### 13.1 自定义状态页域名
Pro 用户可在「状态页高级设置」填 `status.yourclient.com`，CNAME 指向本服务。
- **Fly.io**：`fly certs add status.yourclient.com`（自动签发证书），代码按 `Host` 解析（`getStatusPageByHost`）。
- **Cloudflare + VPS**：DNS 加 CNAME → VPS IP，Cloudflare 证书选 Full (strict)；或 Nginx + Let's Encrypt（见 `deploy/nginx.conf`）。
- 私有状态页：设置密码后，访问需先 `POST /api/status-page/unlock` 或 `/api/status/:slug/unlock` 获取 capability cookie。

### 13.2 部署辅助文件（本仓库 `deploy/`）
| 文件 | 用途 |
|---|---|
| `deploy/nginx.conf` | Nginx 反代 + HTTPS（Let's Encrypt）示例，含自定义域名 server 段 |
| `deploy/pingory.service` | systemd 单元，开机自启 + 崩溃重启（无 PM2/Docker 时） |

传统 VPS 无 Docker 部署：
```bash
sudo cp deploy/pingory.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now pingory
# 看日志
journalctl -u pingory -f
```

### 13.3 上线前最终核对（切 live 前）
1. `PAYMENT_PROVIDER=creem`，且 `CREEM_ENVIRONMENT=live`、`CREEM_API_KEY` / `CREEM_WEBHOOK_SECRET` 与 4 个 `CREEM_*_PRODUCT` 均为 live 值。（若走 Paddle 备用通道，则改为 `PAYMENT_PROVIDER=paddle` + `PADDLE_ENVIRONMENT=live` + live key。）
2. 支付后台的商家显示名 → "Pingory"。
3. 企业邮箱 SMTP（`SMTP_FROM` 为已验证域名下的地址），否则验证/反馈/告警邮件发不出。
4. `SESSION_SECRET` / `STATUS_PAGE_SECRET` 为生产随机值（不要沿用 dev）。
5. webhook 时间容差：Paddle 通道的验签容差已放宽到 300s（防 CDN 延迟）；若安全要求高可在 `server.js` 对应常量调回更小值（注意留出 CDN 延迟余量，过小会导致正常回调被拒）。
6. 存量用户上线前执行 `UPDATE users SET email_verified=true;` 一次性放行。
