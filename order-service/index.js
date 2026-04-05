'use strict';

require('../tracing').initTracing('order-service');

const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { trace, SpanStatusCode, context, propagation } = require('@opentelemetry/api');

const app = express();
app.use(express.json());

// ─────────────────────────────────────────
// Config & Mock DB
// ─────────────────────────────────────────
const CONFIG = {
  userService: process.env.USER_SERVICE_URL || 'http://localhost:3001',
  port: process.env.PORT || 3002
};

const ORDERS = new Map();
const tracer = trace.getTracer('order-service');

// ─────────────────────────────────────────
// HELPER: Axios có Tracing & Auth
// ─────────────────────────────────────────
function makeRequest(parentSpan, config, originalHeaders = {}) {
  const headers = {};
  // Inject Trace Context (TraceID, SpanID)
  propagation.inject(trace.setSpan(context.active(), parentSpan), headers);
  
  // Forward Token Authorization
  if (originalHeaders['authorization']) {
    headers['authorization'] = originalHeaders['authorization'];
  }

  return axios({ ...config, headers: { ...headers, ...config.headers } });
}

// ─────────────────────────────────────────
// CHUẨN HÓA: Auth Middleware
// ─────────────────────────────────────────
const authMiddleware = (req, res, next) => {
  const span = tracer.startSpan('order.auth_check');
  const token = req.headers['authorization'];

  if (!token || token !== 'Bearer secret-token') {
    span.setStatus({ code: SpanStatusCode.ERROR, message: 'Unauthorized at Order Service' });
    span.end();
    return res.status(401).json({ error: 'Order Service: Unauthorized' });
  }

  span.setAttribute('auth.success', true);
  span.end();
  next();
};

// ─────────────────────────────────────────
// Routes
// ─────────────────────────────────────────

/**
 * POST /orders - Tạo đơn hàng (Flow phức tạp)
 */
app.post('/orders', authMiddleware, async (req, res) => {
  const span = tracer.startSpan('order.createOrder');
  
  context.with(trace.setSpan(context.active(), span), async () => {
    try {
      const { userId, items, shippingAddress } = req.body;

      if (!userId || !items?.length) {
        throw new Error('Missing userId or items');
      }

      // --- Bước 1: Validate User (Gọi sang User Service) ---
      const validateSpan = tracer.startSpan('order.validateUser');
      const userRes = await makeRequest(validateSpan, {
        method: 'GET',
        url: `${CONFIG.userService}/users/${userId}/validate`
      }, req.headers);
      
      const userInfo = userRes.data;
      if (!userInfo.valid) {
        validateSpan.setStatus({ code: SpanStatusCode.ERROR });
        validateSpan.end();
        return res.status(400).json({ error: 'Invalid User' });
      }
      validateSpan.end();

      // --- Bước 2: Tính toán giá (Local Logic) ---
      const calcSpan = tracer.startSpan('order.calculateTotal');
      const subtotal = items.reduce((sum, i) => sum + (i.price * i.quantity), 0);
      const discountRate = { platinum: 0.15, gold: 0.1, silver: 0.05 }[userInfo.tier] || 0;
      const total = subtotal * (1 - discountRate);
      
      calcSpan.setAttributes({ 'order.subtotal': subtotal, 'user.tier': userInfo.tier });
      calcSpan.end();

      // --- Bước 3: Lưu đơn hàng ---
      const orderId = `ORD-${uuidv4().slice(0, 8).toUpperCase()}`;
      const order = {
        orderId, userId, 
        total, status: 'confirmed',
        createdAt: new Date().toISOString()
      };
      ORDERS.set(orderId, order);

      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
      res.status(201).json(order);

    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      span.end();
      res.status(err.response?.status || 500).json({ error: err.message });
    }
  });
});

/**
 * GET /orders - Lấy danh sách (Hỗ trợ filter)
 */
app.get('/orders', authMiddleware, (req, res) => {
  const span = tracer.startSpan('order.listOrders');
  const orders = Array.from(ORDERS.values());
  
  span.setAttribute('result.count', orders.length);
  span.end();
  res.json(orders);
});

// ─────────────────────────────────────────
// Start Server
// ─────────────────────────────────────────
app.listen(CONFIG.port, () => {
  console.log(`Order Service is running on port ${CONFIG.port}`);
  console.log(`Protocol: REST/HTTP`);
});