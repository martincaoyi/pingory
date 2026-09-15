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
CMD ["node", "server.js"]
