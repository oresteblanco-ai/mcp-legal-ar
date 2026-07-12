#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs";
import * as pathModule from "path";
import { fileURLToPath } from "url";
import { installTlsFallback } from "./tls-fallback.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = pathModule.dirname(__filename);

// ---------------------------------------------------------------------------
// Mesa de Entradas Virtual (MEV) de la Suprema Corte de Justicia de la Provincia
// de Buenos Aires (mev.scba.gov.ar). Consulta de EXPEDIENTES (no jurisprudencia:
// para fallos de la SCBA esta el conector `scba`; para jurisprudencia bonaerense,
// `juba`). Reconocimiento en vivo jul-2026 (ver RECON_MEV).
//
// Es ASP clasico: NO hay API JSON. Se postean formularios y se parsea el HTML con
// cheerio. Sesion por cookie (ASPSESSIONID*). REQUIERE credenciales del abogado
// (no hay consulta anonima): usuario, clave y depto de registro se toman de las
// variables de entorno MEV_USUARIO / MEV_CLAVE / MEV_DEPTO_REGISTRADO.
//
// Las causas de fuero Penal y Familia son reservadas: solo se ven, ya autorizadas,
// dentro del set automatico "Lista de Causas con AUTORIZACION" (consulta por set).
// ---------------------------------------------------------------------------

const BASE = process.env.MEV_BASE || "https://mev.scba.gov.ar";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36";

const axiosClient = axios.create({
    timeout: Number(process.env.MEV_TIMEOUT_MS || 30000),
    maxRedirects: 5,
    // La MEV responde HTML; no tirar por status para poder inspeccionar el cuerpo.
    validateStatus: (s) => s >= 200 && s < 400,
    headers: { "User-Agent": UA, "Accept-Language": "es-AR,es;q=0.9" },
});
installTlsFallback(axiosClient, "mev");

// ---------------------------------------------------------------------------
// Cookie jar manual (ASP no funciona sin la cookie de sesion; axios no la maneja
// solo en Node). Se capturan Set-Cookie y se reenvia Cookie en cada request.
// ---------------------------------------------------------------------------
const cookieJar = new Map();
function guardarCookies(res) {
    const sc = res?.headers?.["set-cookie"];
    if (!sc) return;
    for (const linea of sc) {
        const par = String(linea).split(";")[0];
        const i = par.indexOf("=");
        if (i > 0) cookieJar.set(par.slice(0, i).trim(), par.slice(i + 1).trim());
    }
}
function cookieHeader() {
    return [...cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}
axiosClient.interceptors.request.use((config) => {
    const c = cookieHeader();
    if (c) config.headers.Cookie = c;
    if (!config.headers.Referer) config.headers.Referer = `${BASE}/busqueda.asp`;
    return config;
});
axiosClient.interceptors.response.use((res) => { guardarCookies(res); return res; });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const stringOrNumber = z.union([z.string(), z.number()]).transform((v) => String(v));
const norm = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/\s+/g, " ").trim();
const limpiar = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

// El MEV es ASP clasico y responde en Latin-1 (ISO-8859-1). Axios por defecto asume
// UTF-8 y rompe los acentos ("Bahia" -> "Bah�a"). Pedimos el buffer crudo y lo
// decodificamos como latin1 (que cubre a/e/i/o/u con acento y la enie).
function decodeLatin1(res) {
    return Buffer.from(res.data).toString("latin1");
}
async function get(pathAndQuery) {
    const res = await axiosClient.get(`${BASE}${pathAndQuery}`, { responseType: "arraybuffer" });
    return decodeLatin1(res);
}
async function postForm(path, campos, referer) {
    const body = new URLSearchParams(campos).toString();
    const res = await axiosClient.post(`${BASE}${path}`, body, {
        responseType: "arraybuffer",
        headers: { "Content-Type": "application/x-www-form-urlencoded", ...(referer ? { Referer: `${BASE}${referer}` } : {}) },
    });
    return decodeLatin1(res);
}

