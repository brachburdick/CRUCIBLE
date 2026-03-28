FROM node:20-bookworm-slim

# System dependencies for agent bash usage + network lockdown
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    python3 \
    python3-pip \
    build-essential \
    curl \
    jq \
    iptables \
    iproute2 \
    dnsutils \
    ca-certificates \
    gosu \
  && rm -rf /var/lib/apt/lists/*

# Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Non-root user
RUN useradd -m -s /bin/bash agent

# Workspace
RUN mkdir -p /workspace && chown agent:agent /workspace

# Entrypoint handles network lockdown then drops to non-root
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

WORKDIR /workspace

ENTRYPOINT ["/entrypoint.sh"]
CMD ["sleep", "infinity"]
