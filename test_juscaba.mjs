#!/usr/bin/env node
/**
 * Harness de regresion - conector JusCABA (mcp-legal-ar)
 * Recon: mcp-legal-ar-test/RECON_JUSCABA_2026-06-22.md
 *
 * Conecta al server MCP por stdio (levanta build/index.js) y corre los casos
 * contra la API publica del EJE de la Justicia de la Ciudad. No depende del host.
 *
 * Uso:
 *   cd C:\Users\Ximena\mcp-legal-ar && node test_juscaba.mjs
 *
 * Variables:
 *   MCP_LEGAL_CMD    comando que arranca el server (default: "node build/index.js")
 *   MCP_LEGAL_CWD    cwd del server (default: cwd actual)
 *   MCP_TOOL_PREFIX  prefijo del namespace (default: "juscaba__")
 *
 * Semantica:
 *   - assert() = expectativa esperada.
 *   - knownFail:true marca casos que fallan a proposito (ninguno hoy).
 *   - Exit 0 si todos los no-knownFail pasan. Exit 1 si rompe alguno.
 *
 * Nota: expId 3389017 es una causa publica estable (PICCARDI c/ MERCADOLIBRE,
 *   2025) usada como fixture. Si el portal la despublica, reemplazar por otra
 *   obtenida con buscar_causas.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const CMD = process.env.MCP_LEGAL_CMD || "node build/index.js";
const CWD = process.env.MCP_LEGAL_CWD || process.cwd();
const PREFIX = process.env.MCP_TOOL_PREFIX ?? "juscaba__";

const [bin, ...binArgs] = CMD.split(" ");

function textOf(res) {
  if (!res) return "";
  if (res.isError) return "__ERROR__ " + JSON.stringify(res.content ?? res);
  const parts = Array.isArray(res.content) ? res.content : [];
  return parts.map((c) => (typeof c.text === "string" ? c.text : "")).join("\n");
}

const FIXTURE = "3389017"; // causa publica estable usada de fixture

// ---- Casos ----------------------------------------------------------------
const CASES = [
  {
    id: "J1",
    desc: "alcance_fuente -> declara JusCABA/EJE",
    tool: "alcance_fuente",
    args: {},
    assert: (t) => /JusCABA|EJE|Ciudad de Buenos Aires/i.test(t),
    knownFail: false,
  },
  {
    id: "J2",
    desc: "buscar_causas GCBA enriquecido -> causas con cuij, caratula y ultimaActuacion",
    tool: "buscar_causas",
    args: { criterio: "GCBA", size: 3 },
    assert: (t) => /"cuij"/.test(t) && /"caratula"/.test(t) && /"ultimaActuacion"/.test(t) && /"descripcion"/.test(t) && !/__ERROR__/.test(t),
    knownFail: false,
  },
  {
    id: "J3",
    desc: "buscar_causas sin enriquecer -> lista de expIds",
    tool: "buscar_causas",
    args: { criterio: "GCBA", size: 5, enriquecer: false },
    assert: (t) => /"expIds"/.test(t) && /\d{6,}/.test(t),
    knownFail: false,
  },
  {
    id: "J4",
    desc: "obtener_encabezado fixture -> cuij + caratula",
    tool: "obtener_encabezado",
    args: { expId: FIXTURE },
    assert: (t) => /"cuij"/.test(t) && /"caratula"/.test(t),
    knownFail: false,
  },
  {
    id: "J5",
    desc: "listar_actuaciones fixture -> actuaciones con actId",
    tool: "listar_actuaciones",
    args: { expId: FIXTURE, size: 10 },
    assert: (t) => /"actuaciones"/.test(t) && /"actId"/.test(t) && !/__ERROR__/.test(t),
    knownFail: false,
  },
  {
    id: "J6",
    desc: "listar_partes fixture -> partes con nombreApellido",
    tool: "listar_partes",
    args: { expId: FIXTURE },
    assert: (t) => /"partes"/.test(t) && /"nombreApellido"/.test(t),
    knownFail: false,
  },
  {
    id: "J7",
    desc: "tiene_sentencia fixture -> campo booleano",
    tool: "tiene_sentencia",
    args: { expId: FIXTURE },
    assert: (t) => /"tieneSentencia"\s*:\s*(true|false)/.test(t),
    knownFail: false,
  },
];

// ---- Runner ---------------------------------------------------------------
async function main() {
  const transport = new StdioClientTransport({ command: bin, args: binArgs, cwd: CWD });
  const client = new Client({ name: "juscaba-regression", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);

  const rows = [];
  for (const c of CASES) {
    const name = PREFIX + c.tool;
    let ok = false;
    let raw = "";
    try {
      const res = await client.callTool({ name, arguments: c.args });
      raw = textOf(res);
      ok = !!c.assert(raw);
    } catch (e) {
      raw = "__EXCEPTION__ " + (e?.message || String(e));
      ok = false;
    }
    let status;
    if (ok) status = "PASS";
    else if (c.knownFail) status = "KNOWN-FAIL";
    else status = "FAIL";
    rows.push({ id: c.id, status, desc: c.desc, note: raw.replace(/\s+/g, " ").slice(0, 90) });
  }

  await client.close();

  const pad = (s, n) => (s + " ".repeat(n)).slice(0, n);
  console.log("\n== JusCABA regression ==");
  for (const r of rows) {
    console.log(`${pad(r.id, 5)} ${pad(r.status, 11)} ${r.desc}`);
    console.log(`      └ ${r.note}`);
  }

  const regressions = rows.filter((r) => r.status === "FAIL");
  if (regressions.length) {
    console.error(`\n✘ Fallos: ${regressions.map((r) => r.id).join(", ")}`);
    process.exit(1);
  }
  console.log("\nSin fallos.");
  process.exit(0);
}

main().catch((e) => {
  console.error("Harness error:", e);
  process.exit(2);
});
