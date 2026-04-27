import { lookup, resolve4, resolve6, resolveMx, resolveNs, resolveTxt, resolveSoa, reverse } from "node:dns/promises";
import net from "node:net";

const USER_AGENT = "mcp-benchmark-osint-adapter/1.0";
const COMMON_PORTS = [21, 22, 25, 53, 80, 110, 143, 443, 465, 587, 993, 995, 1433, 3306, 3389, 5432, 6379, 8080, 8443];

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
      name: "mcp-osint-server",
      version: "1.0.0",
    },
  };
}

function makeTool(name, description, argName = "target") {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties: {
        [argName]: {
          type: "string",
          description: argName === "domain" ? "Domain name to inspect." : "Host, IP, or domain to inspect.",
        },
      },
      required: [argName],
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

function isIp(value) {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) || /^[0-9a-f:]+$/i.test(value);
}

function sanitizeHost(value) {
  return String(value).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
}

async function fetchJson(url) {
  const response = await fetch(url, {
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

async function safeResolve(fn) {
  try {
    return await fn();
  } catch {
    return [];
  }
}

async function rdapLookup(target) {
  const cleaned = sanitizeHost(target);
  const kind = isIp(cleaned) ? "ip" : "domain";
  const data = await fetchJson(`https://rdap.org/${kind}/${encodeURIComponent(cleaned)}`);
  return {
    target: cleaned,
    kind,
    handle: data.handle || "",
    ldhName: data.ldhName || data.name || "",
    status: data.status || [],
    entities: (data.entities || []).map((entity) => ({
      handle: entity.handle || "",
      roles: entity.roles || [],
    })),
    nameservers: (data.nameservers || []).map((ns) => ns.ldhName || ns.unicodeName || "").filter(Boolean),
    links: (data.links || []).map((link) => link.href).filter(Boolean).slice(0, 10),
    notices: (data.notices || []).map((notice) => ({
      title: notice.title || "",
      description: notice.description || [],
    })),
  };
}

async function dnsSummary(target) {
  const host = sanitizeHost(target);
  const [a, aaaa, mx, ns, txt, soa] = await Promise.all([
    safeResolve(() => resolve4(host)),
    safeResolve(() => resolve6(host)),
    safeResolve(() => resolveMx(host)),
    safeResolve(() => resolveNs(host)),
    safeResolve(() => resolveTxt(host)),
    safeResolve(() => resolveSoa(host).then((value) => [value])),
  ]);

  return {
    target: host,
    a,
    aaaa,
    mx: mx.map((item) => ({ exchange: item.exchange, priority: item.priority })),
    ns,
    txt: txt.map((entry) => entry.join("")),
    soa: soa[0] || null,
  };
}

function scanPort(host, port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finalize = (result) => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(result);
      }
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finalize({ port, open: true }));
    socket.once("timeout", () => finalize({ port, open: false, reason: "timeout" }));
    socket.once("error", (error) => finalize({ port, open: false, reason: error.message }));

    try {
      socket.connect(port, host);
    } catch (error) {
      finalize({ port, open: false, reason: error instanceof Error ? error.message : String(error) });
    }
  });
}

async function quickPortScan(target) {
  const host = sanitizeHost(target);
  const scans = await Promise.all(COMMON_PORTS.map((port) => scanPort(host, port)));
  return {
    target: host,
    scanned_ports: COMMON_PORTS,
    open_ports: scans.filter((item) => item.open),
    closed_or_filtered_ports: scans.filter((item) => !item.open).slice(0, 10),
  };
}

function generateDomainVariants(domain) {
  const host = sanitizeHost(domain);
  const parts = host.split(".");
  if (parts.length < 2) {
    return [];
  }
  const tld = parts.pop();
  const label = parts.join(".");
  const variants = new Set([
    `${label}-${tld}.${tld}`,
    `${label}${tld}.${tld}`,
    `${label}-secure.${tld}`,
    `${label}-login.${tld}`,
    `${label}app.${tld}`,
    `${label}online.${tld}`,
  ]);

  for (let index = 0; index < label.length - 1; index += 1) {
    const swapped =
      label.slice(0, index) +
      label[index + 1] +
      label[index] +
      label.slice(index + 2);
    variants.add(`${swapped}.${tld}`);
  }

  return [...variants].filter((item) => item !== host).slice(0, 12);
}

async function checkVariant(domain) {
  try {
    const addresses = await resolve4(domain);
    return { domain, active: true, a: addresses };
  } catch {
    return { domain, active: false, a: [] };
  }
}

async function dnstwistSummary(domain) {
  const host = sanitizeHost(domain);
  const variants = generateDomainVariants(host);
  const results = await Promise.all(variants.map((variant) => checkVariant(variant)));
  return {
    target: host,
    generated_variants: variants.length,
    active_variants: results.filter((item) => item.active),
    inactive_variants: results.filter((item) => !item.active).map((item) => item.domain),
  };
}

async function hostSummary(target) {
  const host = sanitizeHost(target);
  const lookedUp = await safeResolve(() => lookup(host, { all: true }));
  const reverseRecords = [];

  for (const item of lookedUp.slice(0, 3)) {
    try {
      const names = await reverse(item.address);
      reverseRecords.push({ address: item.address, names });
    } catch {
      reverseRecords.push({ address: item.address, names: [] });
    }
  }

  return {
    target: host,
    addresses: lookedUp,
    reverse_dns: reverseRecords,
  };
}

const TOOLS = [
  makeTool("whois_lookup", "Run a WHOIS-style lookup using RDAP.", "target"),
  makeTool("nmap_scan", "Run a fast TCP reachability scan on common ports.", "target"),
  makeTool("dnsrecon_lookup", "Collect DNS recon data such as A, AAAA, MX, NS, TXT, and SOA.", "target"),
  makeTool("dnstwist_lookup", "Generate likely typo-squatted domain variants and resolve them.", "domain"),
  makeTool("dig_lookup", "Run a DNS record lookup similar to dig.", "target"),
  makeTool("host_lookup", "Resolve hostnames and reverse DNS data.", "target"),
  makeTool("osint_overview", "Run all OSINT summary lookups for a target.", "target"),
];

async function handleToolCall(name, args) {
  if (name === "whois_lookup") {
    return makeTextResult(await rdapLookup(args.target));
  }
  if (name === "nmap_scan") {
    return makeTextResult(await quickPortScan(args.target));
  }
  if (name === "dnsrecon_lookup" || name === "dig_lookup") {
    return makeTextResult(await dnsSummary(args.target));
  }
  if (name === "dnstwist_lookup") {
    return makeTextResult(await dnstwistSummary(args.domain));
  }
  if (name === "host_lookup") {
    return makeTextResult(await hostSummary(args.target));
  }
  if (name === "osint_overview") {
    const target = args.target;
    const [whois, scan, dns, twist, host] = await Promise.all([
      rdapLookup(target),
      quickPortScan(target),
      dnsSummary(target),
      dnstwistSummary(target),
      hostSummary(target),
    ]);
    return makeTextResult({
      target: sanitizeHost(target),
      whois_lookup: whois,
      nmap_scan: scan,
      dnsrecon_lookup: dns,
      dnstwist_lookup: twist,
      host_lookup: host,
    });
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
