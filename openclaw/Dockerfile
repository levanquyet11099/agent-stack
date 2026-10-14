# OpenClaw gateway — phiên bản ghim cố định
FROM node:24-bookworm
ARG OPENCLAW_VERSION=2026.9.6
RUN npm install -g openclaw@${OPENCLAW_VERSION} \
 && openclaw plugins install @openclaw/matrix
WORKDIR /root
CMD ["openclaw", "gateway", "run"]
