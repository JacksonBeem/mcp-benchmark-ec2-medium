const API_BASE = "https://en.wikipedia.org/w/api.php";
const REST_BASE = "https://en.wikipedia.org/api/rest_v1";
const USER_AGENT = "mcp-benchmark-wikipedia-adapter/1.0";

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function initializationResult() {
  return {
    protocolVersion: "2024-11-05",
    capabilities: { tools: {} },
    serverInfo: {
      name: "wikipedia-mcp",
      version: "1.0.0",
    },
  };
}

function makeTool(name, description, properties, required = []) {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      required,
    },
  };
}

const baseTools = [
  makeTool(
    "search_wikipedia",
    "Search Wikipedia for articles matching a query.",
    {
      query: { type: "string", description: "The search term to look up on Wikipedia." },
      limit: { type: "integer", description: "Maximum number of results to return.", default: 10 },
    },
    ["query"],
  ),
  makeTool(
    "test_wikipedia_connectivity",
    "Provide diagnostics for Wikipedia API connectivity.",
    {},
  ),
  makeTool(
    "get_article",
    "Get the full content of a Wikipedia article.",
    {
      title: { type: "string", description: "Wikipedia article title." },
    },
    ["title"],
  ),
  makeTool(
    "get_summary",
    "Get a summary of a Wikipedia article.",
    {
      title: { type: "string", description: "Wikipedia article title." },
    },
    ["title"],
  ),
  makeTool(
    "get_sections",
    "Get the sections of a Wikipedia article.",
    {
      title: { type: "string", description: "Wikipedia article title." },
    },
    ["title"],
  ),
  makeTool(
    "get_links",
    "Get the links contained within a Wikipedia article.",
    {
      title: { type: "string", description: "Wikipedia article title." },
    },
    ["title"],
  ),
  makeTool(
    "get_coordinates",
    "Get the coordinates of a Wikipedia article.",
    {
      title: { type: "string", description: "Wikipedia article title." },
    },
    ["title"],
  ),
];

const TOOLS = baseTools.flatMap((tool) => [
  tool,
  { ...tool, name: `wikipedia_${tool.name}` },
]);

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
  });

  if (!response.ok) {
    throw new Error(`Wikipedia request failed with status ${response.status}`);
  }

  return response.json();
}

function buildApiUrl(params) {
  const url = new URL(API_BASE);
  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.set(key, String(value));
  });
  url.searchParams.set("format", "json");
  url.searchParams.set("origin", "*");
  return url;
}

async function searchWikipedia(query, limit = 10) {
  const bounded = Math.min(Math.max(Number(limit) || 10, 1), 500);
  const url = buildApiUrl({
    action: "query",
    list: "search",
    srsearch: query,
    srlimit: bounded,
    utf8: 1,
  });
  const data = await fetchJson(url);
  const results = (data.query?.search ?? []).map((item) => ({
    title: item.title,
    pageid: item.pageid,
    snippet: String(item.snippet ?? "").replace(/<[^>]+>/g, ""),
    wordcount: item.wordcount,
    timestamp: item.timestamp,
  }));
  return {
    query,
    results,
    status: results.length > 0 ? "success" : "no_results",
    count: results.length,
    language: "en",
  };
}

