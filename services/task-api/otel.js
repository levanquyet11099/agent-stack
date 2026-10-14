// OpenTelemetry dùng chung: log JSON có trace id + helper tạo span thủ công.
// Auto-instrumentation (http, fetch, express, graphql) bật qua:
//   node --import @opentelemetry/auto-instrumentations-node/register index.js
import { SpanStatusCode, trace } from '@opentelemetry/api';

const SERVICE = process.env.OTEL_SERVICE_NAME ?? 'app';
export const tracer = trace.getTracer(SERVICE);

/** Log 1 dòng JSON, kèm otelTraceID/otelSpanID của span đang chạy (nếu có). */
export function log(levelname, message, extra = {}) {
  const ctx = trace.getActiveSpan()?.spanContext();
  console.log(JSON.stringify({
    asctime: new Date().toISOString(),
    levelname,
    name: SERVICE,
    message,
    otelTraceID: ctx?.traceId ?? '0',
    otelSpanID: ctx?.spanId ?? '0',
    ...extra,
  }));
}

const fail = (span, e) => {
  span.recordException(e);
  span.setStatus({ code: SpanStatusCode.ERROR, message: e.message });
};

/** Span thủ công cho đoạn async. Lỗi → span đỏ trên Jaeger, rồi ném tiếp. */
export function withSpan(name, attributes, fn) {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try { return await fn(span); } catch (e) { fail(span, e); throw e; } finally { span.end(); }
  });
}

/** Span thủ công cho đoạn đồng bộ (node:sqlite chạy sync). */
export function withSpanSync(name, attributes, fn) {
  return tracer.startActiveSpan(name, { attributes }, (span) => {
    try { return fn(span); } catch (e) { fail(span, e); throw e; } finally { span.end(); }
  });
}
