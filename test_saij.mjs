#!/usr/bin/env node
/**
 * Harness de regresion - conector SAIJ (mcp-legal-ar)
 *
 * SAIJ estuvo deshabilitado por HTTP 403 (bloqueo anti-bot). El api-client ya no
 * usa Puppeteer: pega directo a www.saij.gob.ar/busqueda con headers de browser.
 * Hipotesis: el 403 era por IP no-argentina; desde IP AR responde. Este harness
 * lo confirma y distingue 403 (bloqueo) de exito.
 *
 * Uso:
 *   cd C:\Users\Ximena\mcp-legal-ar && node test_saij.mjs
 *
 * Variables:
 *   MCP_LEGAL_CMD  comando del server (default: "node build/index.js")
 *   MCP_LEGAL_CWD  cwd (default: cwd actual)
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const CMD = process.env.MCP_LEGAL_CMD || "node build/index.js";
const CWD = process.env.MCP_LEGAL_CWD || process.cwd();
const [bin, ...binArgs] = CMD.split(" ");

function textOf(res) {
  if (!res) return "";
  if (res.isError) return "__ERROR__ " + JSON.stringify(res.content ?? res);
  const parts = Array.isArray(res.content) ? res.content : [];
  return parts.map((c) => (typeof c.text === "string" ? c.text : "")).join("\n");
}

const bloqueado = (t) => /HTTP 403|SAIJ_403|bloque/i.test(t);
const fallo = (t) => /__ERROR__|__EXCEPTION__/.test(t);

// match: substring para encontrar la tool real sin depender del prefijo del hub
const CASES = [
  {
    id: "S1",
    desc: "search_legislacion 'defensa del consumidor' -> resultados sin 403",
    match: /legislacion$/i,
    args: { query: "defensa del consumidor", pageSize: 3 },
    assert: (t) => !bloqueado(t) && !fallo(t) && /total_results|results|uuid/i.test(t),
  },
  {
    id: "S2",
    desc: "resolve_citation 'Ley 24240' -> documento sin 403",
    match: /resolve_citation$/i,
    args: { citation_text: "Ley 24240" },
    assert: (t) => !bloqueado(t) && !fallo(t) && /uuid|document|24240/i.test(t),
  },
  {
    id: "S3",
    desc: "search_jurisprudencia 'amparo' -> resultados sin 403",
    match: /jurisprudencia$/i,
    args: { query: "amparo", pageSize: 3 },
    assert: (t) => !bloqueado(t) && !fallo(t) && /total_results|results|uuid/i.test(t),
  },
  {
    id: "S4",
    desc: "get_novedades -> lista sin 403",
    match: /novedades$/i,
    args: { limit: 3 },
    assert: (t) => !bloqueado(t) && !fallo(t),
  },
];

async function main() {
  const transport = new StdioClientTransport({ command: bin, args: binArgs, cwd: CWD });
  const client = new Client({ name: "saij-regression", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);

  const tools = (await client.listTools()).tools.map((t) => t.name);
  const findTool = (re) => tools.find((n) => /saij/i.test(n) && re.test(n));

  const rows = [];
  for (const c of CASES) {
    const name = findTool(c.match);
    let status = "FAIL";
    let note = "";
    if (!name) {
      status = "NO-TOOL";
      note = `no se encontro tool que matchee ${c.match}`;
    } else {
      try {
        const res = await client.callTool({ name, arguments: c.args });
        const raw = textOf(res);
        status = c.assert(raw) ? "PASS" : (bloqueado(raw) ? "BLOQUEADO-403" : "FAIL");
        note = `${name} -> ${raw.replace(/\s+/g, " ").slice(0, 80)}`;
      } catch (e) {
        note = "__EXCEPTION__ " + (e?.message || String(e));
      }
    }
    rows.push({ id: c.id, status, desc: c.desc, note });
  }

  await client.close();

  const pad = (s, n) => (s + " ".repeat(n)).slice(0, n);
  console.log("\n== SAIJ regression ==");
  console.log(`(tools saij detectadas: ${tools.filter((n) => /saij/i.test(n)).length})`);
  for (const r of rows) {
    console.log(`${pad(r.id, 4)} ${pad(r.status, 14)} ${r.desc}`);
    console.log(`      └ ${r.note}`);
  }

  const malos = rows.filter((r) => r.status !== "PASS");
  if (malos.length) {
    console.error(`\n✘ No-PASS: ${malos.map((r) => r.id + ":" + r.status).join(", ")}`);
    process.exit(1);
  }
  console.log("\nSAIJ operativo. Sin fallos.");
  process.exit(0);
}

main().catch((e) => {
  console.error("Harness error:", e);
  process.exit(2);
});
