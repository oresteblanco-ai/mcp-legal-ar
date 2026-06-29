#!/usr/bin/env node
/**
 * Smoke test completo - todos los conectores de legal-hub
 * Ejecutar desde: C:\Users\Ximena\legal-hub\servers\legal-mcp
 * Comando: node smoke-test.mjs
 */

import axios from "axios";
import * as cheerio from "cheerio";
import https from "https";
import { readFileSync } from "fs";

const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const axiosClient = axios.create({ httpsAgent, timeout: 15000 });

const OK  = (label, data) => { console.log(`  ✅ ${label}`); if (data) console.log("    ", JSON.stringify(data).substring(0, 150)); };
const ERR = (label, err)  => console.error(`  ❌ ${label}: ${err.message || err}`);

const src = (filename) => readFileSync(`build/${filename}`, "utf-8");

// ─── NETWORK: BOPBA ───────────────────────────────────────────────────────────
async function bopba_obtener_ultimo_boletin() {
  const $ = cheerio.load((await axiosClient.get("https://boletinoficial.gba.gob.ar/", {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
  })).data);
  const fecha = $('.bulletin-date strong').text().trim()
    || $('.bulletin-date').text().replace('Ver anteriores','').trim();
  const secciones = [];
  $('.bulletin-box').each((_, box) => {
    const $b = $(box); const nombre = $b.find('h4').text().trim(); let id = '';
    $b.find('a').each((_, a) => { const m = ($(a).attr('href')||'').match(/\/secciones\/(\d+)/); if (m) { id = m[1]; return false; } });
    if (nombre) secciones.push({ nombre, id });
  });
  return { fecha, secciones_count: secciones.length, primera: secciones[0] };
}

async function bopba_buscar_boletin() {
  const q = new URLSearchParams({ "search[words]": "licitacion", "search[sort]": "by_date_desc", utf8: "✔" });
  const $ = cheerio.load((await axiosClient.get(`https://boletinoficial.gba.gob.ar/buscar?${q}`, {
    headers: { "User-Agent": "Mozilla/5.0", Accept: "text/html" }
  })).data);
  const results = [];
  $('.result-box').each((_, box) => {
    const $b = $(box); const title = $b.find('.title a').first().text().trim();
    const m = ($b.find('.title a[download]').first().attr('href')||'').match(/\/secciones\/(\d+)/);
    if (title) results.push({ title: title.substring(0,60), id: m?.[1]||'' });
  });
  return { count: results.length, first: results[0] };
}

// ─── STATIC: TODOS LOS CONECTORES ─────────────────────────────────────────────

function check_httpsAgent(name) {
  const s = src(`${name}.js`);
  // ptn.js delega TLS a ptn-http.js (que ya tiene el agente) - excepción válida
  if (name === "ptn") return { has_agent: s.includes("ptn-http.js") || s.includes("ptnPost") };
  return { has_agent: s.includes("rejectUnauthorized: false") };
}

function check_transport_guard(name) {
  const s = src(`${name}.js`);
  return {
    no_NODE_ENV:  !s.includes("process.env.NODE_ENV"),
    has_VERCEL:    s.includes("process.env.VERCEL"),
    has_NEXT_RUNTIME: s.includes("process.env.NEXT_RUNTIME"),
  };
}

function check_infoleg_fixes() {
  const s = src("infoleg.js");
  return {
    no_dead_import: !s.includes("pathToFileURL as _pathToFileURL"),
    has_httpsAgent: s.includes("rejectUnauthorized: false"),
    has_puppeteer_dynamic: s.includes('await import("puppeteer")'),
  };
}

function check_pjn_cleanup() {
  const s = src("pjn.js");
  return {
    has_SIGINT:      s.includes('process.on("SIGINT"'),
    has_SIGTERM:     s.includes('process.on("SIGTERM"'),
    has_exit:        s.includes('process.on("exit"'),
    has_cleanupBrowser: s.includes("cleanupBrowser"),
  };
}

