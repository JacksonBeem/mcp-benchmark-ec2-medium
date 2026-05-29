const NIXOS_API = "https://search.nixos.org/backend";
const NIXOS_AUTH = "Basic " + Buffer.from("aWVSALXpZv:X8gPHnzL52wFEekuxsfQ9cSh").toString("base64");
const NIXHUB_API = "https://search.devbox.sh";
const CACHE_NIXOS_ORG = "https://cache.nixos.org";
const HOME_MANAGER_URL = "https://nix-community.github.io/home-manager/options.xhtml";
const DARWIN_URL = "https://nix-darwin.github.io/nix-darwin/manual/index.html";
const CHANNELS = {
  unstable: "latest-44-nixos-unstable",
  stable: "latest-44-nixos-25.11",
  "25.05": "latest-44-nixos-25.05",
  "25.11": "latest-44-nixos-25.11",
  beta: "latest-44-nixos-25.11",
};

const TOOLS = [
  {
    name: "nix",
    description: "Query NixOS, channels, and NixHub package data.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "search|info|stats|channels|cache|options|flake-inputs" },
        query: { type: "string", description: "Search term or package/option name." },
        source: { type: "string", description: "nixos|nixhub|home-manager|darwin", default: "nixos" },
        type: { type: "string", description: "packages|options|programs|package|option", default: "packages" },
        channel: { type: "string", description: "unstable|stable|25.05|25.11|beta", default: "unstable" },
        limit: { type: "integer", description: "1-100", default: 20 },
        version: { type: "string", description: "Version for cache action.", default: "latest" },
        system: { type: "string", description: "System for cache action.", default: "" },
      },
      required: ["action"],
    },
  },
  {
    name: "nix_versions",
    description: "Get package version history from NixHub.io.",
    inputSchema: {
      type: "object",
      properties: {
        package: { type: "string", description: "Package name." },
        version: { type: "string", description: "Specific version to find.", default: "" },
        limit: { type: "integer", description: "1-50", default: 10 },
      },
      required: ["package"],
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
      name: "mcp-nixos",
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

function error(message) {
  return `ERROR: ${message}`;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }
  return response.json();
}

async function fetchText(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }
  return response.text();
}

