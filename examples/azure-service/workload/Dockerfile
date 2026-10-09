FROM oven/bun:1.3.13

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY . .

ARG BUILD_MARKER=unset
ENV BUILD_MARKER=${BUILD_MARKER}
EXPOSE 3000
CMD ["bun", "src/api.ts"]