// La MEV no usa codigos HTTP para el estado de sesion: rebota al login con 200.
const esSesionCaida = (html) => /Ingrese los datos del Usuario/i.test(html) && /name=["']?clave["']?/i.test(html);
const esClaveVencida = (html) => /cambi[oa]r? (de )?(su )?(contrase|clave)/i.test(html) && /(vencid|expir|obligatori)/i.test(html);

function hayCredenciales() {
    return !!(process.env.MEV_USUARIO && process.env.MEV_CLAVE);
}

// ---------------------------------------------------------------------------
// Sesion: DOS modos.
//   1) CREDENCIALES (MEV_USUARIO/MEV_CLAVE por env): login directo por POST, headless.
//      Funciona desatendido (ej. tareas programadas).
//   2) HITL (sin credenciales): el usuario abre un navegador (iniciar_hitl_browser),
//      se loguea a mano (Chrome autocompleta con su gestor; la clave nunca pasa por
//      el conector) y el conector toma las COOKIES de sesion del navegador. Mas seguro.
// En ambos, las consultas van por axios+cheerio reusando la cookie de sesion ASP.
// ---------------------------------------------------------------------------
let _logueado = false;
let _jurisActual = null; // clave "TipoDto|depto|FF|PP"
let globalBrowser = null;
let globalPage = null;
const PROFILE_DIR = process.env.MEV_PROFILE_DIR || pathModule.join(__dirname, ".mev-profile");

const navegadorVivo = () => !!(globalBrowser && globalPage && !globalPage.isClosed());

// Copia las cookies de mev.scba.gov.ar del navegador HITL al jar de axios.
// Cubre las dos APIs de puppeteer: page.cookies(url) (deprecada) y browser.cookies().
async function sincronizarCookiesDesdeNavegador() {
    if (!navegadorVivo()) return false;
    let cookies = [];
    try { if (typeof globalPage.cookies === "function") cookies = await globalPage.cookies(BASE); } catch { }
    if ((!cookies || !cookies.length) && globalBrowser && typeof globalBrowser.cookies === "function") {
        try { cookies = await globalBrowser.cookies(); } catch { }
    }
    let n = 0;
    for (const c of cookies || []) {
        if (!c?.name) continue;
        const dom = String(c.domain || "");
        if (dom && !/scba\.gov/i.test(dom)) continue; // solo cookies del dominio MEV
        cookieJar.set(c.name, c.value);
        n++;
    }
    return n > 0;
}

// Login por POST con credenciales de entorno (modo 1).
async function loginPorCredenciales() {
    cookieJar.clear();
    _logueado = false; _jurisActual = null;
    await get("/loguin.asp"); // siembra cookie de sesion
    const html = await postForm("/loguin.asp?familiadepto=", {
        usuario: String(process.env.MEV_USUARIO),
        clave: String(process.env.MEV_CLAVE),
        DeptoRegistrado: process.env.MEV_DEPTO_REGISTRADO || "aa",
    }, "/loguin.asp");
    if (esClaveVencida(html)) throw new Error("La clave MEV esta vencida o requiere cambio (politica de 90 dias). Renovarla a mano en mev.scba.gov.ar.");
    if (esSesionCaida(html)) throw new Error("Login MEV rechazado: verificar MEV_USUARIO / MEV_CLAVE / MEV_DEPTO_REGISTRADO.");
    _logueado = true;
    return html;
}

// Garantiza una sesion valida segun el modo disponible. Es lo que usan todas las tools.
async function asegurarSesion() {
    if (hayCredenciales()) {
        if (!_logueado) await loginPorCredenciales();
        return;
    }
    if (navegadorVivo()) {
        await sincronizarCookiesDesdeNavegador();
        _jurisActual = null; // la jurisdiccion la fija el navegador; forzamos re-POST al consultar
        _logueado = true;
        return;
    }
    throw new Error("Sin sesion MEV. Opcion A: configura MEV_USUARIO/MEV_CLAVE en el entorno (login automatico). Opcion B: llama a iniciar_hitl_browser, logueate en la ventana que se abre, y volve a intentar.");
}

// Re-login segun el modo (ante sesion caida).
async function reLogin() {
    if (hayCredenciales()) return loginPorCredenciales();
    if (navegadorVivo()) { await sincronizarCookiesDesdeNavegador(); return; }
    throw new Error("Sesion MEV caida y sin forma de renovarla: reabri el navegador con iniciar_hitl_browser y logueate de nuevo (o configura credenciales).");
}

// jur: { tipo?: "CC"|"SCJ"|"LPC"|"PZ", depto?: <nombre o codigo>, penal?: bool, familia?: bool }
async function seleccionarJurisdiccion(jur) {
    await asegurarSesion();
    const tipo = jur.tipo || "CC";
    let depto = jur.depto;
    if (tipo === "CC" && depto && !/^\d+$/.test(String(depto))) depto = await resolverDepto(depto);
    const campos = { TipoDto: tipo, Aceptar: "Aceptar" };
    if (tipo === "CC") campos.DtoJudElegido = String(depto);
    if (jur.familia) campos.TipoF = "FF";
    if (jur.penal) campos.TipoP = "PP";
    let html = await postForm("/POSLoguin.asp", campos, "/POSloguin.asp");
    if (esSesionCaida(html)) { // sesion vencida -> re-login UNA vez
        await reLogin();
        html = await postForm("/POSLoguin.asp", campos, "/POSloguin.asp");
        if (esSesionCaida(html)) throw new Error("Sesion MEV caida aun tras re-login.");
    }
    _jurisActual = `${tipo}|${campos.DtoJudElegido || ""}|${campos.TipoF || ""}|${campos.TipoP || ""}`;
    return html;
}

// GET/POST con auto-recuperacion de sesion (re-login + re-seleccion de jurisdiccion).
async function getConSesion(pathAndQuery, jur) {
    if (!_logueado) await asegurarSesion();
    let html = await get(pathAndQuery);
    if (esSesionCaida(html)) {
        await reLogin();
        if (jur) await seleccionarJurisdiccion(jur);
        html = await get(pathAndQuery);
        if (esSesionCaida(html)) throw new Error(`Sesion MEV caida en ${pathAndQuery} aun tras re-login.`);
    }
    return html;
}
async function postConSesion(path, campos, jur, referer) {
    if (!_logueado) await asegurarSesion();
    let html = await postForm(path, campos, referer);
    if (esSesionCaida(html)) {
        await reLogin();
        if (jur) await seleccionarJurisdiccion(jur);
        html = await postForm(path, campos, referer);
        if (esSesionCaida(html)) throw new Error(`Sesion MEV caida en ${path} aun tras re-login.`);
    }
    return html;
}

// ---------------------------------------------------------------------------
// Jurisdicciones y organismos
// ---------------------------------------------------------------------------
async function listarDeptos() {
    const html = await getConSesion("/POSloguin.asp");
    const $ = cheerio.load(html);
    const out = [];
    $('select[name="DtoJudElegido"] option').each((_, el) => {
        const nombre = limpiar($(el).text());
        const valor = ($(el).attr("value") || "").trim();
        if (nombre) out.push({ nombre, valor });
    });
    return out;
}
async function resolverDepto(nombre) {
    const target = norm(nombre);
    const deptos = await listarDeptos();
    const hit = deptos.find((d) => norm(d.nombre).includes(target));
    if (!hit) throw new Error(`Departamento judicial "${nombre}" no encontrado. Disponibles: ${deptos.map((d) => d.nombre).join(", ")}`);
    return hit.valor;
}
// Entra a una jurisdiccion y devuelve sus organismos y sets.
async function entrarJurisdiccion(jur) {
    const html = await seleccionarJurisdiccion(jur);
    const $ = cheerio.load(html);
    const organismos = [];
    $('select[name="JuzgadoElegido"] option').each((_, el) => {
        const nombre = limpiar($(el).text());
        const valor = $(el).attr("value") || ""; // OJO: valor con padding, no trimear
        if (nombre) organismos.push({ nombre, valor });
    });
    const sets = [];
    $('select[name="Set"] option, select[name="SetNovedades"] option').each((_, el) => {
        const nombre = limpiar($(el).text());
        const nidset = ($(el).attr("value") || "").trim();
        if (nombre && /^\d+$/.test(nidset) && !sets.some((s) => s.nidset === nidset)) sets.push({ nombre, nidset });
    });
    return { organismos, sets };
}

// ---------------------------------------------------------------------------
// Parseo de listados (MuestraCausas / resultados) con cheerio
// ---------------------------------------------------------------------------
function parseListado(html) {
    const $ = cheerio.load(html);
    const texto = limpiar($("body").text());
    const out = { causas: [], total: null, sinResultados: false, excedeLimite: false };
    if (/exceden el l[ií]mite/i.test(texto) && /1000/.test(texto)) out.excedeLimite = true;
    if (/otra Jurisdicci[oó]n|no tiene Expedientes cargad/i.test(texto)) out.sinResultados = true;
    const tot = texto.match(/Total Expedientes\s*:?\s*(\d+)/i);
    if (tot) out.total = Number(tot[1]);

    const vistos = new Set();
    $('a[href*="procesales.asp"]').each((_, a) => {
        const href = $(a).attr("href") || "";
        const m = href.match(/nidCausa=(\d+)&(?:amp;)?pidJuzgado=([^"'&\s]+)/i);
        if (!m) return;
        const nidCausa = m[1];
        const pidJuzgado = decodeURIComponent(m[2]);
        if (vistos.has(`${nidCausa}|${pidJuzgado}`)) return;
        vistos.add(`${nidCausa}|${pidJuzgado}`);
        const caratula = limpiar($(a).text()).replace(/\s*-\s*$/, "");
        // Contexto de la fila (dos <tr> por causa en el layout de la MEV).
        const tr = $(a).closest("tr");
        const cuerpo = limpiar(tr.text() + " " + tr.next().text());
        const nums = [...cuerpo.matchAll(/\b([A-Z]{1,3})\s*-\s*(\d{1,6})\s*-\s*(\d{2,4})\b/g)];
        const est = cuerpo.match(/\b(EN LETRA|A DESPACHO|FUERA DE LETRA[^0-9]*?|PARALIZAD[OA]|ARCHIVAD[OA][^0-9]*?)\b/i);
        const um = tr.find('a[href*="proveido.asp"]').first();
        let ultimoMovimiento = { fecha: "", descripcion: "" };
        if (um.length) {
            const t = limpiar(um.text());
            const mm = t.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})\s*-\s*(.+)/);
            ultimoMovimiento = mm ? { fecha: mm[1], descripcion: limpiar(mm[2]) } : { fecha: "", descripcion: t };
        }
        out.causas.push({
            nidCausa, pidJuzgado, caratula,
            estado: est ? est[1].trim() : "",
            receptoria: nums[0] ? `${nums[0][1]} - ${nums[0][2]} - ${nums[0][3]}` : "",
            expediente: nums[1] ? `${nums[1][1]} - ${nums[1][2]} - ${nums[1][3]}` : "",
            ultimoMovimiento,
        });
    });
    return out;
}
function linkSiguiente(html) {
    const $ = cheerio.load(html);
    let next = null;
    $("a").each((_, a) => {
        if (next) return;
        const t = limpiar($(a).text());
        const href = $(a).attr("href") || "";
        if (/^siguiente$/i.test(t) && /(MuestraCausas|resultados)\.asp/i.test(href)) next = "/" + href.replace(/^\//, "").replace(/&amp;/g, "&");
    });
    return next;
}
async function listadoCompleto(htmlPrimera, jur, maxPaginas = 30) {
    const acumulado = parseListado(htmlPrimera);
    let html = htmlPrimera, pag = 1, next = linkSiguiente(html);
    while (next && pag < maxPaginas) {
        html = await getConSesion(next, jur);
        const p = parseListado(html);
        for (const c of p.causas) if (!acumulado.causas.some((x) => x.nidCausa === c.nidCausa && x.pidJuzgado === c.pidJuzgado)) acumulado.causas.push(c);
        next = linkSiguiente(html);
        pag++;
    }
    return acumulado;
}

// ---------------------------------------------------------------------------
// Logica de negocio
// ---------------------------------------------------------------------------
async function buscarPorCaratula({ departamento, organismo, criterio, penal = false, familia = false, estado = "Am", maxPaginas = 30 }) {
    const jur = { depto: departamento, penal, familia };
    const { organismos } = await entrarJurisdiccion(jur);
    let org = organismo;
    if (org && !organismos.some((o) => o.valor === org)) {
        const hit = organismos.find((o) => norm(o.nombre).includes(norm(org)));
        if (hit) org = hit.valor;
    }
    if (!org) throw new Error(`Falta el organismo. Disponibles en ${departamento}: ${organismos.map((o) => o.nombre).join(" | ")}`);
    const html = await postConSesion("/Busqueda.asp", {
        OpcionBusqueda: "", busca: "", JuzgadoElegido: org,
        radio: "xCa", caratula: String(criterio), NCausa: "", NInterno: "",
        TipoCausa: estado, Buscar: "Buscar",
    }, jur, "/busqueda.asp");
    const r = await listadoCompleto(html, jur, maxPaginas);
    return { departamento, organismo: org, criterio, ...r };
}

async function listarSets({ departamento, penal = false, familia = false }) {
    const { sets, organismos } = await entrarJurisdiccion({ depto: departamento, penal, familia });
    return { departamento, penal, familia, sets, organismos: organismos.map((o) => ({ nombre: o.nombre, valor: o.valor })) };
}

async function causasDeSet({ departamento, nidset, penal = false, familia = false, maxPaginas = 30 }) {
    const jur = { depto: departamento, penal, familia };
    await entrarJurisdiccion(jur);
    const html = await getConSesion(`/resultados.asp?nidset=${encodeURIComponent(nidset)}&sFechaDesde=&sFechaHasta=&pOrden=xCa&pOrdenAD=Asc`, jur);
    const r = await listadoCompleto(html, jur, maxPaginas);
    return { departamento, nidset, ...r };
}

async function novedadesDeSet({ departamento, nidset, desde, hasta, penal = false, familia = false, maxPaginas = 30 }) {
    const jur = { depto: departamento, penal, familia };
    await entrarJurisdiccion(jur);
    const html = await getConSesion(`/resultados.asp?nidset=${encodeURIComponent(nidset)}&sFechaDesde=${encodeURIComponent(desde)}&sFechaHasta=${encodeURIComponent(hasta)}&pOrden=xCa&pOrdenAD=Asc`, jur);
    const r = await listadoCompleto(html, jur, maxPaginas);
    return { departamento, nidset, desde, hasta, ...r };
}

async function listarActuaciones({ nidCausa, pidJuzgado, departamento, penal = false, familia = false }) {
    const jur = departamento ? { depto: departamento, penal, familia } : null;
    if (jur) await entrarJurisdiccion(jur);
    const html = await getConSesion(`/procesales.asp?nidCausa=${encodeURIComponent(nidCausa)}&pidJuzgado=${encodeURIComponent(pidJuzgado)}`, jur);
    const $ = cheerio.load(html);
    const ficha = { nidCausa: String(nidCausa), pidJuzgado: String(pidJuzgado), caratula: "", fechaInicio: "", receptoria: "", expediente: "", estado: "", pasos: [] };
    const cuerpo = limpiar($("body").text());
    const car = cuerpo.match(/Car[aá]tula\s*:?\s*(.+?)\s+(?:Fecha inicio|N[º°]|Estado)/i);
    if (car) ficha.caratula = limpiar(car[1]);
    const fi = cuerpo.match(/Fecha inicio\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
    if (fi) ficha.fechaInicio = fi[1];
    const es = cuerpo.match(/Estado\s*:?\s*([A-Za-zÁÉÍÓÚÑ ]+?)(?:\s{2,}|$)/i);
    if (es) ficha.estado = limpiar(es[1]);
    const nums = [...cuerpo.matchAll(/\b([A-Z]{1,3})\s*-\s*(\d{1,6})\s*-\s*(\d{2,4})\b/g)];
    if (nums[0]) ficha.receptoria = `${nums[0][1]} - ${nums[0][2]} - ${nums[0][3]}`;
    if (nums[1]) ficha.expediente = `${nums[1][1]} - ${nums[1][2]} - ${nums[1][3]}`;

    $('a[href*="proveido.asp"]').each((_, a) => {
        const href = $(a).attr("href") || "";
        const m = href.match(/nPosi=(\d+)/i);
        if (!m) return;
        const tr = $(a).closest("tr");
        const cuerpoFila = limpiar(tr.text());
        const f = cuerpoFila.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})(?:\s+(\d{1,2}:\d{2}(?::\d{2})?))?/);
        ficha.pasos.push({
            nPosi: m[1],
            fecha: f ? f[1] : "",
            fechaHora: f ? `${f[1]}${f[2] ? " " + f[2] : ""}` : "",
            descripcion: limpiar($(a).text()),
            firmado: /firmad/i.test(cuerpoFila),
        });
    });
    return ficha;
}

