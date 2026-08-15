# Stage 1: Build the packages/app
FROM debian:bookworm-slim AS builder

WORKDIR /app

# Install build dependencies including node, npm, and bun
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates gnupg \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && npm install -g bun \
    && rm -rf /var/lib/apt/lists/*

# Copy workspace configuration files
COPY ./ ./

# Slim down workspace - only include packages needed for frontend build
# Remove lockfile and whitelist only app and its dependencies
RUN rm -f bun.lock && \
    bun -e 'var p=JSON.parse(require("fs").readFileSync("package.json","utf8"));p.workspaces.packages=["packages/app","packages/ui","packages/sdk/js","packages/plugin","packages/script","packages/core","packages/schema","packages/session-ui","packages/llm","packages/http-recorder","packages/effect-drizzle-sqlite","packages/effect-sqlite-node"];p.devDependencies={"prettier":"3.6.2"};require("fs").writeFileSync("package.json",JSON.stringify(p,null,2))'

# Install dependencies, skipping postinstall scripts
RUN bun install --ignore-scripts

# Build the frontend (values passed from docker-compose via .env)
ARG VITE_OPENCODE_SERVER_HOST
ARG VITE_OPENCODE_SERVER_PORT
ARG VITE_OPENCODE_SERVER_PROTOCOL
RUN NODE_ENV=production VITE_OPENCODE_SERVER_HOST=$VITE_OPENCODE_SERVER_HOST VITE_OPENCODE_SERVER_PORT=$VITE_OPENCODE_SERVER_PORT VITE_OPENCODE_SERVER_PROTOCOL=$VITE_OPENCODE_SERVER_PROTOCOL bun run --cwd packages/app build

# Stage 2: Serve with nginx
FROM nginx:alpine

# Remove default nginx config
RUN rm /etc/nginx/conf.d/default.conf

# Copy built files
COPY --from=builder /app/packages/app/dist /usr/share/nginx/html

# Copy custom nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Port 80 accessible via network_mode: host
CMD ["nginx", "-g", "daemon off;"]
