FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY index.js ./
ENV PORT=8000 DB_PATH=/app/data.db
EXPOSE 8000
CMD ["node", "index.js"]
