'use strict';

// Khởi tạo Tracing đầu tiên để capture toàn bộ lifecycle của request
require('../tracing').initTracing('api-gateway');

const express = require('express');
const axios = require('axios');
const path = require('path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const { trace, SpanStatusCode, context, propagation } = require('@opentelemetry/api');
const rateLimit = require("express-rate-limit");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────────────────────────
// 1. CẤU HÌNH CHIẾN LƯỢC (STRATEGIC CONFIG)
// ─────────────────────────────────────────────────────────────────
const CONFIG = {
  // GIẢ LẬP SERVICE DISCOVERY: Danh sách các instance của User Service
  userServices: [
    process.env.USER_SERVICE_URL || 'http://localhost:3001',
    process.env.USER_SERVICE_URL_2 || 'http://localhost:3011' 
  ],
  orderService:   process.env.ORDER_SERVICE_URL    || 'http://localhost:3002',
  productHost:    process.env.PRODUCT_SERVICE_HOST || 'localhost',
  productPort:    process.env.PRODUCT_SERVICE_PORT || '50051',
  cacheTTL:       60 * 1000 // 1 phút cho In-memory Cache
};

const tracer = trace.getTracer('api-gateway');

// ─────────────────────────────────────────────────────────────────
// 2. IN-MEMORY CACHE & LOAD BALANCING STATE
// ─────────────────────────────────────────────────────────────────
const apiCache = new Map(); // Lưu trữ: key -> { data, timestamp }
let userServerIndex = 0;    // Con trỏ phục vụ Round Robin

/**
 * Thuật toán Round Robin: Xoay vòng danh sách Server IP
 */
function getNextUserServer() {
  const server = CONFIG.userServices[userServerIndex];
  userServerIndex = (userServerIndex + 1) % CONFIG.userServices.length;
  console.log(`[LB] Điều hướng tới Instance: ${server}`);
  return server;
}

// ─────────────────────────────────────────────────────────────────
// 3. gRPC CLIENT SETUP (PROTOCOL TRANSLATION)
// ─────────────────────────────────────────────────────────────────
const PROTO_PATH = path.join(__dirname, '../product-service/product.proto');
const packageDef = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true, longs: String, enums: String, defaults: true, oneofs: true,
});
const productProto = grpc.loadPackageDefinition(packageDef).product;

function createProductClient() {
  return new productProto.ProductService(
    `${CONFIG.productHost}:${CONFIG.productPort}`,
    grpc.credentials.createInsecure()
  );
}

let productClient = createProductClient();

/**
 * Chuẩn hóa gRPC Call: Tích hợp Metadata (Token) + Tracing
 */
function grpcCall(method, request, token) {
  return new Promise((resolve, reject) => {
    const metadata = new grpc.Metadata();
    if (token) metadata.add('authorization', token);

    productClient[method](request, metadata, (err, response) => {
      if (err) {
        // Resilience: Nếu service chết, thử tạo lại client kết nối
        if (err.code === grpc.status.UNAVAILABLE) {
            console.error('[gRPC] Service Unavailable. Retrying connection...');
            productClient = createProductClient();
        }
        reject(err);
      } else {
        resolve(response);
      }
    });
  });
}

/**
 * Chuẩn hóa HTTP Request: Tự động Inject Trace ID vào Header
 */
function makeHttpRequest(parentSpan, config, clientHeaders = {}) {
  const headers = {};
  propagation.inject(trace.setSpan(context.active(), parentSpan), headers);
  
  if (clientHeaders['authorization']) {
    headers['authorization'] = clientHeaders['authorization'];
  }

  return axios({ ...config, headers: { ...headers, ...config.headers }, timeout: 5000 });
}

// ─────────────────────────────────────────────────────────────────
// 4. MIDDLEWARES (SECURITY & TRAFFIC CONTROL)
// ─────────────────────────────────────────────────────────────────

// Rate Limit: Ngăn chặn Spam (5 request mỗi 10 giây)
const limiter = rateLimit({
  windowMs: 10 * 1000,
  max: 10, 
  handler: (req, res) => {
    res.status(429).json({ error: "Too many requests. Please slow down.", traceId: req.traceId });
  }
});
app.use('/api', limiter);

// Tracing Middleware: Đẩy Trace ID vào Response Header để Frontend dễ Debug
app.use((req, res, next) => {
  const span = trace.getActiveSpan();
  if (span) res.setHeader('X-Trace-Id', span.spanContext().traceId);
  next();
});

// Gateway Auth (Security Trụ cột): Kiểm tra tại cửa ngõ trước khi vào sâu
const gatewayAuthMiddleware = (req, res, next) => {
  if (req.headers['x-auth-mode'] === 'gateway') {
    const span = tracer.startSpan('gateway.auth_check');
    const token = req.headers['authorization'];
    
    // Demo: Chỉ chấp nhận token cố định
    if (token !== 'Bearer secret-token') {
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'Invalid Gateway Token' });
      span.end();
      return res.status(401).json({ error: 'Gateway Auth Failed: Unauthorized access' });
    }
    span.end();
  }
  next();
};

