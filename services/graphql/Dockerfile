# Build context là thư mục gốc để dùng đúng specs/schema.graphql đã duyệt
FROM node:22-slim
WORKDIR /app
COPY services/graphql/package*.json ./
RUN npm ci --omit=dev
COPY specs/schema.graphql services/graphql/index.js services/graphql/otel.js services/graphql/tracing.cjs ./
ENV PORT=8000
EXPOSE 8000
CMD ["node", "--require", "./tracing.cjs", "index.js"]
