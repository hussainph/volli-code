# Multi-arch Node 24.22.1 bookworm-slim index (amd64 on CI/dogfood, arm64 locally).
# Update the tag AND digest with .nvmrc; the build refuses version drift.
FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

# Development tools for git/worktrees and future Node-ABI native builds, plus
# standalone Chromium's runtime libraries (not Electron or a browser binary).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates git openssh-client python3 make g++ \
        fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 \
        libcairo2 libcups2 libdbus-1-3 libdrm2 libexpat1 libgbm1 libglib2.0-0 \
        libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 \
        libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 libxss1 libxtst6 \
    && rm -rf /var/lib/apt/lists/*

ENV COREPACK_HOME=/usr/local/share/corepack
COPY .nvmrc package.json /opt/volli-toolchain/
RUN test "$(node -p 'process.versions.node')" = "$(cat /opt/volli-toolchain/.nvmrc)" \
    && corepack enable pnpm \
    && corepack install --global "$(node -p 'require("/opt/volli-toolchain/package.json").packageManager')" \
    && chmod -R a+rX "$COREPACK_HOME" \
    && npm cache clean --force \
    && mkdir -p /workspace/node_modules && chown -R node:node /workspace

USER node
WORKDIR /workspace
CMD ["bash"]
