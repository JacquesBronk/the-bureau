FROM node:22-slim
# ca-certificates is required for git-over-HTTPS to external hosts (e.g. the
# GitHub multi-repo destination). In-cluster Forgejo is plain HTTP so this was
# latent until the first external destination; the worker image already has it.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY dist/mcp-server.bundle.cjs /app/mcp-server.bundle.cjs
COPY agents /app/agents
COPY skills /app/skills
COPY plugins/criteria /app/plugins/criteria
COPY package.json /app/package.json
ENV NODE_ENV=production
EXPOSE 3917
ENTRYPOINT ["node", "/app/mcp-server.bundle.cjs"]
