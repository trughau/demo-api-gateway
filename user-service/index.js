'use strict';

require('../tracing').initTracing('user-service');

const express = require('express');
const { trace, SpanStatusCode } = require('@opentelemetry/api');

const app = express();
app.use(express.json());

const tracer = trace.getTracer('user-service');

// ─────────────────────────────────────────
// Mock Database (In-Memory)
// ─────────────────────────────────────────
const USERS = new Map([
  ['user-001', { userId: 'user-001', name: 'Nguyễn Văn An', email: 'an.nguyen@gmail.com', tier: 'gold' }],
  ['user-002', { userId: 'user-002', name: 'Trần Thị Bình', email: 'binh.tran@yahoo.com', tier: 'silver' }],
  ['user-003', { userId: 'user-003', name: 'Lê Minh Châu', email: 'chau.le@outlook.com', tier: 'platinum' }],
]);

// ─────────────────────────────────────────
// CHUẨN HÓA: Auth Middleware Factory
// Tạo ra một Span riêng cho việc Auth để show trên Jaeger
// ─────────────────────────────────────────
const authMiddleware = (spanName) => {
  return (req, res, next) => {
    const span = tracer.startSpan(spanName || 'user.auth_check');
    const token = req.headers['authorization'];

    if (!token || token !== 'Bearer secret-token') {
      span.setAttribute('auth.success', false);
      span.setStatus({ 
        code: SpanStatusCode.ERROR, 
        message: 'Unauthorized: Invalid Token' 
      });
      span.end();
      // Trả về lỗi 401 ngay lập tức, không cho vào Logic nghiệp vụ
      return res.status(401).json({ error: 'Unauthorized at User Service' });
    }

    span.setAttribute('auth.success', true);
    span.end(); // Kết thúc span Auth thành công
    next();     // Cho phép đi tiếp vào route chính
  };
};

// ─────────────────────────────────────────
// Routes
// ─────────────────────────────────────────

/**
 * GET /users - Lấy danh sách users
 */
app.get('/users', authMiddleware('user.listUsers.auth'), (req, res) => {
  const span = tracer.startSpan('user.listUsers');
  span.setAttribute('query.tier', req.query.tier || 'all');

  // Giả lập DB Latency
  setTimeout(() => {
    let users = Array.from(USERS.values());
    if (req.query.tier) {
      users = users.filter(u => u.tier === req.query.tier);
    }

    span.setAttribute('result.count', users.length);
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();

    res.json({ users, total: users.length });
  }, 20);
});

/**
 * GET /users/:userId - Lấy thông tin chi tiết
 */
app.get('/users/:userId', authMiddleware('user.getUser.auth'), (req, res) => {
  const { userId } = req.params;
  const span = tracer.startSpan('user.getUser');
  span.setAttribute('user.id', userId);

  setTimeout(() => {
    const user = USERS.get(userId);
    if (!user) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'User not found' });
      span.end();
      return res.status(404).json({ error: `User ${userId} not found` });
    }

    span.setAttributes({ 'user.name': user.name, 'user.tier': user.tier });
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();

    res.json(user);
  }, 15);
});

/**
 * GET /users/:userId/validate - Validate cho Order Service
 */
app.get('/users/:userId/validate', authMiddleware('user.validate.auth'), (req, res) => {
  const { userId } = req.params;
  const span = tracer.startSpan('user.validateUser');

  setTimeout(() => {
    const user = USERS.get(userId);
    const isValid = !!user;

    span.setAttributes({
      'validation.result': isValid,
      'user.tier': user?.tier || 'none'
    });
    
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();

    res.json({
      valid: isValid,
      userId,
      tier: user?.tier || null,
      name: user?.name || null,
    });
  }, 10);
});

// ─────────────────────────────────────────
// Start Server
// ─────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`User Service is running on port ${PORT}`);
  console.log(`Protocol: REST/HTTP`);
});