// ─────────────────────────────────────────────────────────────────
// 5. ROUTES (ROUTING, CACHING, AGGREGATION)
// ─────────────────────────────────────────────────────────────────

// --- 5.1. USER PROXY (Minh họa: Round Robin Load Balancing) ---
app.get('/api/users', async (req, res) => {
  const targetServer = getNextUserServer(); // Chọn server 
  const span = tracer.startSpan('gateway.getUsers');
  
  context.with(trace.setSpan(context.active(), span), async () => {
    try {
      const response = await makeHttpRequest(span, {
        method: 'GET',
        url: `${targetServer}/users`,
        params: req.query
      }, req.headers);
      
      span.end();
      res.json(response.data);
    } catch (err) {
      handleUpstreamError(span, res, err, 'user-service');
    }
  });
});

// --- 5.2. PRODUCT PROXY (Minh họa: In-memory Caching & gRPC) ---
app.get('/api/products', async (req, res) => {
  // Tạo Cache Key dựa trên Query Params
  const cacheKey = `prod_${req.query.page || 1}_${req.query.pageSize || 10}`;
  const cached = apiCache.get(cacheKey);

  // Kiểm tra nếu dữ liệu còn hạn trong Cache
  if (cached && (Date.now() - cached.timestamp < CONFIG.cacheTTL)) {
    console.log(`[Cache] Trả về dữ liệu từ bộ nhớ cho key: ${cacheKey}`);
    return res.json(cached.data);
  }

  const span = tracer.startSpan('gateway.listProducts');
  context.with(trace.setSpan(context.active(), span), async () => {
    try {
      const token = req.headers['authorization'];
      const grpcResponse = await grpcCall('listProducts', {
        page: parseInt(req.query.page || '1'),
        pageSize: parseInt(req.query.pageSize || '10'),
      }, token);

      // Lưu kết quả vào Cache trước khi trả khách
      apiCache.set(cacheKey, { data: grpcResponse, timestamp: Date.now() });

      span.end();
      res.json(grpcResponse);
    } catch (err) {
      handleUpstreamError(span, res, err, 'product-service');
    }
  });
});

// --- 5.3. COMPOSITE CHECKOUT (Minh họa: Request Aggregation & Parallelism) ---
app.post('/api/checkout', gatewayAuthMiddleware, async (req, res) => {
  const span = tracer.startSpan('gateway.checkout.parallel');
  
  context.with(trace.setSpan(context.active(), span), async () => {
    try {
      const { userId, cartItems, shippingAddress, paymentMethod } = req.body;
      const token = req.headers['authorization'];
      const userServer = getNextUserServer(); // Áp dụng LB ngay cả trong flow phức tạp

      // GỌI SONG SONG (Parallel Calls): Tối ưu hóa thời gian chờ
      const [userRes, productChecks] = await Promise.all([
        // Nhánh 1: Lấy thông tin User qua REST
        makeHttpRequest(span, {
          method: 'GET',
          url: `${userServer}/users/${userId}`
        }, req.headers),

        // Nhánh 2: Kiểm tra kho cho tất cả sản phẩm qua gRPC
        Promise.all(cartItems.map(item => 
          grpcCall('checkStock', { productId: item.productId, quantity: item.quantity }, token)
        ))
      ]);

      // Sau khi tập hợp đủ dữ liệu mới tạo đơn hàng
      const orderRes = await makeHttpRequest(span, {
        method: 'POST',
        url: `${CONFIG.orderService}/orders`,
        data: { userId, items: cartItems, shippingAddress, paymentMethod, userData: userRes.data }
      }, req.headers);

      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
      res.status(201).json({ success: true, order: orderRes.data });

    } catch (err) {
      handleUpstreamError(span, res, err, 'checkout-flow');
    }
  });
});

/**
 * Centralized Error Handling: Xử lý lỗi từ các service phía sau
 */
function handleUpstreamError(span, res, err, serviceName) {
  console.error(`[Error] Từ ${serviceName}:`, err.message);
  span.recordException(err);
  span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
  span.end();
  
  const status = err.response?.status || 502; // Mặc định trả về 502 Bad Gateway
  res.status(status).json({
    error: `Upstream Error from ${serviceName}`,
    details: err.response?.data || err.message
  });
}

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`API Gateway đang chạy tại: http://localhost:${PORT}`);
  console.log(`Jaeger Tracing UI: http://localhost:16686`);
  console.log(`Load Balancing: Round Robin (2 instances)`);
  console.log(`Caching: In-memory (TTL: 60s)`);
});