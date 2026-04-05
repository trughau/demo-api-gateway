'use strict';

const { NodeSDK } = require('@opentelemetry/sdk-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { Resource } = require('@opentelemetry/resources');
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');
const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
const { ExpressInstrumentation } = require('@opentelemetry/instrumentation-express');
const { GrpcInstrumentation } = require('@opentelemetry/instrumentation-grpc');
const { SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-node');

/**
 * Khởi tạo OpenTelemetry SDK với Jaeger exporter
 * @param {string} serviceName - Tên service (vd: 'api-gateway', 'user-service')
 */
function initTracing(serviceName) {
  const jaegerEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';

  const exporter = new OTLPTraceExporter({
    url: `${jaegerEndpoint}/v1/traces`,
  });

  const sdk = new NodeSDK({
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
      [SemanticResourceAttributes.SERVICE_VERSION]: '1.0.0',
      'deployment.environment': process.env.NODE_ENV || 'development',
    }),
    spanProcessor: new SimpleSpanProcessor(exporter),
    instrumentations: [
      new HttpInstrumentation({
        // Thêm custom attributes vào HTTP spans
        requestHook: (span, request) => {
          span.setAttribute('http.request.body.size', request.headers['content-length'] || 0);
        },
        responseHook: (span, response) => {
          span.setAttribute('http.response.body.size', response.headers['content-length'] || 0);
        },
      }),
      new ExpressInstrumentation({
        // Ghi lại tên route handler
        requestHook: (span, info) => {
          span.setAttribute('express.route.full', info.route);
        },
      }),
      new GrpcInstrumentation(),
    ],
  });

  sdk.start();

  console.log(`OpenTelemetry initialized for service: "${serviceName}"`);

  // Graceful shutdown
  process.on('SIGTERM', () => {
    sdk.shutdown()
      .then(() => console.log('[Tracing] SDK shut down successfully'))
      .catch((error) => console.error('[Tracing] Error shutting down SDK', error))
      .finally(() => process.exit(0));
  });

  return sdk;
}

module.exports = { initTracing };