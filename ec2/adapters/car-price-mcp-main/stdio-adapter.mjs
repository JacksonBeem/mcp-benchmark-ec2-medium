const BASE_URL = "https://parallelum.com.br/fipe/api/v1";

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function fetchJson(pathname) {
  const response = await fetch(`${BASE_URL}${pathname}`);
  if (!response.ok) {
    throw new Error(`Could not fetch data (Status: ${response.status})`);
  }
  return response.json();
}

async function getCarBrands() {
  try {
    const brands = await fetchJson("/carros/marcas");
    if (!Array.isArray(brands) || brands.length === 0) {
      return "No car brands found";
    }

    let result = "Car Brands Available\n\n";
    const grouped = {};
    for (const brand of brands) {
      const firstLetter = String(brand?.nome ?? "?").charAt(0).toUpperCase();
      grouped[firstLetter] ||= [];
      grouped[firstLetter].push(brand);
    }

    let count = 0;
    for (const letter of Object.keys(grouped).sort()) {
      if (count >= 20) {
        break;
      }
      result += `${letter}:\n`;
      for (const brand of grouped[letter].slice(0, 5)) {
        if (count >= 20) {
          break;
        }
        result += `  - ${brand.nome} (Code: ${brand.codigo})\n`;
        count += 1;
      }
      result += "\n";
    }

    result += `Total: ${brands.length} brands available\n`;
    result += "Use search_car_price with brand name to get models and prices";
    return result;
  } catch (error) {
    return `Error fetching car brands: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function searchCarPrice(query) {
  try {
    const brands = await fetchJson("/carros/marcas");
    const foundBrand = brands.find((brand) =>
      String(brand?.nome ?? "").toLowerCase().includes(String(query).toLowerCase()),
    );

    if (!foundBrand) {
      return `Brand '${query}' not found. Available brands include: ${brands.slice(0, 10).map((brand) => brand.nome).join(", ")}...`;
    }

    const modelsData = await fetchJson(`/carros/marcas/${foundBrand.codigo}/modelos`);
    const models = modelsData?.modelos ?? [];
    if (models.length === 0) {
      return `No models found for ${foundBrand.nome}`;
    }

    let result = `${foundBrand.nome} Models & Prices\n\n`;
    for (const [index, model] of models.slice(0, 3).entries()) {
      try {
        const years = await fetchJson(`/carros/marcas/${foundBrand.codigo}/modelos/${model.codigo}/anos`);
        if (!Array.isArray(years) || years.length === 0) {
          result += `${index + 1}. ${model.nome} - No years available\n\n`;
          continue;
        }

        const latestYear = years[0];
        const priceData = await fetchJson(`/carros/marcas/${foundBrand.codigo}/modelos/${model.codigo}/anos/${latestYear.codigo}`);
        result += `${index + 1}. ${model.nome}\n`;
        result += `Year: ${priceData?.AnoModelo ?? "N/A"}\n`;
        result += `Fuel: ${priceData?.Combustivel ?? "N/A"}\n`;
        result += `Price: ${priceData?.Valor ?? "N/A"}\n`;
        result += `Reference: ${priceData?.MesReferencia ?? "N/A"}\n`;
        result += `FIPE Code: ${priceData?.CodigoFipe ?? "N/A"}\n\n`;
      } catch (error) {
        result += `${index + 1}. ${model.nome} - Error: ${error instanceof Error ? error.message : String(error)}\n\n`;
      }
    }

    if (models.length > 3) {
      result += `...and ${models.length - 3} more models available\n`;
    }
    result += `\nTotal Models: ${models.length}\n`;
    result += "Prices are from FIPE (Brazilian vehicle price reference)";
    return result;
  } catch (error) {
    return `Error searching for '${query}': ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function getVehiclesByType(vehicleType) {
  try {
    const mapping = {
      car: "carros",
      cars: "carros",
      carro: "carros",
      carros: "carros",
      motorcycle: "motos",
      motorcycles: "motos",
      moto: "motos",
      motos: "motos",
      truck: "caminhoes",
      trucks: "caminhoes",
      caminhao: "caminhoes",
      caminhoes: "caminhoes",
    };

    const input = String(vehicleType || "carros").toLowerCase();
    const apiType = mapping[input] ?? "carros";
    const brands = await fetchJson(`/${apiType}/marcas`);
    if (!Array.isArray(brands) || brands.length === 0) {
      return `No ${vehicleType} brands found`;
    }

    let result = `${vehicleType || "carros"} Brands\n\n`;
    for (const [index, brand] of brands.slice(0, 15).entries()) {
      result += `${index + 1}. ${brand.nome} (Code: ${brand.codigo})\n`;
    }
    if (brands.length > 15) {
      result += `\n...and ${brands.length - 15} more brands\n`;
    }
    result += `\nTotal Brands: ${brands.length}\n`;
    result += "Use search_car_price with brand name to get specific models and prices";
    return result;
  } catch (error) {
    return `Error fetching ${vehicleType} brands: ${error instanceof Error ? error.message : String(error)}`;
  }
}

const TOOLS = [
  {
    name: "get_car_brands",
    description: "Get all available car brands from FIPE API.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "search_car_price",
    description: "Search for car models and prices by brand name.",
    inputSchema: {
      type: "object",
      properties: {
        brand_name: { type: "string", description: "The car brand name to search for." },
      },
      required: ["brand_name"],
    },
  },
  {
    name: "get_vehicles_by_type",
    description: "Get vehicles by type (cars, motorcycles, trucks).",
    inputSchema: {
      type: "object",
      properties: {
        vehicle_type: { type: "string", description: "carros, motos, caminhoes, cars, motorcycles, or trucks." },
      },
    },
  },
];

function initializationResult() {
  return {
    protocolVersion: "2024-11-05",
    capabilities: { tools: {} },
    serverInfo: {
      name: "car-price-mcp",
      version: "1.0.0",
    },
  };
}

function makeTextResult(payload) {
  return {
    content: [
      {
        type: "text",
        text: String(payload),
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

  if (name === "get_car_brands") {
    return jsonRpcResult(id, makeTextResult(await getCarBrands()));
  }
  if (name === "search_car_price") {
    if (!args.brand_name) {
      throw new Error("Missing required argument: brand_name");
    }
    return jsonRpcResult(id, makeTextResult(await searchCarPrice(String(args.brand_name))));
  }
  if (name === "get_vehicles_by_type") {
    return jsonRpcResult(id, makeTextResult(await getVehiclesByType(String(args.vehicle_type ?? "carros"))));
  }

  return jsonRpcError(id, -32601, `Unknown tool: ${name}`);
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
