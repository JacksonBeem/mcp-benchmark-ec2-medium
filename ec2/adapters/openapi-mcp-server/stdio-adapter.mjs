import { createInterface } from "node:readline";
import { dump, load } from "js-yaml";
import { dereferenceSync } from "@trojs/openapi-dereference";

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function jsonRpcResult(id, result) {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

function jsonRpcError(id, code, message) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  };
}

function tryParseJson(text) {
  try {
    const removeCommentsRegex =
      /\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g;
    const jsonStringWithoutComments = text.replace(
      removeCommentsRegex,
      (match, group) => (group ? "" : match),
    );
    return JSON.parse(jsonStringWithoutComments);
  } catch {
    return null;
  }
}

async function convertSwaggerToOpenapi(swaggerUrl) {
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), 10000);
  try {
    const response = await fetch(
      `https://converter.swagger.io/api/convert?url=${swaggerUrl}`,
      { signal: abortController.signal },
    );
    return await response.json();
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function searchOpenapi(providerId) {
  const isDirectUrl =
    typeof providerId === "string" &&
    /^https?:\/\//i.test(providerId);

  let openapiUrl;
  if (isDirectUrl) {
    openapiUrl = providerId;
  } else {
    const urlResponse = await fetch(
      `https://openapisearch.com/redirect/${providerId}`,
      { redirect: "follow" },
    );
    if (!urlResponse.ok) {
      throw new Error(`OpenAPI redirect failed for ${providerId}`);
    }
    openapiUrl = urlResponse.url;
  }

  const response = await fetch(openapiUrl);
  if (!response.ok) {
    throw new Error(`OpenAPI fetch failed for ${openapiUrl}`);
  }

  const text = await response.text();
  let openapiJson = tryParseJson(text);
  if (!openapiJson) {
    openapiJson = load(text);
  }
  if (!openapiJson) {
    throw new Error(`Could not parse OpenAPI document for ${providerId}`);
  }

  return { openapiUrl, openapiJson };
}

function getServerOrigin(operation, rootServers) {
  const servers = operation?.servers || rootServers || [];
  if (servers.length === 0) {
    return "";
  }

  try {
    return new URL(servers[0].url).origin;
  } catch {
    return String(servers[0].url || "");
  }
}

function generateOverview(hostname, openapi) {
  const output = [];

  if (openapi.info) {
    const { title, version, description } = openapi.info;
    const serverOrigin = getServerOrigin(undefined, openapi.servers || []);
    output.push(`${title} v${version} - ${serverOrigin}`);
    if (description) {
      output.push(description);
    }
    output.push("");
  }

  const items = [];
  if (openapi.paths) {
    for (const [path, pathItem] of Object.entries(openapi.paths)) {
      for (const method of ["get", "post", "put", "patch", "delete"]) {
        const operation = pathItem?.[method];
        if (!operation) {
          continue;
        }

        const serverOrigin = getServerOrigin(operation, openapi.servers || []);
        const operationId = operation.operationId ? `${operation.operationId}` : "";
        const queryParams = (operation.parameters || [])
          .filter((parameter) => parameter.in === "query")
          .map((parameter) => `${parameter.name}=${parameter.schema?.type || parameter.name}`)
          .join("&");
        const queryString = queryParams ? `?${queryParams}` : "";
        const summaryPart = operation.summary ? ` - ${operation.summary}` : "";
        const pathPart = `${method.toUpperCase()} ${serverOrigin}${path}${queryString}`;
        const openapiUrl = `https://oapis.org/openapi/${hostname}${operationId ? `/${operationId}` : path}`;

        items.push({ operationId, pathPart, summaryPart, openapiUrl });
      }
    }
  }

  const isLong = JSON.stringify(items).length > 50000;
  output.push(
    ...items.map(
      (item) =>
        `- ${item.operationId}${isLong ? " " : ` ${item.pathPart}`}${item.summaryPart} ( Spec: ${item.openapiUrl} )`,
    ),
  );

  const endpointCount = Math.max(output.length - 3, 0);
  output.unshift(
    `Below is an overview of the ${hostname} openapi in simple language. This API contains ${endpointCount} endpoints. For more detailed information of an endpoint, visit https://oapis.org/summary/${hostname}/[idOrRoute]`,
  );
  output.unshift("");
  return output.join("\n");
}

function matchOperation(openapi, pathname) {
  if (!openapi.paths) {
    return undefined;
  }

  const directMatch = openapi.paths[pathname]?.get;
  if (directMatch) {
    return { operation: directMatch, originalPath: pathname, method: "GET" };
  }

  const normalizedPathname = pathname.startsWith("/") ? pathname.slice(1) : pathname;
  for (const [path, pathItem] of Object.entries(openapi.paths)) {
    const method = ["get", "post", "put", "patch", "delete"].find((candidate) => {
      const operation = pathItem?.[candidate];
      return operation?.operationId === normalizedPathname;
    });

    if (method) {
      return {
        operation: pathItem[method],
        originalPath: path,
        method: method.toUpperCase(),
      };
    }
  }

  return undefined;
}

async function resolveOpenapi(providerId) {
  const { openapiUrl, openapiJson } = await searchOpenapi(providerId);
  const isSwagger =
    openapiJson?.swagger ||
    !openapiJson?.openapi ||
    !String(openapiJson.openapi).startsWith("3.");

  const convertedOpenapi = isSwagger
    ? await convertSwaggerToOpenapi(openapiUrl)
    : openapiJson;

  if (!convertedOpenapi?.openapi) {
    throw new Error("Conversion failed");
  }

  return convertedOpenapi;
}

async function handleGetApiOverview(args) {
  const id = args?.id;
  if (!id) {
    return {
      content: [{ type: "text", text: "Error: 'id' parameter is required" }],
      isError: true,
    };
  }

  try {
    const openapi = await resolveOpenapi(id);
    const overview = generateOverview(id, openapi);
    if (overview.length > 250000) {
      throw new Error("The OpenAPI specification is too large to process with this MCP.");
    }
    return {
      content: [{ type: "text", text: overview }],
      isError: false,
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }
}

async function handleGetApiOperation(args) {
  const id = args?.id;
  const operationIdOrRoute = args?.operationIdOrRoute;
  if (!id || !operationIdOrRoute) {
    return {
      content: [
        {
          type: "text",
          text: "Error: Both 'id' and 'operationIdOrRoute' parameters are required",
        },
      ],
      isError: true,
    };
  }

  try {
    const openapi = await resolveOpenapi(id);
    const match = matchOperation(openapi, `/${operationIdOrRoute}`);
    if (!match?.operation) {
      throw new Error(`Operation wasn't found: ${operationIdOrRoute}`);
    }

    const subset = {
      ...openapi,
      paths: {
        [match.originalPath]: {
          [match.method.toLowerCase()]: match.operation,
        },
      },
    };

    try {
      const { tags, webhooks, components, ...dereferenced } = dereferenceSync(subset);
      return {
        content: [{ type: "text", text: dump(dereferenced) }],
        isError: false,
      };
    } catch {
      return {
        content: [{ type: "text", text: dump(subset) }],
        isError: false,
      };
    }
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }
}

const toolDefinitions = [
  {
    name: "getApiOverview",
    description: "Get an overview of an OpenAPI specification by id or raw spec URL.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "API identifier from openapisearch.com or a direct OpenAPI URL.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "getApiOperation",
    description: "Get details for a single OpenAPI operation by operationId or route.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "API identifier from openapisearch.com or a direct OpenAPI URL.",
        },
        operationIdOrRoute: {
          type: "string",
          description: "Operation ID or route path to inspect.",
        },
      },
      required: ["id", "operationIdOrRoute"],
    },
  },
];