async function testWikipediaConnectivity() {
  const started = Date.now();
  try {
    const url = buildApiUrl({
      action: "query",
      meta: "siteinfo",
      siprop: "general",
    });
    const data = await fetchJson(url);
    return {
      status: "success",
      api_url: API_BASE,
      language: "en",
      response_time_ms: Date.now() - started,
      site_name: data.query?.general?.sitename ?? "Wikipedia",
      generator: data.query?.general?.generator ?? null,
    };
  } catch (error) {
    return {
      status: "failed",
      api_url: API_BASE,
      language: "en",
      response_time_ms: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function getArticle(title) {
  const url = buildApiUrl({
    action: "query",
    prop: "extracts|info",
    inprop: "url",
    explaintext: 1,
    exsectionformat: "plain",
    redirects: 1,
    titles: title,
  });
  const data = await fetchJson(url);
  const pages = Object.values(data.query?.pages ?? {});
  const page = pages[0];
  if (!page || page.missing !== undefined) {
    return { title, exists: false, error: "Article not found" };
  }
  return {
    title: page.title,
    exists: true,
    pageid: page.pageid,
    fullurl: page.fullurl ?? null,
    extract: page.extract ?? "",
  };
}

async function getSummary(title) {
  const url = `${REST_BASE}/page/summary/${encodeURIComponent(title)}`;
  try {
    const data = await fetchJson(url);
    return {
      title: data.title ?? title,
      summary: data.extract ?? null,
      description: data.description ?? null,
      url: data.content_urls?.desktop?.page ?? null,
    };
  } catch (error) {
    return {
      title,
      summary: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function getSections(title) {
  const url = buildApiUrl({
    action: "parse",
    page: title,
    prop: "sections",
    redirects: 1,
  });
  try {
    const data = await fetchJson(url);
    const sections = (data.parse?.sections ?? []).map((section) => ({
      index: section.index,
      line: section.line,
      number: section.number,
      level: section.level,
    }));
    return { title, sections };
  } catch (error) {
    return {
      title,
      sections: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function getLinks(title) {
  const links = [];
  let continueToken = null;

  while (true) {
    const url = buildApiUrl({
      action: "query",
      prop: "links",
      titles: title,
      pllimit: 500,
      redirects: 1,
      ...(continueToken ? { plcontinue: continueToken } : {}),
    });
    const data = await fetchJson(url);
    const pages = Object.values(data.query?.pages ?? {});
    const page = pages[0];
    if (!page || page.missing !== undefined) {
      return { title, links: [], error: "Article not found" };
    }
    links.push(...(page.links ?? []).map((item) => item.title));
    continueToken = data.continue?.plcontinue ?? null;
    if (!continueToken || links.length >= 500) {
      break;
    }
  }

  return { title, links: links.slice(0, 500) };
}

async function getCoordinates(title) {
  const url = buildApiUrl({
    action: "query",
    prop: "coordinates",
    titles: title,
    redirects: 1,
    colimit: 1,
  });
  const data = await fetchJson(url);
  const pages = Object.values(data.query?.pages ?? {});
  const page = pages[0];
  if (!page || page.missing !== undefined) {
    return { title, coordinates: null, error: "Article not found" };
  }
  const coord = page.coordinates?.[0];
  return {
    title,
    coordinates: coord
      ? {
          lat: coord.lat,
          lon: coord.lon,
          primary: coord.primary ?? null,
          globe: coord.globe ?? null,
        }
      : null,
  };
}

async function handleToolCall(name, args) {
  switch (name.replace(/^wikipedia_/, "")) {
    case "search_wikipedia":
      if (!args.query) {
        throw new Error("Missing required argument: query");
      }
      return searchWikipedia(String(args.query), args.limit);
    case "test_wikipedia_connectivity":
      return testWikipediaConnectivity();
    case "get_article":
      if (!args.title) {
        throw new Error("Missing required argument: title");
      }
      return getArticle(String(args.title));
    case "get_summary":
      if (!args.title) {
        throw new Error("Missing required argument: title");
      }
      return getSummary(String(args.title));
    case "get_sections":
      if (!args.title) {
        throw new Error("Missing required argument: title");
      }
      return getSections(String(args.title));
    case "get_links":
      if (!args.title) {
        throw new Error("Missing required argument: title");
      }
      return getLinks(String(args.title));
    case "get_coordinates":
      if (!args.title) {
        throw new Error("Missing required argument: title");
      }
      return getCoordinates(String(args.title));
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function makeTextResult(payload) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

async function handleRequest(message) {
  const id = message.id ?? null;

  if (message.method === "initialize") {
    return jsonRpcResult(id, initializationResult());
  }
  if (message.method === "notifications/initialized") {
    return null;
  }
  if (message.method === "tools/list") {
    return jsonRpcResult(id, { tools: TOOLS });
  }
  if (message.method !== "tools/call") {
    return jsonRpcError(id, -32601, `Method not found: ${message.method}`);
  }

  const name = message.params?.name;
  const args = message.params?.arguments ?? {};
  return jsonRpcResult(id, makeTextResult(await handleToolCall(String(name), args)));
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      continue;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      writeMessage(jsonRpcError(null, -32700, "Parse error"));
      continue;
    }

    try {
      const response = await handleRequest(message);
      if (response) {
        writeMessage(response);
      }
    } catch (error) {
      writeMessage(
        jsonRpcError(
          message.id ?? null,
          -32603,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }
});

process.stdin.on("end", () => {
  process.exit(0);
});