async function postJson(url, body, options = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: NIXOS_AUTH,
      ...(options.headers ?? {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }
  return response.json();
}

function stripHtml(text) {
  return String(text ?? "")
    .replace(/<rendered-html>/g, "")
    .replace(/<\/rendered-html>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseHtmlOptions(html, query = "", prefix = "", limit = 100, homeManager = false) {
  const dtRegex = /<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi;
  const options = [];
  for (const match of html.matchAll(dtRegex)) {
    const dt = match[1];
    const dd = match[2];
    let name = stripHtml(dt);
    if (homeManager) {
      const idMatch = dt.match(/id="opt-([^"]+)"/i);
      if (idMatch) {
        name = idMatch[1].replace(/_name_/g, "<name>");
      }
    }
    if (!name) continue;
    if (query && !name.toLowerCase().includes(query.toLowerCase())) continue;
    if (prefix && !(name.startsWith(`${prefix}.`) || name === prefix)) continue;
    const typeMatch = dd.match(/Type:\s*([^<\n]+)/i);
    const desc = stripHtml(dd).slice(0, 200);
    options.push({ name, description: desc, type: typeMatch ? stripHtml(typeMatch[1]) : "" });
    if (options.length >= limit) break;
  }
  return options;
}

async function esQuery(index, query, size = 20) {
  const url = `${NIXOS_API}/${index}/_search`;
  const data = await postJson(url, { query, size });
  return data?.hits?.hits ?? [];
}

async function searchNixos(query, searchType, limit, channel) {
  const index = CHANNELS[channel];
  if (!index) {
    return error(`Invalid channel '${channel}'. Available: ${Object.keys(CHANNELS).join(", ")}`);
  }

  let esBody;
  if (searchType === "packages") {
    esBody = {
      bool: {
        must: [{ term: { type: "package" } }],
        should: [
          { match: { package_pname: { query, boost: 3 } } },
          { match: { package_description: query } },
        ],
        minimum_should_match: 1,
      },
    };
  } else if (searchType === "options") {
    esBody = {
      bool: {
        must: [{ term: { type: "option" } }],
        should: [
          { wildcard: { option_name: `*${query}*` } },
          { match: { option_description: query } },
        ],
        minimum_should_match: 1,
      },
    };
  } else if (searchType === "programs") {
    esBody = {
      bool: {
        must: [{ term: { type: "package" } }],
        should: [
          { match: { package_programs: { query, boost: 2 } } },
          { match: { package_pname: query } },
        ],
        minimum_should_match: 1,
      },
    };
  } else {
    return error("Type must be packages|options|programs");
  }

  const hits = await esQuery(index, esBody, limit);
  if (!hits.length) {
    return `No ${searchType} found matching '${query}'`;
  }

  const lines = [`Found ${hits.length} ${searchType} matching '${query}':`, ""];
  for (const hit of hits) {
    const src = hit._source ?? {};
    if (searchType === "packages") {
      lines.push(`* ${src.package_pname ?? ""} (${src.package_pversion ?? ""})`);
      if (src.package_description) lines.push(`  ${src.package_description}`);
      lines.push("");
    } else if (searchType === "options") {
      lines.push(`* ${src.option_name ?? ""}`);
      if (src.option_type) lines.push(`  Type: ${src.option_type}`);
      if (src.option_description) lines.push(`  ${stripHtml(src.option_description)}`);
      lines.push("");
    } else {
      const programs = src.package_programs ?? [];
      const pkgName = src.package_pname ?? "";
      for (const program of programs.filter((p) => String(p).toLowerCase() === query.toLowerCase())) {
        lines.push(`* ${program} (provided by ${pkgName})`);
        lines.push("");
      }
    }
  }
  return lines.join("\n").trim();
}

async function infoNixos(name, infoType, channel) {
  const index = CHANNELS[channel];
  if (!index) {
    return error(`Invalid channel '${channel}'. Available: ${Object.keys(CHANNELS).join(", ")}`);
  }

  const field = infoType === "package" ? "package_pname" : "option_name";
  const query = { bool: { must: [{ term: { type: infoType } }, { term: { [field]: name } }] } };
  const hits = await esQuery(index, query, 1);
  if (!hits.length) {
    return error(`${infoType} '${name}' not found`);
  }

  const src = hits[0]._source ?? {};
  if (infoType === "package") {
    const lines = [
      `Package: ${src.package_pname ?? ""}`,
      `Version: ${src.package_pversion ?? ""}`,
    ];
    if (src.package_description) lines.push(`Description: ${src.package_description}`);
    if (Array.isArray(src.package_homepage) && src.package_homepage[0]) lines.push(`Homepage: ${src.package_homepage[0]}`);
    if (Array.isArray(src.package_license_set) && src.package_license_set.length) {
      lines.push(`License: ${src.package_license_set.join(", ")}`);
    }
    return lines.join("\n");
  }

  const lines = [`Option: ${src.option_name ?? ""}`];
  if (src.option_type) lines.push(`Type: ${src.option_type}`);
  if (src.option_description) lines.push(`Description: ${stripHtml(src.option_description)}`);
  if (src.option_default) lines.push(`Default: ${src.option_default}`);
  if (src.option_example) lines.push(`Example: ${src.option_example}`);
  return lines.join("\n");
}

async function statsNixos(channel) {
  const index = CHANNELS[channel];
  if (!index) {
    return error(`Invalid channel '${channel}'. Available: ${Object.keys(CHANNELS).join(", ")}`);
  }
  const url = `${NIXOS_API}/${index}/_count`;
  const pkg = await postJson(url, { query: { term: { type: "package" } } });
  const opt = await postJson(url, { query: { term: { type: "option" } } });
  return `NixOS Statistics (${channel}):\n* Packages: ${(pkg.count ?? 0).toLocaleString()}\n* Options: ${(opt.count ?? 0).toLocaleString()}`;
}

function listChannels() {
  return `NixOS Channels:\n\n${Object.entries(CHANNELS).map(([name, index]) => `* ${name} -> ${index}`).join("\n")}`;
}

async function searchNixhub(query, limit) {
  const url = new URL(`${NIXHUB_API}/v2/search`);
  url.searchParams.set("q", query);
  const data = await fetchJson(url);
  const packages = (data.results ?? []).slice(0, limit);
  if (!packages.length) {
    return `No packages found on NixHub matching '${query}'`;
  }
  const lines = [`Found ${packages.length} of ${data.total_results ?? packages.length} packages on NixHub matching '${query}':`, ""];
  for (const pkg of packages) {
    lines.push(`* ${pkg.name ?? ""}`);
    if (pkg.version) lines.push(`  Version: ${pkg.version}`);
    if (pkg.summary || pkg.description) lines.push(`  ${(pkg.summary || pkg.description).slice(0, 200)}`);
    lines.push("");
  }
  return lines.join("\n").trim();
}

async function infoNixhub(name) {
  const url = new URL(`${NIXHUB_API}/v1/pkg`);
  url.searchParams.set("name", name);
  const releases = await fetchJson(url);
  if (!Array.isArray(releases) || !releases.length) {
    return error(`Package '${name}' not found`);
  }
  const latest = releases[0];
  const lines = [`Package: ${latest.name ?? name}`];
  if (latest.version) lines.push(`Version: ${latest.version}`);
  if (latest.license) lines.push(`License: ${latest.license}`);
  if (latest.homepage) lines.push(`Homepage: ${latest.homepage}`);
  if (latest.summary) lines.push(`Summary: ${latest.summary}`);
  if (latest.description && latest.description !== latest.summary) {
    lines.push(`Description: ${String(latest.description).slice(0, 500)}`);
  }
  return lines.join("\n");
}

async function resolveNixhub(name, version = "latest") {
  const url = new URL(`${NIXHUB_API}/v2/resolve`);
  url.searchParams.set("name", name);
  url.searchParams.set("version", version || "latest");
  return fetchJson(url);
}

async function cacheStatus(name, version = "latest", system = "") {
  const data = await resolveNixhub(name, version);
  const systemsData = data.systems ?? {};
  const selected = Object.entries(systemsData).filter(([sys]) => !system || sys === system);
  if (!selected.length) {
    return error(system ? `System '${system}' not available` : `No systems found for ${name}`);
  }
  const lines = [`Binary Cache Status: ${data.name ?? name}@${data.version ?? version}`, ""];
  for (const [sys, info] of selected) {
    const outputs = info.outputs ?? [];
    const output = outputs.find((o) => o.default) || outputs[0];
    const storePath = output?.path ?? "";
    lines.push(`System: ${sys}`);
    lines.push(`  Store path: ${storePath || "Not available"}`);
    if (!storePath) {
      lines.push("  Status: UNKNOWN", "");
      continue;
    }
    const storeHash = storePath.split("/")[3]?.split("-")[0] ?? "";
    if (!storeHash || storeHash.length !== 32) {
      lines.push("  Status: UNKNOWN (invalid store path)", "");
      continue;
    }
    const head = await fetch(`${CACHE_NIXOS_ORG}/${storeHash}.narinfo`, { method: "HEAD" });
    if (head.status === 200) lines.push("  Status: CACHED");
    else if (head.status === 404) lines.push("  Status: NOT CACHED");
    else lines.push(`  Status: UNKNOWN (HTTP ${head.status})`);
    lines.push("");
  }
  return lines.join("\n").trim();
}

async function browseOptions(source, prefix) {
  const url = source === "home-manager" ? HOME_MANAGER_URL : DARWIN_URL;
  const html = await fetchText(url);
  if (prefix) {
    const options = parseHtmlOptions(html, "", prefix, 200, source === "home-manager");
    if (!options.length) return `No ${source} options found with prefix '${prefix}'`;
    return `${source} options with prefix '${prefix}' (${options.length} found):\n\n${options.map((opt) => `* ${opt.name}${opt.type ? `\n  Type: ${opt.type}` : ""}${opt.description ? `\n  ${opt.description}` : ""}`).join("\n\n")}`;
  }
  const options = parseHtmlOptions(html, "", "", 5000, source === "home-manager");
  const counts = {};
  for (const opt of options) {
    const cat = opt.name.split(".")[0];
    if (cat && opt.name.includes(".")) counts[cat] = (counts[cat] || 0) + 1;
  }
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 100);
  return `${source} categories (${entries.length} shown):\n\n${entries.map(([cat, count]) => `* ${cat} (${count} options)`).join("\n")}`;
}

async function nixVersions(pkg, version = "", limit = 10) {
  const url = new URL(`${NIXHUB_API}/v1/pkg`);
  url.searchParams.set("name", pkg);
  const releases = await fetchJson(url);
  if (!Array.isArray(releases) || !releases.length) {
    return error(`Package '${pkg}' not found`);
  }

  if (version) {
    const found = releases.find((release) => release.version === version);
    if (!found) {
      return `Version ${version} not found for ${pkg}\nAvailable: ${releases.slice(0, limit).map((r) => r.version).join(", ")}`;
    }
    const lines = [`Found ${pkg} version ${version}`, ""];
    if (found.commit_hash) lines.push(`Nixpkgs commit: ${found.commit_hash}`);
    return lines.join("\n");
  }

  const lines = [`Package: ${pkg}`];
  if (releases[0].license) lines.push(`License: ${releases[0].license}`);
  if (releases[0].homepage) lines.push(`Homepage: ${releases[0].homepage}`);
  lines.push("", `Recent versions (${Math.min(limit, releases.length)}):`, "");
  for (const release of releases.slice(0, limit)) {
    lines.push(`* ${release.version ?? "unknown"}`);
    if (release.commit_hash) lines.push(`  Commit: ${release.commit_hash}`);
    lines.push("");
  }
  return lines.join("\n").trim();
}

async function handleNix(args) {
  const action = String(args.action ?? "");
  const query = String(args.query ?? "");
  const source = String(args.source ?? "nixos");
  const type = String(args.type ?? "packages");
  const channel = String(args.channel ?? "unstable");
  const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);

  if (action === "channels") {
    return listChannels();
  }

  if (!["nixos", "nixhub", "home-manager", "darwin"].includes(source)) {
    return error("This adapter currently supports source=nixos|nixhub|home-manager|darwin");
  }

  if (action === "search") {
    if (!query) return error("Query required for search");
    return source === "nixhub"
      ? searchNixhub(query, limit)
      : searchNixos(query, type, limit, channel);
  }
  if (action === "info") {
    if (!query) return error("Name required for info");
    return source === "nixhub"
      ? infoNixhub(query)
      : infoNixos(query, type === "option" || type === "options" ? "option" : "package", channel);
  }
  if (action === "stats") {
    if (source !== "nixos") return error("Stats currently supported only for source=nixos");
    return statsNixos(channel);
  }
  if (action === "options") {
    if (!["home-manager", "darwin"].includes(source)) return error("Options currently supported only for source=home-manager|darwin");
    return browseOptions(source, query);
  }
  if (action === "cache") {
    if (source !== "nixhub" && source !== "nixos") return error("Cache currently supported only for source=nixos|nixhub");
    if (!query) return error("Package name required for cache action");
    return cacheStatus(query, String(args.version ?? "latest"), String(args.system ?? ""));
  }

  return error("This adapter currently supports actions search|info|stats|channels|options|cache");
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
  if (name === "nix") {
    return jsonRpcResult(id, makeTextResult(await handleNix(args)));
  }
  if (name === "nix_versions") {
    if (!args.package) {
      throw new Error("Package name required");
    }
    return jsonRpcResult(id, makeTextResult(await nixVersions(String(args.package), String(args.version ?? ""), Number(args.limit) || 10)));
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
