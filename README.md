# Demo API Gateway

Dự án minh họa **API Gateway** (Node.js + Express) đứng trước nhiều microservice, kết hợp **OpenTelemetry** export trace qua **OTLP HTTP** tới **Jaeger**. Có **REST** (User, Order) và **gRPC** (Product), gateway thực hiện **dịch giao thức** (REST → gRPC), **round-robin** giữa hai instance User Service, **cache bộ nhớ** cho danh sách sản phẩm, và **gộp luồng checkout** gọi song song nhiều service.

## Kiến trúc tổng quan

```
Client (Browser / curl)
        │ REST
        ▼
   API Gateway (:3000)
        ├── REST ──► User Service (:3001)     [có thể 2 instance, load balance]
        ├── gRPC ──► Product Service (:50051)
        └── REST ──► Order Service (:3002)

Tất cả service ── OTLP/HTTP ──► Jaeger (:16686 UI, :4318 collector)
```

- **Jaeger**: giao diện trace tại [http://localhost:16686](http://localhost:16686).
- **Tracing dùng chung**: file `tracing.js` — `initTracing('<tên-service>')` được gọi đầu tiên trong mỗi `index.js`.

## Yêu cầu

- **Node.js** 20+ (khớp với image Docker).
- **Docker** & **Docker Compose** (nếu chạy bằng container).
- **npm**.

## Cài đặt

```bash
npm install
```

## Chạy nhanh (máy local, không Docker)

Cần **Jaeger** đang nhận OTLP (ví dụ chạy stack Docker chỉ với service `jaeger`, hoặc Jaeger local). Mặc định trace gửi tới `http://localhost:4318` (xem `tracing.js`).

Chạy đồng thời gateway + cả ba service:

```bash
npm run dev
```

Hoặc từng service:

```bash
npm run start:gateway
npm run start:user
npm run start:product
npm run start:order
```

**Cổng mặc định**

| Thành phần        | Cổng  | Giao thức |
|-------------------|-------|-----------|
| API Gateway       | 3000  | HTTP      |
| User Service      | 3001  | HTTP      |
| Order Service     | 3002  | HTTP      |
| Product Service   | 50051 | gRPC      |
| Jaeger UI         | 16686 | HTTP      |
| OTLP HTTP (Jaeger)| 4318  | HTTP      |

**Load balance User Service (local):** gateway đọc `USER_SERVICE_URL` và `USER_SERVICE_URL_2` (mặc định `http://localhost:3011` cho instance thứ hai). Nếu chỉ chạy một instance user trên `3001`, có thể bỏ qua hoặc trỏ cả hai biến về cùng URL.

## Chạy bằng Docker Compose

```bash
npm run docker:up
```

Các lệnh hữu ích:

- `npm run docker:down` — dừng và xóa volume.
- `npm run docker:logs` — xem log theo dõi.
- `npm run docker:clean-up` — giải phóng cổng host rồi build lại (cần `npx kill-port`).

Compose build một image chung với `SERVICE` build-arg (`gateway`, `user-service`, `product-service`, `order-service`) — xem `dockerfile`.

**Lưu ý tên file Docker:** file trong repo là `dockerfile` (chữ thường). `docker-compose.yml` tham chiếu `Dockerfile`. Trên Windows thường vẫn build được; trên Linux (hệ file phân biệt hoa thường) nên đổi tên file thành `Dockerfile` hoặc chỉnh `dockerfile:` trong `docker-compose.yml` cho khớp.

## Giao diện demo tĩnh

Gateway phục vụ thư mục `gateway/public/`. Mở trình duyệt: [http://localhost:3000](http://localhost:3000) (file `index.html`).

## API Gateway (đã triển khai trong `gateway/index.js`)

| Phương thức | Đường dẫn        | Mô tả |
|-------------|------------------|--------|
| `GET`       | `/api/users`     | Proxy tới User Service, **round-robin** giữa các URL trong cấu hình. |
| `GET`       | `/api/products`  | Gọi Product Service qua **gRPC** `ListProducts`; có **cache in-memory** (TTL ~60 giây, key theo `page` / `pageSize`). |
| `POST`      | `/api/checkout`  | Luồng tổng hợp: song song lấy user (REST) + kiểm tra kho (gRPC), sau đó tạo đơn (REST). |

### Rate limiting

- Áp dụng cho mọi đường dẫn bắt đầu bằng `/api`: tối đa **10 request / 10 giây** (cấu hình trong `gateway/index.js`).

### Header trace

- Response có thể có `X-Trace-Id` (khi có span active) để đối chiếu trên Jaeger.

### Xác thực (demo)

- Các service và gRPC thường yêu cầu header: `Authorization: Bearer secret-token`.
- **`POST /api/checkout`**: nếu gửi header `x-auth-mode: gateway` thì gateway kiểm tra token tại cổng; token hợp lệ giống trên (`Bearer secret-token`).

## User Service (`user-service/`)

REST, dữ liệu mock trong bộ nhớ.

- `GET /users` — danh sách (query `tier` tùy chọn), có middleware auth.
- `GET /users/:userId` — chi tiết user.
- `GET /users/:userId/validate` — dùng cho Order Service.

## Product Service (`product-service/`)

gRPC theo `product.proto`: `ListProducts`, `GetProduct`, `CheckStock` (implement trong code: `listProducts`, `checkStock`; kiểm tra metadata `authorization`).

## Order Service (`order-service/`)

- `POST /orders` — tạo đơn (validate user qua User Service, tính giảm giá theo tier).
- `GET /orders` — danh sách đơn trong bộ nhớ.

## Biến môi trường (tóm tắt)

| Biến | Mô tả |
|------|--------|
| `PORT` | Cổng HTTP (gateway 3000, user 3001, order 3002). |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base URL OTLP (không gồm path); trace gửi tới `{ENDPOINT}/v1/traces`. |
| `USER_SERVICE_URL`, `USER_SERVICE_URL_2` | URL User Service (gateway load balance). |
| `ORDER_SERVICE_URL` | URL Order Service (gateway). |
| `PRODUCT_SERVICE_HOST`, `PRODUCT_SERVICE_PORT` | Host/port gRPC Product (gateway). |
| `USER_SERVICE_URL` (order-service) | URL để gọi User Service khi validate. |

## Cấu trúc thư mục

```
demo-api-gateway/
├── gateway/           # API Gateway (Express + static UI)
├── user-service/      # REST
├── product-service/   # gRPC + product.proto
├── order-service/     # REST
├── tracing.js         # OpenTelemetry SDK dùng chung
├── docker-compose.yml
├── dockerfile         # Build multi-service (ARG SERVICE)
└── package.json
```

## Công nghệ chính

- **Express**, **Axios**, **@grpc/grpc-js**, **express-rate-limit**
- **OpenTelemetry** (Node SDK, OTLP HTTP exporter, instrumentation HTTP / Express / gRPC)
- **Jaeger** (all-in-one, OTLP enabled)

---

Dự án phục vụ mục đích học tập và demo: quan sát trace đầu-cuối trên Jaeger khi luồng đi qua gateway và nhiều service.
