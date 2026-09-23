# Uptime Monitor 主服务镜像
FROM node:18-alpine

WORKDIR /app

# 先装依赖（利用层缓存）
COPY package*.json ./
RUN npm ci --omit=dev

# 再拷源码
COPY . .

ENV NODE_ENV=production

# 默认启动主服务；多区域探针改 CMD 为 node src/worker.js
EXPOSE 3000
# --max-old-space-size（P2-⑦，2026-09-23）：此前不设 ⇒ V8 堆上限交给容器内存自动推断，
# 真触顶时是「被内核 OOM kill」（exit_code=137）而不是可控的 GC 压力/堆溢出报错，根因难查。
# 显式设为 384MB：配合 fly.toml 的 512MB，给非堆内存（Buffer / 网络缓冲 / 原生）留约 128MB。
CMD ["node", "--max-old-space-size=384", "server.js"]
