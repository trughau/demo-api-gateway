# ─────────────────────────────────────────────────────────────
# Single Dockerfile cho tất cả services
# Build với: docker build --build-arg SERVICE=gateway .
#            docker build --build-arg SERVICE=user-service .
#            docker build --build-arg SERVICE=order-service .
#            docker build --build-arg SERVICE=product-service .
# ─────────────────────────────────────────────────────────────

# ── Stage 1: Install dependencies ────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app

COPY package.json ./
RUN npm install --production && npm cache clean --force

# ── Stage 2: Final image ──────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

# Argument xác định service nào sẽ chạy
ARG SERVICE
ENV SERVICE=${SERVICE}

# Copy node_modules từ stage deps
COPY --from=deps /app/node_modules ./node_modules

# Copy shared files
COPY tracing.js ./
COPY package.json ./

# Copy tất cả service folders
COPY gateway/        ./gateway/
COPY user-service/   ./user-service/
COPY order-service/  ./order-service/
COPY product-service/ ./product-service/

# Chạy đúng service theo ARG
CMD node ${SERVICE}/index.js