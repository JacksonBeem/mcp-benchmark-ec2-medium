const BASE_API_URL = "https://hn.algolia.com/api/v1";
const DEFAULT_NUM_STORIES = 10;
const DEFAULT_NUM_COMMENTS = 10;
const DEFAULT_COMMENT_DEPTH = 2;

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function fetchJson(pathname, params = {}) {
  const url = new URL(`${BASE_API_URL}/${pathname}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

function formatStoryDetails(story, basic = true) {
  const output = {
    id: Number(story.story_id ?? story.objectID ?? story.id),
    author: story.author,
  };

  if (story.title ?? story.story_title) {
    output.title = story.title ?? story.story_title;
  }
  if (story.points !== undefined && story.points !== null) {
    output.points = story.points;
  }
  if (story.url ?? story.story_url) {
    output.url = story.url ?? story.story_url;
  }
  if (!basic) {
    const children = Array.isArray(story.children) ? story.children : [];
    output.comments = children
      .slice(0, DEFAULT_NUM_COMMENTS)
      .filter((child) => typeof child === "object" && child !== null)
      .map((child) => formatCommentDetails(child));
  }
  return output;
}

function formatCommentDetails(comment, depth = DEFAULT_COMMENT_DEPTH, numComments = DEFAULT_NUM_COMMENTS) {
  const output = {
    author: comment.author,
    text: comment.text,
  };

  const children = Array.isArray(comment.children) ? comment.children : [];
  if (depth > 1 && children.length > 0) {
    output.comments = children
      .slice(0, numComments)
      .filter((child) => typeof child === "object" && child !== null)
      .map((child) => formatCommentDetails(child, depth - 1, numComments));
  }
  return output;
}

async function getStories(storyType, numStories = DEFAULT_NUM_STORIES) {
  const normalized = String(storyType ?? "top").toLowerCase().trim();
  const apiParams = {
    top: { endpoint: "search", tags: "front_page" },
    new: { endpoint: "search_by_date", tags: "story" },
    ask_hn: { endpoint: "search", tags: "ask_hn" },
    show_hn: { endpoint: "search", tags: "show_hn" },
  };

  if (!(normalized in apiParams)) {
    throw new Error("story_type must be one of: top, new, ask_hn, show_hn");
  }

  const config = apiParams[normalized];
  const data = await fetchJson(config.endpoint, {
    tags: config.tags,
    hitsPerPage: numStories,
  });
  return (data.hits || []).map((story) => formatStoryDetails(story, true));
}

async function searchStories(query, numResults = DEFAULT_NUM_STORIES, searchByDate = false) {
  if (!query) {
    throw new Error("Missing required argument: query");
  }
  const endpoint = searchByDate ? "search_by_date" : "search";
  const data = await fetchJson(endpoint, {
    query,
    hitsPerPage: numResults,
    tags: "story",
  });
  return (data.hits || []).map((story) => formatStoryDetails(story, true));
}

async function getStoryInfo(storyId) {
  const data = await fetchJson(`items/${Number(storyId)}`);
  return formatStoryDetails(data, false);
}

async function getUserStories(userName, numStories = DEFAULT_NUM_STORIES) {
  const data = await fetchJson("search", {
    tags: `author_${userName},story`,
    hitsPerPage: numStories,
  });
  return (data.hits || []).map((story) => formatStoryDetails(story, true));
}

async function getUserInfo(userName, numStories = DEFAULT_NUM_STORIES) {
  if (!userName) {
    throw new Error("Missing required argument: user_name");
  }
  const user = await fetchJson(`users/${encodeURIComponent(String(userName))}`);
  user.stories = await getUserStories(String(userName), numStories);
  return user;
}

const TOOL_DEFINITIONS = [
  {
    name: "get_stories",
    description: "Get top, new, ask_hn, or show_hn stories from Hacker News.",
    inputSchema: {
      type: "object",
      properties: {
        story_type: { type: "string", description: "top, new, ask_hn, or show_hn" },
        num_stories: { type: "integer", description: "Number of stories to fetch" },
      },
    },
  },
  {
    name: "get_user_info",
    description: "Get Hacker News user info and recent submitted stories.",
    inputSchema: {
      type: "object",
      properties: {
        user_name: { type: "string", description: "Hacker News username" },
        num_stories: { type: "integer", description: "Number of stories to include" },
      },
      required: ["user_name"],
    },
  },
  {
    name: "search_stories",
    description: "Search Hacker News stories by query.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        search_by_date: { type: "boolean", description: "Sort by date instead of relevance" },
        num_results: { type: "integer", description: "Number of results to return" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_story_info",
    description: "Get detailed Hacker News story information including comments.",
    inputSchema: {
      type: "object",
      properties: {
        story_id: { type: "integer", description: "Hacker News story id" },
      },
      required: ["story_id"],
    },
  },
];

function initializationResult() {
  return {
    protocolVersion: "2024-11-05",
    capabilities: { tools: {} },
    serverInfo: {
      name: "mcp-hn",
      version: "1.0.0",
    },
  };
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

async function handleToolCall(name, args) {
  if (name === "get_stories") {
    return makeTextResult(await getStories(args.story_type ?? "top", Number(args.num_stories ?? DEFAULT_NUM_STORIES)));
  }
  if (name === "get_user_info") {
    return makeTextResult(await getUserInfo(args.user_name, Number(args.num_stories ?? DEFAULT_NUM_STORIES)));
  }
  if (name === "search_stories") {
    return makeTextResult(await searchStories(args.query, Number(args.num_results ?? DEFAULT_NUM_STORIES), Boolean(args.search_by_date ?? false)));
  }
  if (name === "get_story_info") {
    return makeTextResult(await getStoryInfo(args.story_id));
  }
  throw new Error(`Unknown tool: ${name}`);
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
    return jsonRpcResult(id, { tools: TOOL_DEFINITIONS });
  }
  if (message.method !== "tools/call") {
    return jsonRpcError(id, -32601, `Method not found: ${message.method}`);
  }

  return jsonRpcResult(id, await handleToolCall(message.params?.name, message.params?.arguments ?? {}));
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
      const text = error instanceof Error ? error.message : String(error);
      writeMessage(jsonRpcError(message.id ?? null, -32603, text));
    }
  }
});