async function obtenerProveido({ nidCausa, pidJuzgado, nPosi, departamento, penal = false, familia = false }) {
    const jur = departamento ? { depto: departamento, penal, familia } : null;
    if (jur) await entrarJurisdiccion(jur);
    const html = await getConSesion(`/proveido.asp?pidJuzgado=${encodeURIComponent(pidJuzgado)}&sCodi=${encodeURIComponent(nidCausa)}&nPosi=${encodeURIComponent(nPosi)}&sFile=a&MT=`, jur);
    const $ = cheerio.load(html);
    const cuerpo = limpiar($("body").text());
    const out = { nidCausa: String(nidCausa), pidJuzgado: String(pidJuzgado), nPosi: String(nPosi), referencias: {}, texto: "" };
    const ref = (label, rx) => { const m = cuerpo.match(rx); if (m) out.referencias[label] = limpiar(m[1]); };
    ref("fechaEscrito", /Fecha del Escrito\s*(\d{1,2}\/\d{1,2}\/\d{2,4}[^A-Za-z]*)/i);
    ref("firmadoPor", /Firmado por\s*(.+?)\s+(?:Nro|Observaci|Presentado|Texto)/i);
    ref("nroPresentacion", /Presentaci[oó]n Electr[oó]nica\s*(\d+)/i);
    const tx = cuerpo.match(/Texto del Prove[ií]do(.*)$/i);
    if (tx) out.texto = limpiar(tx[1].replace(/-{3,}[^-]*seleccione desde aqu[ií][^-]*-{3,}/i, "")).slice(0, 12000);
    return out;
}