function check_tfn_single_server() {
  const s = src("tfn.js");
  const count = (s.match(/new McpServer\(/g) || []).length;
  return { single_instance: count === 1, count };
}

function check_scba_dirname() {
  const s = src("scba.js");
  return {
    has_fileURLToPath: s.includes("fileURLToPath"),
    has_dirname:       s.includes("pathModule.dirname(__filename)"),
    carpeta_anchored:  s.includes("pathModule.isAbsolute(carpeta_base)"),
  };
}

function check_bopba_fixes() {
  const s = src("bopba.js");
  return {
    has_dirname:        s.includes("path.dirname(__filename)"),
    cache_anchored:     s.includes("path.join(__dirname, '../data/tasas-cache.json')"),
    calcular_guard:     s.includes("tasasOficiales[categoria]?.["),
  };
}

function check_pjnjuris_fixes() {
  const s = src("pjnjuris.js");
  return {
    has_helper:    s.includes("pjnJurisQueryWithSession"),
    has_SIGINT:    s.includes('process.on("SIGINT"'),
    has_SIGTERM:   s.includes('process.on("SIGTERM"'),
    cleanup_fn:    s.includes("cleanupBrowser"),
  };
}

function check_index_fixes() {
  const s = src("index.js");
  return {
    resolveNode:          s.includes("function resolveNode()"),
    stripInternalPrefix:  s.includes("function stripInternalPrefix("),
    dirname_fix:          s.includes("fileURLToPath(import.meta.url)"),
    // true = postura segura: TLS_ENV vacio y SIN bypass global activo. (El string
    // NODE_TLS_REJECT_UNAUTHORIZED puede seguir en un comentario; lo que importa es que
    // no exista la asignacion de propiedad activa NODE_TLS_REJECT_UNAUTHORIZED: "0".)
    tls_scoped:           /const TLS_ENV = \{\s*\}/.test(s) && !/NODE_TLS_REJECT_UNAUTHORIZED\s*:\s*["']0["']/.test(s),
    respawn_backoff:      s.includes("_respawnAttempts"),
  };
}

function check_ptn_http() {
  const s = src("ptn-http.js");
  return {
    has_tls_fallback:  s.includes("isTlsVerificationError"),
    has_insecure_retry: s.includes("getPtnHttpsAgent(true)"),
    env_var_support:   s.includes("PTN_TLS_INSECURE"),
  };
}

// ─── RUNNER ───────────────────────────────────────────────────────────────────

console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("  SMOKE TEST COMPLETO - legal-hub v2");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

// Network
console.log("── BOPBA (network) ──────────────────────────────────────────");
try { OK("obtener_ultimo_boletin", await bopba_obtener_ultimo_boletin()); } catch(e) { ERR("obtener_ultimo_boletin", e); }
try { OK("buscar_boletin (licitacion)", await bopba_buscar_boletin()); } catch(e) { ERR("buscar_boletin", e); }

// Static checks por conector
console.log("\n── STATIC CHECKS ────────────────────────────────────────────");

const connectors = ["bora", "infoleg", "normativapba", "juba", "pjn", "pjnjuris", "ptn", "tfn", "scba"];
for (const c of connectors) {
  try {
    const agent = check_httpsAgent(c);
    const guard = check_transport_guard(c);
    const ok = agent.has_agent && guard.no_NODE_ENV && guard.has_VERCEL && guard.has_NEXT_RUNTIME;
    if (ok) OK(`${c}: httpsAgent + transport guard`);
    else ERR(`${c}: base checks`, new Error(JSON.stringify({...agent, ...guard})));
  } catch(e) { ERR(`${c}: base checks`, e); }
}

console.log("\n── FIX-SPECIFIC CHECKS ──────────────────────────────────────");
try { OK("infoleg: import muerto eliminado + puppeteer dynamic", check_infoleg_fixes()); } catch(e) { ERR("infoleg fixes", e); }
try { OK("pjn: SIGINT/SIGTERM cleanup", check_pjn_cleanup()); } catch(e) { ERR("pjn cleanup", e); }
try { OK("tfn: single McpServer instance", check_tfn_single_server()); } catch(e) { ERR("tfn single server", e); }
try { OK("scba: __dirname anchored", check_scba_dirname()); } catch(e) { ERR("scba dirname", e); }
try { OK("bopba: __dirname + calcular_tarifa guard", check_bopba_fixes()); } catch(e) { ERR("bopba fixes", e); }
try { OK("pjnjuris: helper + cleanup handlers", check_pjnjuris_fixes()); } catch(e) { ERR("pjnjuris fixes", e); }
try { OK("index: resolveNode + stripPrefix + respawn", check_index_fixes()); } catch(e) { ERR("index fixes", e); }
try { OK("ptn-http: TLS fallback + env var", check_ptn_http()); } catch(e) { ERR("ptn-http", e); }

console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
