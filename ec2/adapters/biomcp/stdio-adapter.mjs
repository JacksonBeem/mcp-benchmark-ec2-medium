const CTG_STUDIES_API = "https://clinicaltrials.gov/api/v2/studies";
const USER_AGENT = "mcp-benchmark-biomcp-adapter/1.0";

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
      name: "biomcp",
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
    throw new Error(`ClinicalTrials.gov request failed with status ${response.status}: ${body.slice(0, 240)}`);
  }

  return response.json();
}

function summarizeStudy(study) {
  const protocol = study.protocolSection || {};
  const idModule = protocol.identificationModule || {};
  const statusModule = protocol.statusModule || {};
  const conditionsModule = protocol.conditionsModule || {};
  const armsModule = protocol.armsInterventionsModule || {};
  const contactsModule = protocol.contactsLocationsModule || {};
  const sponsorModule = protocol.sponsorCollaboratorsModule || {};

  return {
    nct_id: idModule.nctId || "",
    brief_title: idModule.briefTitle || "",
    official_title: idModule.officialTitle || "",
    status: statusModule.overallStatus || "",
    conditions: conditionsModule.conditions || [],
    interventions: (armsModule.interventions || []).map((item) => item.name).filter(Boolean),
    phase: (designPhases(protocol) || []),
    sponsor: sponsorModule.leadSponsor?.name || "",
    locations: (contactsModule.locations || []).slice(0, 5).map((location) => ({
      facility: location.facility || "",
      city: location.city || "",
      state: location.state || "",
      country: location.country || "",
      status: location.status || "",
    })),
    url: idModule.nctId ? `https://clinicaltrials.gov/study/${idModule.nctId}` : "",
  };
}

function designPhases(protocol) {
  return protocol.designModule?.phases || protocol.designModule?.phaseList || [];
}

function buildSearchParams(args) {
  const params = {
    format: "json",
    pageSize: Math.min(Math.max(Number(args.limit ?? 10) || 10, 1), 20),
    countTotal: "true",
  };

  const condition = args.condition || args.disease;
  const intervention = args.intervention || args.drug;
  const terms = [args.query, args.gene].filter(Boolean).join(" ").trim();

  if (condition) {
    params["query.cond"] = condition;
  }
  if (intervention) {
    params["query.intr"] = intervention;
  }
  if (terms) {
    params["query.term"] = terms;
  }
  if (args.status) {
    params["filter.overallStatus"] = args.status;
  }

  return params;
}

async function searchTrials(args) {
  const params = buildSearchParams(args);
  if (!params["query.cond"] && !params["query.intr"] && !params["query.term"]) {
    throw new Error("Provide at least one of query, condition, disease, gene, intervention, or drug");
  }

  const data = await fetchJson(CTG_STUDIES_API, params);
  const studies = (data.studies || []).map(summarizeStudy);

  return {
    query: args.query || "",
    condition: args.condition || args.disease || "",
    intervention: args.intervention || args.drug || "",
    gene: args.gene || "",
    status_filter: args.status || "",
    total_returned: studies.length,
    total_available: data.totalCount ?? null,
    studies,
  };
}

async function getTrial(args) {
  if (!args.nct_id) {
    throw new Error("nct_id is required");
  }
  const data = await fetchJson(`${CTG_STUDIES_API}/${encodeURIComponent(args.nct_id)}`, { format: "json" });
  return summarizeStudy(data);
}

const TOOLS = [
  makeTool(
    "search_trial",
    "Search clinical trials using BioMCP-style trial arguments.",
    {
      query: { type: "string", description: "General search text." },
      condition: { type: "string", description: "Condition or disease term." },
      disease: { type: "string", description: "Alias for condition." },
      gene: { type: "string", description: "Gene symbol to include in the general query." },
      intervention: { type: "string", description: "Intervention or treatment term." },
      drug: { type: "string", description: "Alias for intervention." },
      status: { type: "string", description: "Overall recruitment status filter." },
      limit: { type: "integer", description: "Maximum number of studies to return." },
    },
  ),
  makeTool(
    "search_trials",
    "Search clinical trials using BioMCP-style trial arguments.",
    {
      query: { type: "string", description: "General search text." },
      condition: { type: "string", description: "Condition or disease term." },
      disease: { type: "string", description: "Alias for condition." },
      gene: { type: "string", description: "Gene symbol to include in the general query." },
      intervention: { type: "string", description: "Intervention or treatment term." },
      drug: { type: "string", description: "Alias for intervention." },
      status: { type: "string", description: "Overall recruitment status filter." },
      limit: { type: "integer", description: "Maximum number of studies to return." },
    },
  ),
  makeTool(
    "get_trial",
    "Get a trial summary by NCT identifier.",
    {
      nct_id: { type: "string", description: "ClinicalTrials.gov NCT id such as NCT02576665." },
    },
    ["nct_id"],
  ),
];

async function handleToolCall(name, args) {
  if (name === "search_trial" || name === "search_trials") {
    return makeTextResult(await searchTrials(args));
  }
  if (name === "get_trial") {
    return makeTextResult(await getTrial(args));
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
