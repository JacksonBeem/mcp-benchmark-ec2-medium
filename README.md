# MCP Benchmark EC2 Medium

Tier-specific EC2 runtime for the medium-tier MCP benchmark servers. This repo was split from `mcp-benchmark-EC2` so one EC2 host/repository maps to one evaluated tier.

## Medium Tier Servers

1. `bibliomantic-mcp-server`
2. `car-price-mcp-main`
3. `game-trends-mcp`
4. `metmuseum-mcp`
5. `mcp-server-nationalparks`
6. `openapi-mcp-server`
7. `weather_mcp`
8. `mcp-osint-server`
9. `context7`
10. `steam-mcp`

## Key Files

- `ec2/medium-route-config.json` - route config for `/medium/mcp` and `/medium/health`.
- `ec2/install-medium.sh` - clones and builds the 10 medium-tier servers.
- `ec2/bootstrap-medium-host.sh` - installs host dependencies, installs medium servers, builds the runtime, and starts PM2.
- `ec2/ecosystem.medium.config.cjs` - PM2 process definition using `ec2/medium-route-config.json`.
- `ec2/runtime/` - Fastify streamable HTTP to stdio MCP bridge.
- `ec2/adapters/` - local stdio adapters needed by this tier.

## EC2 Setup

```bash
bash ec2/bootstrap-medium-host.sh
```

After startup:

- MCP endpoint: `http://127.0.0.1:3000/medium/mcp`
- Health endpoint: `http://127.0.0.1:3000/medium/health`

The `servers/` directory is intentionally empty in Git. The bootstrap/install flow populates it on the EC2 host.
