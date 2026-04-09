# NanoClaw Agent Container
# Own agentic loop via @anthropic-ai/sdk → LiteLLM → Ollama
# No Claude Code SDK, no login required.

FROM node:22-slim

# Minimal system deps — curl and git for bash tool use
RUN apt-get update && apt-get install -y \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files first for better layer caching
COPY agent-runner/package*.json ./

# Install dependencies
RUN npm install

# Copy and build source
COPY agent-runner/ ./
RUN npm run build

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra \
    /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Entrypoint: read input from file (k8s Jobs) or stdin (docker/dev), run agent
RUN printf '#!/bin/bash\nset -e\nif [ -f /workspace/ipc/job-input.json ]; then\n  cp /workspace/ipc/job-input.json /tmp/input.json\nelse\n  cat > /tmp/input.json\nfi\nnode /app/dist/index.js < /tmp/input.json\n' \
    > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership for writable workspace dirs
RUN chown -R node:node /workspace && chmod 777 /home/node

# Run as non-root
USER node

WORKDIR /workspace/group

ENTRYPOINT ["/app/entrypoint.sh"]
