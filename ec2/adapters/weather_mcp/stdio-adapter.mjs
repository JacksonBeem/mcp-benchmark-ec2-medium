const API_KEY = process.env.WEATHER_API_KEY || "366fd563131a4af1bd962603252105";
const BASE_URL = "http://api.weatherapi.com/v1";

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function fetchWeatherJson(pathname, params) {
  const url = new URL(`${BASE_URL}/${pathname}`);
  url.searchParams.set("key", API_KEY);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`API request failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function getCurrentWeather(city) {
  const data = await fetchWeatherJson("current.json", { q: city, lang: "tr" });
  return {
    city: data?.location?.name,
    country: data?.location?.country,
    region: data?.location?.region,
    weather: data?.current?.condition?.text,
    temperature_c: data?.current?.temp_c,
    temperature_f: data?.current?.temp_f,
    feelslike_c: data?.current?.feelslike_c,
    feelslike_f: data?.current?.feelslike_f,
    humidity: data?.current?.humidity,
    wind_kph: data?.current?.wind_kph,
    wind_mph: data?.current?.wind_mph,
    wind_dir: data?.current?.wind_dir,
    pressure_mb: data?.current?.pressure_mb,
    visibility_km: data?.current?.vis_km,
    uv_index: data?.current?.uv,
    icon: data?.current?.condition?.icon,
    last_updated: data?.current?.last_updated,
  };
}

async function getWeatherForecast(city, days = 3) {
  if (days < 1 || days > 10) {
    return { error: "Days must be between 1 and 10" };
  }

  const data = await fetchWeatherJson("forecast.json", { q: city, days, lang: "tr" });
  const forecast = (data?.forecast?.forecastday || []).map((day) => ({
    date: day?.date,
    max_temp_c: day?.day?.maxtemp_c,
    min_temp_c: day?.day?.mintemp_c,
    max_temp_f: day?.day?.maxtemp_f,
    min_temp_f: day?.day?.mintemp_f,
    condition: day?.day?.condition?.text,
    icon: day?.day?.condition?.icon,
    chance_of_rain: day?.day?.daily_chance_of_rain,
    chance_of_snow: day?.day?.daily_chance_of_snow,
    max_wind_kph: day?.day?.maxwind_kph,
    avg_humidity: day?.day?.avghumidity,
    uv_index: day?.day?.uv,
  }));

  return {
    city: data?.location?.name,
    country: data?.location?.country,
    region: data?.location?.region,
    forecast,
  };
}

async function searchLocations(query) {
  const data = await fetchWeatherJson("search.json", { q: query });
  return {
    locations: (data || []).map((location) => ({
      name: location?.name,
      region: location?.region,
      country: location?.country,
      lat: location?.lat,
      lon: location?.lon,
      url: location?.url,
    })),
  };
}

const TOOL_DEFINITIONS = [
  {
    name: "get_current_weather_tool",
    description: "Get current weather information for a specific city.",
    inputSchema: {
      type: "object",
      properties: {
        city: { type: "string", description: "Name of the city to get weather for." },
      },
      required: ["city"],
    },
  },
  {
    name: "get_weather_forecast_tool",
    description: "Get weather forecast for a specific city.",
    inputSchema: {
      type: "object",
      properties: {
        city: { type: "string", description: "Name of the city to get forecast for." },
        days: { type: "integer", description: "Number of days to forecast (1-10)." },
      },
      required: ["city"],
    },
  },
  {
    name: "search_locations_tool",
    description: "Search for locations by name.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Location name or partial name to search for." },
      },
      required: ["query"],
    },
  },
  {
    name: "get_live_temp",
    description: "Legacy tool for current weather lookup.",
    inputSchema: {
      type: "object",
      properties: {
        city: { type: "string", description: "Name of the city to get weather for." },
      },
      required: ["city"],
    },
  },
];

function initializationResult() {
  return {
    protocolVersion: "2024-11-05",
    capabilities: { tools: {} },
    serverInfo: {
      name: "weather-api-mcp",
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
  if (name === "get_current_weather_tool" || name === "get_live_temp") {
    if (!args.city) {
      throw new Error("Missing required argument: city");
    }
    return makeTextResult(await getCurrentWeather(String(args.city)));
  }
  if (name === "get_weather_forecast_tool") {
    if (!args.city) {
      throw new Error("Missing required argument: city");
    }
    return makeTextResult(await getWeatherForecast(String(args.city), Number(args.days ?? 3)));
  }
  if (name === "search_locations_tool") {
    if (!args.query) {
      throw new Error("Missing required argument: query");
    }
    return makeTextResult(await searchLocations(String(args.query)));
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

  return jsonRpcResult(
    id,
    await handleToolCall(message.params?.name, message.params?.arguments ?? {}),
  );
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
