'use strict';

// Khởi tạo Tracing cho Product Service
require('../tracing').initTracing('product-service');

const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');
const { trace, SpanStatusCode } = require('@opentelemetry/api');

// ─────────────────────────────────────────
// Load Proto
// ─────────────────────────────────────────
const PROTO_PATH = path.join(__dirname, './product.proto');
const packageDef = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true, longs: String, enums: String, defaults: true, oneofs: true,
});
const productProto = grpc.loadPackageDefinition(packageDef).product;

const tracer = trace.getTracer('product-service');

// ─────────────────────────────────────────
// Mock Database
// ─────────────────────────────────────────
const PRODUCTS = [
  { productId: 'prod-001', name: 'Laptop Gaming Pro', price: 25000000, stock: 10 },
  { productId: 'prod-002', name: 'Chuột Không Dây', price: 500000, stock: 50 },
  { productId: 'prod-003', name: 'Bàn Phím Cơ RGB', price: 1200000, stock: 0 },
];

// ─────────────────────────────────────────
// CHUẨN HÓA: Hàm Check Auth cho gRPC
// ─────────────────────────────────────────
function checkAuth(call, span) {
  // gRPC Metadata lấy giá trị theo mảng, ta lấy phần tử đầu tiên [0]
  const authHeader = call.metadata.get('authorization')[0];

  if (!authHeader || authHeader !== 'Bearer secret-token') {
    span.setAttribute('auth.success', false);
    span.setStatus({ 
      code: SpanStatusCode.ERROR, 
      message: 'gRPC Authentication Failed' 
    });
    return false;
  }

  span.setAttribute('auth.success', true);
  return true;
}

// ─────────────────────────────────────────
// Implement RPC Methods
// ─────────────────────────────────────────

/**
 * ListProducts - Lấy danh sách sản phẩm
 */
function listProducts(call, callback) {
  const span = tracer.startSpan('product.listProducts');

  // 1. CHẶN AUTH TRƯỚC
  if (!checkAuth(call, span)) {
    span.end();
    return callback({
      code: grpc.status.UNAUTHENTICATED,
      message: 'Bị chặn tại Product Service: Token không hợp lệ'
    });
  }

  // 2. LOGIC NGHIỆP VỤ (Chỉ chạy khi Auth xong)
  span.setAttribute('product.count', PRODUCTS.length);
  callback(null, { products: PRODUCTS, total: PRODUCTS.length });
  
  span.setStatus({ code: SpanStatusCode.OK });
  span.end();
}

/**
 * CheckStock - Kiểm tra kho hàng
 */
function checkStock(call, callback) {
  const span = tracer.startSpan('product.checkStock');

  // 1. CHẶN AUTH TRƯỚC
  if (!checkAuth(call, span)) {
    span.end();
    return callback({
      code: grpc.status.UNAUTHENTICATED,
      message: 'Bị chặn tại Product Service: Token không hợp lệ'
    });
  }

  // 2. LOGIC NGHIỆP VỤ
  const { productId, quantity } = call.request;
  span.setAttributes({ 'product.id': productId, 'requested.quantity': quantity });

  const product = PRODUCTS.find(p => p.productId === productId);
  
  if (!product) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: 'Product Not Found' });
    span.end();
    return callback({ code: grpc.status.NOT_FOUND, message: 'Sản phẩm không tồn tại' });
  }

  const isAvailable = product.stock >= quantity;
  callback(null, { 
    available: isAvailable, 
    message: isAvailable ? 'Còn hàng' : 'Hết hàng' 
  });

  span.setStatus({ code: SpanStatusCode.OK });
  span.end();
}

// ─────────────────────────────────────────
// Start gRPC Server
// ─────────────────────────────────────────
function main() {
  const server = new grpc.Server();
  server.addService(productProto.ProductService.service, {
    listProducts: listProducts,
    checkStock: checkStock,
  });

  const PORT = '50051';
  server.bindAsync(`0.0.0.0:${PORT}`, grpc.ServerCredentials.createInsecure(), (err, port) => {
    if (err) return console.error(err);
    console.log(`Product Service is running on port ${PORT}`);
    console.log(`Protocol: gRPC`);
  });
}
main();