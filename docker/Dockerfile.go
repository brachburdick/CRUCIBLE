FROM crucible-runner:base

# Go 1.22 (latest stable as of image build)
# Auto-detect architecture for multi-platform builds
ARG GO_VERSION=1.22.5
RUN ARCH=$(dpkg --print-architecture) && \
    case "$ARCH" in \
      amd64) GOARCH=amd64 ;; \
      arm64) GOARCH=arm64 ;; \
      *) echo "Unsupported arch: $ARCH" && exit 1 ;; \
    esac && \
    curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${GOARCH}.tar.gz" \
    | tar -C /usr/local -xzf -
ENV PATH="/usr/local/go/bin:/home/agent/go/bin:${PATH}"
ENV GOPATH="/home/agent/go"
