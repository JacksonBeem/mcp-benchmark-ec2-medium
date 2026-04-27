import { createHash, randomInt } from "crypto";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ICHING_PATH = path.join(__dirname, "iching.py");

function loadHexagrams() {
  const source = readFileSync(ICHING_PATH, "utf8");
  const entryRegex =
    /(\d+):\s*\{\s*"name":\s*"([^"]+)",\s*"binary":\s*"([^"]+)",\s*"interpretation":\s*"([^"]*)"\s*\}/g;
  const hexagrams = new Map();

  for (const match of source.matchAll(entryRegex)) {
    const [, num, name, binary, interpretation] = match;
    hexagrams.set(Number(num), {
      number: Number(num),
      name,
      binary,
      interpretation,
    });
  }

  if (hexagrams.size === 0) {
    throw new Error("Failed to load hexagram database from iching.py");
  }

  return hexagrams;
}

const HEXAGRAMS = loadHexagrams();

const ETHICAL_DISCLAIMER =
  "Important Notice: This divination uses randomness, not supernatural guidance. It is for philosophical reflection and entertainment only.";

const TOOLS = [
  {
    name: "i_ching_divination",
    description: "Generate an I Ching divination for philosophical reflection.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Optional question to reflect on with the divination.",
        },
      },
    },
  },
  {
    name: "bibliomantic_consultation",
    description: "Perform a bibliomantic consultation using I Ching framing.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Question for consultation.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_hexagram_details",
    description: "Get details for a specific I Ching hexagram.",
    inputSchema: {
      type: "object",
      properties: {
        hexagram_number: {
          type: "integer",
          description: "Hexagram number from 1 to 64.",
        },
      },
      required: ["hexagram_number"],
    },
  },
  {
    name: "server_statistics",
    description: "Get system information and capabilities.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

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
      name: "bibliomantic-mcp-server",
      version: "1.0.0",
    },
  };
}

function makeTextResult(text) {
  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
  };
}

function getHexagram(number) {
  const hexagram = HEXAGRAMS.get(Number(number));
  if (!hexagram) {
    throw new Error("Please provide a valid hexagram number between 1 and 64.");
  }
  return hexagram;
}

function inferContext(query) {
  const text = String(query || "").toLowerCase();
  if (/(career|job|work|profession|hiring|interview)/.test(text)) return "career";
  if (/(relationship|love|partner|dating|marriage)/.test(text)) return "relationships";
  if (/(create|creative|art|writing|project|design)/.test(text)) return "creative";
  if (/(business|startup|market|company|sales|product)/.test(text)) return "business";
  return "general";
}

function contextualGuidance(hexagram, query) {
  const context = inferContext(query);
  switch (context) {
    case "career":
      return `Career perspective: ${hexagram.interpretation}`;
    case "relationships":
      return `Relationship perspective: ${hexagram.interpretation}`;
    case "creative":
      return `Creative perspective: ${hexagram.interpretation}`;
    case "business":
      return `Business perspective: ${hexagram.interpretation}`;
    default:
      return `Guidance: ${hexagram.interpretation}`;
  }
}

function chooseHexagram(query) {
  if (query && String(query).trim()) {
    const hash = createHash("sha256").update(String(query)).digest("hex");
    const value = parseInt(hash.slice(0, 8), 16);
    return 1 + (value % 64);
  }
  return randomInt(1, 65);
}

function iChingDivination(query) {
  const hexagram = getHexagram(chooseHexagram(query));
  let response = `🎋 **I Ching Divination**\n\n`;
  response += `**Hexagram ${hexagram.number}: ${hexagram.name}**\n\n`;
  response += `${hexagram.interpretation}\n\n`;
  response += `**Method:** Traditional three-coin inspired selection\n`;
  response += `**Purpose:** Philosophical reflection and contemplation\n\n`;
  response += `${ETHICAL_DISCLAIMER}`;
  if (query) {
    response += `\n\n**Your Question:** ${query}`;
    response += `\n\n**Contextual Guidance:** ${contextualGuidance(hexagram, query)}`;
  }
  return response;
}

function bibliomanticConsultation(query) {
  if (!query || !String(query).trim()) {
    return "Please provide a question for bibliomantic consultation.";
  }

  const hexagram = getHexagram(chooseHexagram(query));
  let response = `🔮 **Bibliomantic Consultation**\n\n`;
  response += `**Your Question:** ${query}\n\n`;
  response += `**Oracle's Guidance - Hexagram ${hexagram.number}: ${hexagram.name}**\n\n`;
  response += `${hexagram.interpretation}\n\n`;
  response += `**Bibliomantic Context:**\n`;
  response += `This consultation follows the reflective approach described in Philip K. Dick's "The Man in the High Castle," using I Ching patterns for contemplation.\n\n`;
  response += `**How to Use This Guidance:**\n`;
  response += `Consider how this perspective might reframe your situation. The value is in reflection and fresh viewpoint, not prediction.\n\n`;
  response += `${ETHICAL_DISCLAIMER}`;
  return response;
}

function getHexagramDetails(hexagramNumber) {
  const hexagram = getHexagram(hexagramNumber);
  return `📖 **Hexagram ${hexagram.number}: ${hexagram.name}**\n\n` +
    `**Traditional Interpretation:**\n${hexagram.interpretation}\n\n` +
    `**Binary Pattern:** ${hexagram.binary}\n\n` +
    `**Historical Context:**\nThe I Ching is an ancient Chinese philosophical text used for contemplating patterns of change.\n\n` +
    `${ETHICAL_DISCLAIMER}`;
}

function serverStatistics() {
  return `📊 **Bibliomantic Server Statistics**\n\n` +
    `**System Status:** Operational\n` +
    `**Total Hexagrams:** ${HEXAGRAMS.size}\n` +
    `**Divination Method:** I Ching hexagram reflection\n` +
    `**Randomness Source:** Node.js crypto\n` +
    `**Bibliomantic Approach:** Philip K. Dick inspired reflective oracle\n\n` +
    `**Server Capabilities:**\n` +
    `- I Ching divination\n` +
    `- Bibliomantic consultation\n` +
    `- Hexagram details\n` +
    `- Server statistics`;
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
  switch (name) {
    case "i_ching_divination":
      return jsonRpcResult(id, makeTextResult(iChingDivination(args.query)));
    case "bibliomantic_consultation":
      return jsonRpcResult(id, makeTextResult(bibliomanticConsultation(args.query)));
    case "get_hexagram_details":
      return jsonRpcResult(id, makeTextResult(getHexagramDetails(args.hexagram_number)));
    case "server_statistics":
      return jsonRpcResult(id, makeTextResult(serverStatistics()));
    default:
      return jsonRpcError(id, -32601, `Unknown tool: ${name}`);
  }
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
