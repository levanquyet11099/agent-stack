// Giống @opentelemetry/auto-instrumentations-node/register, thêm cấu hình cho GraphQL:
// bỏ span của field chỉ đọc thuộc tính (id, title...) để trace trên Jaeger dễ đọc,
// giữ span của resolver thật (gọi REST, DataLoader).
// Chạy: node --require ./tracing.cjs index.js
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations, getResourceDetectors } = require('@opentelemetry/auto-instrumentations-node');

const sdk = new NodeSDK({
  instrumentations: getNodeAutoInstrumentations({
    '@opentelemetry/instrumentation-graphql': { ignoreTrivialResolveSpans: true, mergeItems: true },
  }),
  resourceDetectors: getResourceDetectors(),
});
sdk.start();

const shutdown = () => sdk.shutdown().catch(() => {});
process.on('SIGTERM', shutdown);
process.once('beforeExit', shutdown);