function getInitializeResult() {
  return {
    protocolVersion: "2024-11-05",
    capabilities: { tools: {} },
    serverInfo: {
      name: "openapi-mcp-server",
      version: "1.0.0",
    },
  };
}

async function handleRequest(message) {
  const id = message.id ?? null;
  const method = message.method;

  if (method === "initialize") {
    return jsonRpcResult(id, getInitializeResult());
  }

  if (method === "notifications/initialized") {
    return null;
  }

  if (method === "tools/list") {
    return jsonRpcResult(id, { tools: toolDefinitions });
  }

  if (method === "tools/call") {
    const toolName = message.params?.name;
    const args = message.params?.arguments || {};

    if (toolName === "getApiOverview") {
      return jsonRpcResult(id, await handleGetApiOverview(args));
    }
    if (toolName === "getApiOperation") {
      return jsonRpcResult(id, await handleGetApiOperation(args));
    }

    return jsonRpcError(id, -32601, `Unknown tool: ${toolName}`);
  }

  return jsonRpcError(id, -32601, `Method not found: ${method}`);
}

const rl = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    writeMessage(jsonRpcError(null, -32700, "Parse error"));
    return;
  }

  try {
    const response = await handleRequest(message);
    if (response) {
      writeMessage(response);
    }
  } catch (error) {
    writeMessage(jsonRpcError(message.id ?? null, -32603, error.message));
  }
});

rl.on("close", () => {
  process.exit(0);
});
