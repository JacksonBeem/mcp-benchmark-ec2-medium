FROM node:20-slim

WORKDIR /app/ec2/runtime
COPY ec2/runtime/package.json ./
COPY ec2/runtime/tsconfig.json ./
RUN npm install

COPY ec2/runtime/src ./src
RUN npm run build

WORKDIR /app
COPY ec2/medium-route-config.json ec2/medium-route-config.json
COPY servers ./servers

ENV PORT=3000
ENV MCP_ROUTE_CONFIGS_FILE=ec2/medium-route-config.json

CMD ["node", "ec2/runtime/dist/ec2-mcp-server.js"]
