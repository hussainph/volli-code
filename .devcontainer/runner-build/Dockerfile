# Runner ABI baseline: Debian 11 / glibc 2.31. Node has no bullseye image.
FROM debian:bullseye-slim

# Official Node release tarballs, pinned independently for each native runner.
# Update these hashes together with .nvmrc (nodejs.org/dist/v24.22.1/SHASUMS256.txt).
ARG TARGETARCH
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl xz-utils git openssh-client python3 make g++ binutils shellcheck \
    && rm -rf /var/lib/apt/lists/* \
    && case "$TARGETARCH" in \
        amd64) arch=x64; sha=6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6 ;; \
        arm64) arch=arm64; sha=dbabf7a1cbf947e6059ffad2c27b80041db97dea1e553b62afdee7f13fca336e ;; \
        *) echo "Unsupported runner build architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && curl --fail --location --proto '=https' --tlsv1.2 \
        "https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-$arch.tar.xz" -o /tmp/node.tar.xz \
    && echo "$sha  /tmp/node.tar.xz" | sha256sum -c - \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    && rm /tmp/node.tar.xz

ENV COREPACK_HOME=/usr/local/share/corepack
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
COPY .nvmrc package.json /opt/volli-toolchain/
RUN test "$(node -p 'process.versions.node')" = "$(cat /opt/volli-toolchain/.nvmrc)" \
    && corepack enable pnpm \
    && corepack install --global "$(node -p 'require("/opt/volli-toolchain/package.json").packageManager')" \
    && chmod -R a+rX "$COREPACK_HOME" \
    && npm cache clean --force \
    && useradd --create-home --uid 1000 --shell /bin/bash runner \
    && mkdir -p /workspace && chown runner:runner /workspace

USER runner
WORKDIR /workspace
CMD ["bash"]
