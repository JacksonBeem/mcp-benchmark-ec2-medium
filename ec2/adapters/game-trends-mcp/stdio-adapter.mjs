const STEAM_STORE_SEARCH = "https://store.steampowered.com/search/results/";
const STEAM_CHARTS_MOST_PLAYED = "https://store.steampowered.com/charts/mostplayed";
const EPIC_FREE_GAMES_API = "https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions";
const USER_AGENT = "mcp-benchmark-game-trends-adapter/1.0";

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
      name: "game-trends-mcp",
      version: "1.0.0",
    },
  };
}

function makeTool(name, description) {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties: {},
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

async function fetchJson(url, params = {}) {
  const target = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      target.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(target, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Request failed with status ${response.status}: ${body.slice(0, 240)}`);
  }
  return response.json();
}

async function fetchText(url, params = {}) {
  const target = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      target.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(target, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Request failed with status ${response.status}: ${body.slice(0, 240)}`);
  }
  return response.text();
}

function decodeHtml(text) {
  return String(text || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseSteamSearchResults(html, category, limit = 10) {
  const rows = [...html.matchAll(/<a[^>]*class="search_result_row[^"]*"[\s\S]*?<\/a>/g)]
    .map((match) => match[0])
    .slice(0, limit);

  return rows.map((row) => {
    const href = row.match(/href="([^"]+)"/i)?.[1] || "";
    const appId = row.match(/data-ds-appid="([^"]+)"/i)?.[1] || href.match(/\/app\/(\d+)/i)?.[1] || "";
    const title =
      decodeHtml(row.match(/<span class="title">([\s\S]*?)<\/span>/i)?.[1]) ||
      decodeHtml(row.match(/<div class="title">([\s\S]*?)<\/div>/i)?.[1]);
    const price = decodeHtml(row.match(/<div class="search_price[^"]*">([\s\S]*?)<\/div>/i)?.[1]) || "N/A";
    const image = row.match(/<img[^>]*src="([^"]+)"/i)?.[1] || "";

    return {
      id: appId,
      name: title,
      price,
      headerImage: image,
      platform: "Steam",
      category,
      isTrending: true,
      url: href,
    };
  }).filter((item) => item.name);
}

function parseSteamMostPlayed(html, limit = 10) {
  const apps = [...html.matchAll(/\/app\/(\d+)\/[^"]*"[^>]*>[\s\S]*?<div class="[_a-zA-Z0-9-]*AppName[_a-zA-Z0-9-]*">([\s\S]*?)<\/div>/g)]
    .slice(0, limit)
    .map((match) => ({
      id: match[1],
      name: decodeHtml(match[2]),
      platform: "Steam",
      category: "Most Played",
      isTrending: true,
      url: `https://store.steampowered.com/app/${match[1]}/`,
    }));

  return apps.filter((item) => item.name);
}

async function getSteamSearchCollection(filter, category) {
  const data = await fetchJson(STEAM_STORE_SEARCH, {
    query: "",
    start: 0,
    count: 10,
    dynamic_data: "",
    sort_by: "_ASC",
    supportedlang: "english",
    snr: "1_7_7_230_7",
    filter,
    infinite: 1,
  });

  return parseSteamSearchResults(data.results_html || "", category);
}

async function getSteamTrendingGames() {
  const games = await getSteamSearchCollection("popularnew", "Trending");
  return {
    success: true,
    platform: "Steam",
    type: "trending",
    count: games.length,
    games,
  };
}

async function getSteamTopSellers() {
  const games = await getSteamSearchCollection("topsellers", "Top Sellers");
  return {
    success: true,
    platform: "Steam",
    type: "top_sellers",
    count: games.length,
    games,
  };
}

async function getSteamMostPlayed() {
  let games = [];
  try {
    const html = await fetchText(STEAM_CHARTS_MOST_PLAYED, { l: "english" });
    games = parseSteamMostPlayed(html);
  } catch {
    games = [];
  }

  if (games.length === 0) {
    const fallback = await getSteamSearchCollection("topsellers", "Most Played (fallback)");
    games = fallback;
  }

  return {
    success: true,
    platform: "Steam",
    type: "most_played",
    count: games.length,
    games,
  };
}

async function fetchEpicPromotions() {
  const data = await fetchJson(EPIC_FREE_GAMES_API, {
    locale: "en-US",
    country: "US",
    allowCountries: "US",
  });
  return data.data?.Catalog?.searchStore?.elements || [];
}

function extractEpicOfferUrl(productSlug, fallbackSlug = "") {
  const slug = productSlug || fallbackSlug;
  return slug ? `https://store.epicgames.com/en-US/p/${slug}` : "";
}

function mapEpicGame(game, category) {
  const mappings = game.catalogNs?.mappings || [];
  const keyImages = game.keyImages || [];
  const currentOffer = game.promotions?.promotionalOffers?.[0]?.promotionalOffers?.[0];
  const upcomingOffer = game.promotions?.upcomingPromotionalOffers?.[0]?.promotionalOffers?.[0];
  const discountPrice = game.price?.totalPrice?.discountPrice;
  return {
    id: game.id || "",
    name: game.title || "",
    description: game.description || "",
    image: keyImages[0]?.url || "",
    price: typeof discountPrice === "number" ? `$${(discountPrice / 100).toFixed(2)}` : "N/A",
    original_price:
      typeof game.price?.totalPrice?.originalPrice === "number"
        ? `$${(game.price.totalPrice.originalPrice / 100).toFixed(2)}`
        : "N/A",
    discount: game.price?.totalPrice?.discount || 0,
    status: currentOffer ? "current" : upcomingOffer ? "upcoming" : "standard",
    promotion_start: currentOffer?.startDate || upcomingOffer?.startDate || null,
    promotion_end: currentOffer?.endDate || upcomingOffer?.endDate || null,
    platform: "Epic Games",
    category,
    isTrending: true,
    url: extractEpicOfferUrl(mappings[0]?.pageSlug, game.productSlug),
  };
}

async function getEpicFreeGames() {
  const elements = await fetchEpicPromotions();
  const games = elements
    .filter((game) => game.promotions?.promotionalOffers?.length || game.promotions?.upcomingPromotionalOffers?.length)
    .slice(0, 10)
    .map((game) => mapEpicGame(game, "Free Games"));

  return {
    success: true,
    platform: "Epic Games",
    type: "free_games",
    count: games.length,
    games,
  };
}

async function getEpicTrendingGames() {
  const elements = await fetchEpicPromotions();
  const games = elements
    .slice(0, 10)
    .map((game) => mapEpicGame(game, "Trending"));

  return {
    success: true,
    platform: "Epic Games",
    type: "trending",
    count: games.length,
    games,
  };
}

async function getAllTrendingGames() {
  const [steamTrending, steamTopSellers, steamMostPlayed, epicFreeGames, epicTrendingGames] = await Promise.all([
    getSteamTrendingGames(),
    getSteamTopSellers(),
    getSteamMostPlayed(),
    getEpicFreeGames(),
    getEpicTrendingGames(),
  ]);

  return {
    success: true,
    generated_at: new Date().toISOString(),
    platforms: {
      steam: {
        trending: steamTrending.games,
        top_sellers: steamTopSellers.games,
        most_played: steamMostPlayed.games,
      },
      epic_games: {
        free_games: epicFreeGames.games,
        trending: epicTrendingGames.games,
      },
    },
    totals: {
      steam_trending: steamTrending.games.length,
      steam_top_sellers: steamTopSellers.games.length,
      steam_most_played: steamMostPlayed.games.length,
      epic_free_games: epicFreeGames.games.length,
      epic_trending: epicTrendingGames.games.length,
    },
  };
}

async function getApiHealth() {
  const checks = {};
  try {
    await fetchText(STEAM_CHARTS_MOST_PLAYED, { l: "english" });
    checks.steam = "ok";
  } catch (error) {
    checks.steam = error instanceof Error ? error.message : String(error);
  }

  try {
    await fetchEpicPromotions();
    checks.epic = "ok";
  } catch (error) {
    checks.epic = error instanceof Error ? error.message : String(error);
  }

  return {
    status: Object.values(checks).every((value) => value === "ok") ? "healthy" : "degraded",
    timestamp: new Date().toISOString(),
    checks,
  };
}

const TOOLS = [
  makeTool("get_steam_trending_games", "Get trending games from Steam."),
  makeTool("get_steam_top_sellers", "Get current top sellers from Steam."),
  makeTool("get_steam_most_played", "Get the most played games on Steam."),
  makeTool("get_epic_free_games", "Get current and upcoming free games from Epic Games."),
  makeTool("get_epic_trending_games", "Get a current Epic Games storefront sample."),
  makeTool("get_all_trending_games", "Get combined game trend data from Steam and Epic Games."),
  makeTool("get_api_health", "Check the health of upstream game trend sources."),
];

async function handleToolCall(name) {
  if (name === "get_steam_trending_games") {
    return makeTextResult(await getSteamTrendingGames());
  }
  if (name === "get_steam_top_sellers") {
    return makeTextResult(await getSteamTopSellers());
  }
  if (name === "get_steam_most_played") {
    return makeTextResult(await getSteamMostPlayed());
  }
  if (name === "get_epic_free_games") {
    return makeTextResult(await getEpicFreeGames());
  }
  if (name === "get_epic_trending_games") {
    return makeTextResult(await getEpicTrendingGames());
  }
  if (name === "get_all_trending_games") {
    return makeTextResult(await getAllTrendingGames());
  }
  if (name === "get_api_health") {
    return makeTextResult(await getApiHealth());
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
    return jsonRpcResult(id, { tools: TOOLS });
  }
  if (message.method !== "tools/call") {
    return jsonRpcError(id, -32601, `Method not found: ${message.method}`);
  }
  return jsonRpcResult(id, await handleToolCall(message.params?.name));
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