// ---------------------------------------------------------------------------
// Servidor McpServer - patron estandar del proyecto
// ---------------------------------------------------------------------------
export const server = new McpServer({ name: "mev-mcp", version: "1.0.0" });

const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const fail = (e) => ({ content: [{ type: "text", text: `Error: ${e.message}` }], isError: true });

export function registerAllTools(server) {
    server.tool(
        "alcance_fuente",
        "Informa capacidades, limitaciones y estado del conector de la Mesa de Entradas Virtual (MEV) de la Suprema Corte de la Provincia de Buenos Aires.",
        {},
        async () => ok({
            fuente: "Mesa de Entradas Virtual (MEV) - Suprema Corte de Justicia de la Provincia de Buenos Aires",
            portal: "https://mev.scba.gov.ar",
            acceso: "La MEV no tiene consulta anonima. DOS modos de login: (A) CREDENCIALES por entorno (MEV_USUARIO, MEV_CLAVE, MEV_DEPTO_REGISTRADO default 'aa'): login automatico, sirve desatendido. (B) HITL: iniciar_hitl_browser abre una ventana donde el usuario se loguea a mano (Chrome autocompleta; la clave nunca pasa por el conector) y el conector toma la sesion. Si no hay credenciales, usar el modo B.",
            modoActivo: hayCredenciales() ? "A - credenciales de entorno (login automatico)" : (navegadorVivo() ? "B - HITL (navegador abierto)" : "sin sesion: configurar credenciales o usar iniciar_hitl_browser"),
            credencialesConfiguradas: hayCredenciales(),
            navegadorHitlAbierto: navegadorVivo(),
            cubre: [
                "Busqueda de causas por caratula en un organismo (fueros no reservados).",
                "Listado de sets del usuario, incluido el automatico 'Lista de Causas con AUTORIZACION' (causas reservadas ya autorizadas: penal/familia).",
                "Causas de un set y novedades de un set entre fechas (feed de monitoreo).",
                "Pasos procesales (actuaciones) de una causa y texto del proveido.",
                "Listado de departamentos judiciales y de organismos por departamento.",
            ],
            limitaciones: [
                "ASP sin API: se parsea HTML; si la SCBA cambia el portal, puede requerir ajuste.",
                "Fuero Penal y Familia: reservados; solo visibles ya autorizados, via set 'Lista de Causas con AUTORIZACION' (entrar con el fuero correspondiente).",
                "La jurisdiccion (departamento + fuero) es estado de sesion: se re-selecciona por consulta.",
                "Clave con vencimiento forzado cada 90 dias: si vencio, el conector avisa y hay que renovarla a mano.",
                "Datos de caracter referencial (asi lo aclara la propia SCBA).",
            ],
            distincionConOtrosConectores: {
                mev: "expedientes (esta fuente)",
                scba: "documentos/jurisprudencia de la Suprema Corte",
                juba: "jurisprudencia bonaerense (JUBA)",
                normativapba: "normativa de la Provincia",
            },
        })
    );

    server.tool(
        "iniciar_hitl_browser",
        "Abre un navegador interactivo (HITL) en la MEV para que el USUARIO se loguee a mano (Chrome autocompleta con su gestor de contrasenas; la clave nunca pasa por el conector). Alternativa al login por credenciales de entorno. REGLA: avisale al usuario ANTES en tu mensaje previo ('se va a abrir una ventana de Chromium; logueate en la MEV con tu usuario y clave, y avisame con un ok') y recien entonces llama con aviso_dado=true.",
        {
            aviso_dado: z.boolean().optional().default(false).describe("OBLIGATORIO en true. Confirma que en tu mensaje ANTERIOR ya le avisaste al usuario que se abre una ventana y que debe loguearse. Si no se lo dijiste, NO llames esta tool."),
        },
        async (args) => {
            if (!args.aviso_dado) return fail(new Error("NO se abrio la ventana. Primero avisale al usuario que se va a abrir una ventana de Chromium para la MEV donde debe loguearse (su clave no pasa por el conector), y despues volve a llamar con aviso_dado=true."));
            if (navegadorVivo()) return ok({ estado: "El navegador ya esta abierto; la sesion sigue viva. Si ya te logueaste, podes llamar a las tools de consulta." });
            try {
                const { default: puppeteer } = await import("puppeteer");
                fs.mkdirSync(PROFILE_DIR, { recursive: true });
                globalBrowser = await puppeteer.launch({
                    headless: false,
                    defaultViewport: null,
                    userDataDir: PROFILE_DIR, // perfil persistente: recuerda la sesion entre corridas
                    args: ["--start-maximized"],
                });
                globalPage = (await globalBrowser.pages())[0] || (await globalBrowser.newPage());
                await globalPage.goto(`${BASE}/loguin.asp`, { waitUntil: "domcontentloaded", timeout: 90000 });
                _logueado = false; _jurisActual = null;
                return ok({
                    estado: "Navegador abierto en el login de la MEV.",
                    instruccion: "Decile al usuario: 'Logueate en la ventana con tu usuario y clave de la MEV (Chrome puede autocompletar). Si te ofrece guardar la clave, aceptale: el perfil es persistente y local, la proxima vez entra solo. Cuando estes adentro, avisame con un ok'. Cuando confirme, llama directo a cualquier tool de consulta (listar_departamentos, buscar_causas, etc.): el conector toma la sesion del navegador. La clave nunca pasa por el conector.",
                });
            } catch (e) {
                globalBrowser = null; globalPage = null;
                return fail(new Error(`No se pudo abrir el navegador: ${e.message}. (Requiere puppeteer instalado en el repo.)`));
            }
        }
    );

    server.tool(
        "estado_hitl",
        "Estado de la sesion HITL de la MEV: si el navegador esta abierto, en que URL, y si hay cookies de sesion capturadas.",
        {},
        async () => {
            if (!navegadorVivo()) return ok({ navegador: "cerrado", modo: hayCredenciales() ? "hay credenciales de entorno (login automatico)" : "sin credenciales: usar iniciar_hitl_browser" });
            let url = "(desconocida)";
            try { url = globalPage.url(); } catch { }
            await sincronizarCookiesDesdeNavegador();
            const tieneSesion = [...cookieJar.keys()].some((k) => /ASPSESSION/i.test(k));
            return ok({ navegador: "abierto", url, cookiesDeSesionCapturadas: tieneSesion, cookies: [...cookieJar.keys()] });
        }
    );

    server.tool(
        "finalizar_hitl_browser",
        "Cierra el navegador interactivo (HITL) de la MEV y limpia la sesion en memoria.",
        {},
        async () => {
            try { if (globalBrowser) await globalBrowser.close(); } catch { }
            globalBrowser = null; globalPage = null; _logueado = false; _jurisActual = null; cookieJar.clear();
            return ok({ estado: "Navegador cerrado y sesion limpiada." });
        }
    );

    server.tool(
        "listar_departamentos",
        "Lista los departamentos judiciales disponibles en la MEV (nombre y codigo interno). Util para saber que 'departamento' pasar a las demas tools.",
        {},
        async () => { try { return ok({ departamentos: await listarDeptos() }); } catch (e) { return fail(e); } }
    );

    server.tool(
        "listar_organismos",
        "Lista los organismos (juzgados, camaras, tribunales) de un departamento judicial en la MEV. Con penal=true o familia=true entra a esos fueros.",
        {
            departamento: z.string().describe("Nombre del departamento judicial (ej. 'Moron', 'La Plata', 'San Isidro')."),
            penal: z.boolean().optional().default(false).describe("Entrar al fuero Penal."),
            familia: z.boolean().optional().default(false).describe("Entrar al fuero de Familia."),
        },
        async (a) => { try { const r = await listarSets(a); return ok({ departamento: a.departamento, organismos: r.organismos, sets: r.sets }); } catch (e) { return fail(e); } }
    );

    server.tool(
        "buscar_causas",
        "Busca causas por caratula en un organismo de un departamento (fueros no reservados). Devuelve cada causa con nidCausa, pidJuzgado, caratula, estado, numeros y ultimo movimiento.",
        {
            departamento: z.string().describe("Departamento judicial (ej. 'Moron')."),
            organismo: z.string().describe("Organismo: nombre (ej. 'Juzgado Civil y Comercial N 1') o codigo (ej. 'GAM2078 ')."),
            criterio: z.string().describe("Texto a buscar en la caratula (apellido, razon social, etc.)."),
            estado: z.enum(["Ac", "Ar", "Am"]).optional().default("Am").describe("Activos (Ac), Archivados (Ar) o Ambos (Am). Default Am."),
        },
        async (a) => { try { return ok(await buscarPorCaratula(a)); } catch (e) { return fail(e); } }
    );

    server.tool(
        "listar_sets",
        "Lista los sets de busqueda del usuario en un departamento/fuero, incluido el set automatico 'Lista de Causas con AUTORIZACION' (causas reservadas ya autorizadas). Para causas penales/familia usar penal=true o familia=true.",
        {
            departamento: z.string().describe("Departamento judicial."),
            penal: z.boolean().optional().default(false).describe("Fuero Penal (necesario para ver autorizadas penales)."),
            familia: z.boolean().optional().default(false).describe("Fuero de Familia."),
        },
        async (a) => { try { return ok(await listarSets(a)); } catch (e) { return fail(e); } }
    );

    server.tool(
        "causas_de_set",
        "Lista las causas contenidas en un set de la MEV (nidset). Requiere el mismo departamento/fuero con el que se ve el set.",
        {
            departamento: z.string().describe("Departamento judicial."),
            nidset: stringOrNumber.describe("nidset del set (lo devuelve listar_sets)."),
            penal: z.boolean().optional().default(false),
            familia: z.boolean().optional().default(false),
        },
        async (a) => { try { return ok(await causasDeSet(a)); } catch (e) { return fail(e); } }
    );

    server.tool(
        "novedades_de_set",
        "Causas de un set con novedades entre dos fechas (feed de monitoreo diario). Fechas en formato d/m/aaaa.",
        {
            departamento: z.string().describe("Departamento judicial."),
            nidset: stringOrNumber.describe("nidset del set."),
            desde: z.string().describe("Fecha desde, formato d/m/aaaa."),
            hasta: z.string().describe("Fecha hasta, formato d/m/aaaa."),
            penal: z.boolean().optional().default(false),
            familia: z.boolean().optional().default(false),
        },
        async (a) => { try { return ok(await novedadesDeSet(a)); } catch (e) { return fail(e); } }
    );

    server.tool(
        "listar_actuaciones",
        "Obtiene la ficha y los pasos procesales (actuaciones) de una causa de la MEV por nidCausa + pidJuzgado. Cada paso trae nPosi, fecha, descripcion y si esta firmado.",
        {
            nidCausa: stringOrNumber.describe("nidCausa de la causa (lo devuelven buscar_causas / causas_de_set)."),
            pidJuzgado: z.string().describe("Codigo del organismo (pidJuzgado), ej. 'GAM2078'."),
            departamento: z.string().optional().describe("Departamento judicial (recomendado, para fijar la jurisdiccion de sesion)."),
            penal: z.boolean().optional().default(false),
            familia: z.boolean().optional().default(false),
        },
        async (a) => { try { return ok(await listarActuaciones(a)); } catch (e) { return fail(e); } }
    );

    server.tool(
        "obtener_proveido",
        "Obtiene el texto completo de un paso procesal (proveido) de la MEV: referencias (fecha, firmante, nro de presentacion) y el texto del despacho.",
        {
            nidCausa: stringOrNumber.describe("nidCausa de la causa."),
            pidJuzgado: z.string().describe("Codigo del organismo (pidJuzgado)."),
            nPosi: stringOrNumber.describe("nPosi del paso (lo devuelve listar_actuaciones)."),
            departamento: z.string().optional(),
            penal: z.boolean().optional().default(false),
            familia: z.boolean().optional().default(false),
        },
        async (a) => { try { return ok(await obtenerProveido(a)); } catch (e) { return fail(e); } }
    );
}

registerAllTools(server);

// Guard de entorno identico al resto del proyecto.
if (typeof process !== "undefined" && !process.env.VERCEL && !process.env.NEXT_RUNTIME) {
    const transport = new StdioServerTransport();
    server.connect(transport).catch((err) => {
        process.stderr.write(`[mev] error fatal: ${err.message}\n`);
        process.exit(1);
    });
    process.stderr.write("[mev] MEV (Mesa de Entradas Virtual, SCBA) MCP Server is running via Stdio.\n");
}
