#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios from "axios";
import { fileURLToPath } from "url";
import * as pathModule from "path";
import { installTlsFallback } from "./tls-fallback.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = pathModule.dirname(__filename);

// TLS estricto por defecto; fallback inseguro solo ante cert roto (ver tls-fallback.js).
const axiosClient = axios.create({ timeout: 20000 });
installTlsFallback(axiosClient, "juscaba");

// API REST publica del EJE (Expediente Judicial Electronico) de la Justicia de la
// Ciudad de Buenos Aires. Sin autenticacion ni captcha. Mapeada por reconocimiento
// el 22/06/2026 (ver RECON_JUSCABA). Backend Spring: respuestas tipo Page.
const BASE_URL = "https://eje.juscaba.gob.ar/iol-api/api/public";
// Base AUTENTICADA (misma ruta SIN /public): habilita "Mis Causas" y las causas
// reservadas del abogado, que la consulta publica rechaza (code 1004).
const BASE_AUTH = "https://eje.juscaba.gob.ar/iol-api/api";

const HEADERS = {
    "Accept": "application/json",
    "Referer": "https://eje.juscaba.gob.ar/iol-ui/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
};

// ---------------------------------------------------------------------------
// AUTENTICACION (opcional) - DOS MODOS, para ver "Mis Causas" y reservadas.
//   A) CREDENCIALES por entorno: EJE_USUARIO (CUIT sin guiones) + EJE_CLAVE ->
//      Keycloak grant_type=password (realm IOL-CABA, client publico iol-ui). SOLO
//      sirve para login DIRECTO del EJE con CUIT. Si el abogado entra por "Ingresar
//      con MIBA" (identidad federada del GCBA, usuario = email), este modo NO aplica:
//      usar el modo B. Por eso solo se toma como valido un EJE_USUARIO numerico (CUIT).
//   B) HITL: iniciar_hitl_browser abre una ventana donde el usuario se loguea en
//      el EJE (por MIBA o directo, como sea); el conector captura el Bearer que emite
//      la propia SPA. La clave no pasa por el conector. Es el modo que sirve para MIBA.
//   Sin ninguno de los dos, el conector sigue en modo PUBLICO (solo causas publicas).
// El token vive solo en memoria. .env / bloque "env" del JSON para el modo A.
// ---------------------------------------------------------------------------
const EJE_AUTH_URL = process.env.EJE_AUTH_URL || "https://eje.juscaba.gob.ar/auth";
const EJE_REALM = process.env.EJE_REALM || "IOL-CABA";
const EJE_CLIENT_ID = process.env.EJE_CLIENT_ID || "iol-ui";
const EJE_TOKEN_URL = `${EJE_AUTH_URL}/realms/${encodeURIComponent(EJE_REALM)}/protocol/openid-connect/token`;
const EJE_PROFILE_DIR = process.env.EJE_PROFILE_DIR || null; // se resuelve tarde (necesita pathModule/__dirname)

let _ejeTok = null;                 // { access, refresh, accessExp, refreshExp } (grant password)
let _ejeBrowser = null, _ejePage = null; // HITL
let _ejeHitlToken = { token: null, ts: 0 }; // Bearer capturado de la SPA (HITL)

// El login del EJE tiene DOS formas: (1) directo Keycloak con CUIT + clave local
// (grant_type=password), (2) "Ingresar con miBA" (identidad del GCBA, usuario =
// email). Segun el formato de EJE_USUARIO se elige la via:
//   - EJE_USUARIO numerico (CUIT) -> grant password directo.
//   - EJE_USUARIO con @ (email)   -> auto-login por navegador contra miBA.
const ejeUsuarioEsCuit = () => {
    const u = (process.env.EJE_USUARIO || "").trim();
    return /^[\d.\-]+$/.test(u) && u.replace(/\D/g, "").length >= 8;
};
const ejeUsuarioEsMiba = () => /@/.test((process.env.EJE_USUARIO || "").trim());
const hayCredencialesEjeCuit = () => !!(ejeUsuarioEsCuit() && process.env.EJE_CLAVE);
const hayCredencialesEjeMiba = () => !!(ejeUsuarioEsMiba() && process.env.EJE_CLAVE);
const hayCredencialesEje = () => hayCredencialesEjeCuit() || hayCredencialesEjeMiba();
// Navegador oculto para el auto-login miBA (EJE_HEADLESS=1). Default visible, por si
// miBA pide captcha/2FA: ahi el usuario ve la ventana y destraba.
const ejeHeadless = () => /^(1|true)$/i.test(process.env.EJE_HEADLESS || "");
const ejePageViva = () => !!(_ejeBrowser && _ejePage && !_ejePage.isClosed());
const modoAutenticado = () => hayCredencialesEje() || ejePageViva();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const stringOrNumber = z.union([z.string(), z.number()]).transform((v) => String(v));
const stringOrNumberOptional = z.union([z.string(), z.number()]).transform((v) => String(v)).optional();

function epochADmy(ms) {
    if (ms === null || ms === undefined || ms === "") return null;
    const n = Number(ms);
    if (!Number.isFinite(n)) return null;
    const d = new Date(n);
    if (isNaN(d.getTime())) return null;
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    return `${dd}/${mm}/${d.getFullYear()}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── token de sesion del EJE (modo A: Keycloak; modo B: capturado del navegador) ──
const EJE_MARGEN_MS = 20000;
async function ejePostToken(params) {
    const body = new URLSearchParams({ client_id: EJE_CLIENT_ID, ...params }).toString();
    const res = await axiosClient.post(EJE_TOKEN_URL, body, {
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
    });
    const j = res.data || {};
    const now = Date.now();
    _ejeTok = {
        access: j.access_token,
        refresh: j.refresh_token || null,
        accessExp: now + Number(j.expires_in || 300) * 1000,
        refreshExp: now + Number(j.refresh_expires_in || 1800) * 1000,
    };
    return _ejeTok.access;
}
// Devuelve un Bearer valido segun el modo disponible, o null (modo publico).
async function getTokenEje() {
    const tokenHitlFresco = () => _ejeHitlToken.token && Date.now() - _ejeHitlToken.ts < 4 * 60 * 1000;
    // Token ya capturado del navegador (HITL o auto-login miBA), aun fresco.
    if (ejePageViva() && tokenHitlFresco()) return _ejeHitlToken.token;
    // Modo A - CUIT: grant password directo con cache + refresh.
    if (hayCredencialesEjeCuit()) {
        const now = Date.now();
        if (_ejeTok && _ejeTok.accessExp - EJE_MARGEN_MS > now) return _ejeTok.access;
        if (_ejeTok && _ejeTok.refresh && _ejeTok.refreshExp - EJE_MARGEN_MS > now) {
            try { return await ejePostToken({ grant_type: "refresh_token", refresh_token: _ejeTok.refresh }); } catch { /* cae a password */ }
        }
        return await ejePostToken({
            grant_type: "password",
            username: String(process.env.EJE_USUARIO).replace(/[^0-9]/g, ""), // CUIT sin guiones
            password: String(process.env.EJE_CLAVE),
        });
    }
    // Modo A - miBA: auto-login por navegador (identidad del GCBA).
    if (hayCredencialesEjeMiba()) {
        if (ejePageViva() && tokenHitlFresco()) return _ejeHitlToken.token;
        // Si el navegador ya esta logueado, tomar el token del storage sin re-loguear.
        if (ejePageViva()) { const t = await leerTokenDeStorage(); if (t) { _ejeHitlToken = { token: t, ts: Date.now() }; return t; } }
        return await autoLoginMibaEje();
    }
    // Modo B (HITL manual): refrescar el token recargando la pagina.
    if (ejePageViva()) return await refrescarTokenHitl();
    return null;
}

async function getAuth(path, params) {
    const headers = { ...HEADERS };
    const t = await getTokenEje();
    if (t) headers.Authorization = "Bearer " + t;
    const res = await axiosClient.get(`${BASE_AUTH}${path}`, { headers, params });
    return res.data;
}
// GET a la API. Por defecto PUBLICO. Con auth:true, si la causa es reservada (code
// 1004) o da 401/403 y hay sesion, reintenta por la base autenticada + Bearer -> asi
// las consultas publicas de terceros NO se rompen aunque tengas credenciales, y tus
// causas reservadas se ven igual. forceAuth:true va directo a autenticado (Mis Causas).
async function getJson(path, params, { auth = false, forceAuth = false } = {}) {
    if (forceAuth && modoAutenticado()) return getAuth(path, params);
    try {
        const res = await axiosClient.get(`${BASE_URL}${path}`, { headers: HEADERS, params });
        return res.data;
    } catch (e) {
        const body = e?.response?.data;
        const bodyStr = typeof body === "string" ? body : JSON.stringify(body || "");
        const reservada = bodyStr.includes("1004") || [401, 403].includes(e?.response?.status);
        if (auth && modoAutenticado() && reservada) return getAuth(path, params);
        throw e;
    }
}

// ---------------------------------------------------------------------------
// Logica de negocio
// ---------------------------------------------------------------------------

// Busqueda: POST form-urlencoded. /lista devuelve SOLO expId; la caratula se pide
// despues por encabezado. Enriquecemos cada expId con su ficha minima.
async function buscarCausas({ criterio, tipoBusqueda = "CAU", page = 0, size = 10, enriquecer = true }) {
    const info = {
        filter: JSON.stringify({ identificador: String(criterio) }),
        tipoBusqueda,
        page,
        size,
    };
    const body = "info=" + encodeURIComponent(JSON.stringify(info));
    const res = await axiosClient.post(`${BASE_URL}/expedientes/lista`, body, {
        headers: { ...HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
    });
    const data = res.data || {};
    const ids = (data.content || []).map((c) => c.expId).filter((x) => x != null);

    if (!enriquecer) {
        return { total: data.totalElements ?? null, page, size, expIds: ids };
    }

    const causas = [];
    for (const expId of ids) {
        try {
            const enc = await getJson("/expedientes/encabezado", { expId });
            let ultima = null;
            try {
                const ua = await getJson("/expedientes/ultimaAccion", { expId });
                // La respuesta anida bajo "ultimaAccion": { descripcion, fecha, tipo }.
                const acc = ua && ua.ultimaAccion ? ua.ultimaAccion : null;
                ultima = acc
                    ? { descripcion: acc.descripcion ?? acc.titulo, fecha: epochADmy(acc.fecha), tipo: acc.tipo }
                    : null;
            } catch { /* ultima accion opcional */ }
            causas.push({
                expId,
                cuij: enc.cuij,
                caratula: enc.caratula,
                tipoExpediente: enc.tipoExpediente,
                numero: enc.numero,
                anio: enc.anio,
                estado: enc.estadoAdministrativo,
                esPrivado: enc.esPrivado === 1,
                fechaInicio: epochADmy(enc.fechaInicio),
                ultimaActuacion: ultima,
            });
            await sleep(100); // buen ciudadano
        } catch (e) {
            causas.push({ expId, error: String(e.message || e).slice(0, 120) });
        }
    }

    return { total: data.totalElements ?? null, page, size, devueltos: causas.length, causas };
}

async function obtenerEncabezado(expId) {
    const enc = await getJson("/expedientes/encabezado", { expId }, { auth: true });
    return {
        expId: Number(expId),
        cuij: enc.cuij,
        caratula: enc.caratula,
        tipoExpediente: enc.tipoExpediente,
        numero: enc.numero,
        anio: enc.anio,
        estado: enc.estadoAdministrativo,
        esPrivado: enc.esPrivado === 1,
        fechaInicio: epochADmy(enc.fechaInicio),
        sufijo: enc.sufijo,
    };
}

async function listarActuaciones({ expId, page = 0, size = 20, cedulas = true, escritos = true, despachos = true, notas = true }) {
    const filtro = JSON.stringify({
        cedulas, escritos, despachos, notas,
        expId: Number(expId),
        accesoMinisterios: false,
        fechaNotificacionDesde: null,
        fechaNotificacionHasta: null,
    });
    const data = await getJson("/expedientes/actuaciones", { filtro, page, size }, { auth: true });
    const items = (data.content || []).map((a) => ({
        actId: a.actId,
        codigo: a.codigo,
        titulo: a.titulo,
        numero: a.numero,
        anio: a.anio,
        firmantes: a.firmantes,
        fechaFirma: epochADmy(a.fechaFirma),
        fechaPublicacion: epochADmy(a.fechaPublicacion),
        esCedula: a.esCedula === 1,
        esNota: a.esNota === 1,
    }));
    return { expId: Number(expId), total: data.totalElements ?? null, page, size, actuaciones: items };
}

async function listarPartes({ expId, page = 0, size = 20 }) {
    const data = await getJson("/expedientes/partes", { expId, accesoMinisterios: false, page, size }, { auth: true });
    const items = (data.content || []).map((p) => ({
        perId: p.perId,
        nombreApellido: p.nombreApellido,
        vinculo: p.vinculo,
        domicilios: (p.domicilios || []).map((d) => ({ tipo: d.tipoDomicilio, descripcion: (d.descripcion || "").trim() })),
    }));
    return { expId: Number(expId), total: data.totalElements ?? null, partes: items };
}

async function listarRelacionadas({ expId, page = 0, size = 20 }) {
    const data = await getJson("/expedientes/relacionados", { expId, accesoMinisterios: false, page, size }, { auth: true });
    return { expId: Number(expId), total: data.totalElements ?? null, relacionadas: data.content || [] };
}

async function listarAdjuntos({ actId, expId }) {
    const data = await getJson("/expedientes/actuaciones/adjuntos", { actId, expId, accesoMinisterios: false }, { auth: true });
    const items = (data.adjuntos || []).map((a) => ({
        adjId: a.adjId,
        titulo: a.titulo,
        fecha: epochADmy(a.fecha),
        nivelAcceso: a.nivelAccesoCod,
    }));
    return { actId: Number(actId), expId: Number(expId), adjuntos: items };
}

async function descargarPdf({ actId, expId, esNota = false, carpeta_base = "juscaba pdfs", nombre }) {
    const datos = JSON.stringify({
        actId: Number(actId),
        expId: Number(expId),
        esNota: !!esNota,
        cedulaId: null,
        cedulaIndexada: false,
        ministerios: false,
    });
    // Descarga binaria con tope duro: el timeout de axios cubre los headers pero
    // no aborta un cuerpo (arraybuffer) que se cuelga a mitad de stream. El
    // AbortController garantiza el corte del socket pase lo que pase.
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 60000);
    // Con sesion, la descarga va por la base autenticada + Bearer (PDFs de reservadas).
    const usarAuth = modoAutenticado();
    const basePdf = usarAuth ? BASE_AUTH : BASE_URL;
    const headersPdf = { ...HEADERS, Accept: "application/pdf,*/*" };
    if (usarAuth) { const t = await getTokenEje(); if (t) headersPdf.Authorization = "Bearer " + t; }
    let res;
    try {
        res = await axiosClient.get(`${basePdf}/expedientes/actuaciones/pdf`, {
            headers: headersPdf,
            params: { datos },
            responseType: "arraybuffer",
            signal: controller.signal,
            timeout: 60000,
            maxContentLength: 50 * 1024 * 1024,
            maxBodyLength: 50 * 1024 * 1024,
        });
    } finally {
        clearTimeout(abortTimer);
    }
    const fs = await import("fs");
    const path = await import("path");
    const resolvedBase = pathModule.isAbsolute(carpeta_base)
        ? carpeta_base
        : pathModule.join(__dirname, "..", "..", carpeta_base);
    fs.mkdirSync(resolvedBase, { recursive: true });
    const safe = (nombre || `exp${expId}_act${actId}`).replace(/[<>:"/\\|?*]/g, "").trim().slice(0, 150);
    const ruta = path.join(resolvedBase, `${safe}.pdf`);
    fs.writeFileSync(ruta, Buffer.from(res.data));
    return { archivo: ruta, bytes: res.data.byteLength };
}

// ---------------------------------------------------------------------------
// Mis Causas (cartera del abogado logueado) + sesion HITL
// ---------------------------------------------------------------------------
async function postListaAuth(info) {
    const t = await getTokenEje();
    const headers = { ...HEADERS, "Content-Type": "application/x-www-form-urlencoded" };
    if (t) headers.Authorization = "Bearer " + t;
    const body = "info=" + encodeURIComponent(JSON.stringify(info));
    const res = await axiosClient.post(`${BASE_AUTH}/expedientes/lista`, body, { headers });
    return res.data || {};
}

// Cartera EXACTA del letrado (filter causas:"1" - OJO: STRING "1", no booleano).
async function misCausas({ page = 0, size = 50, orden = "reciente", enriquecer = true }) {
    if (!modoAutenticado()) throw new Error("Mis Causas requiere sesion. Configura EJE_USUARIO/EJE_CLAVE (en .env o env del JSON) o usa iniciar_hitl_browser y logueate.");
    const info = { filter: JSON.stringify({ causas: "1" }), tipoBusqueda: "CAU", page, size, orden };
    const data = await postListaAuth(info);
    const ids = (data.content || []).map((c) => c.expId).filter((x) => x != null);
    if (!enriquecer) return { total: data.totalElements ?? ids.length, page, size, expIds: ids };
    const causas = [];
    for (const expId of ids) {
        try {
            const enc = await getJson("/expedientes/encabezado", { expId }, { forceAuth: true });
            let ultima = null;
            try {
                const ua = await getJson("/expedientes/ultimaAccion", { expId }, { forceAuth: true });
                const acc = ua && ua.ultimaAccion ? ua.ultimaAccion : null;
                ultima = acc ? { descripcion: acc.descripcion ?? acc.titulo, fecha: epochADmy(acc.fecha), tipo: acc.tipo } : null;
            } catch { /* opcional */ }
            causas.push({
                expId, cuij: enc.cuij, caratula: enc.caratula, tipoExpediente: enc.tipoExpediente,
                numero: enc.numero, anio: enc.anio, estado: enc.estadoAdministrativo,
                esPrivado: enc.esPrivado === 1, fechaInicio: epochADmy(enc.fechaInicio), ultimaActuacion: ultima,
            });
        } catch (e) { causas.push({ expId, error: String(e.message || e).slice(0, 120) }); }
        await sleep(100);
    }
    return { total: data.totalElements ?? null, page, size, devueltos: causas.length, causas };
}

// Captura el token de sesion del EJE por TRES vias (la SPA usa OAuth/OIDC):
//   1) Bearer en los requests salientes a /iol-api.
//   2) access_token en la RESPUESTA del endpoint OAuth (lo mas confiable: cae al
//      completarse el login, aunque todavia no haya requests a la API).
function instalarCapturaTokenEje(page) {
    page.on("request", (req) => {
        try {
            if (!req.url().includes("juscaba.gob.ar/iol-api")) return;
            const h = req.headers();
            const a = h["authorization"] || h["Authorization"];
            if (a && /^Bearer .{20,}/.test(a)) _ejeHitlToken = { token: a.slice(7), ts: Date.now() };
        } catch { /* nunca romper la pagina */ }
    });
    page.on("response", async (res) => {
        try {
            if (!/\/openid-connect\/token\b/.test(res.url())) return;
            const j = await res.json();
            if (j && j.access_token) _ejeHitlToken = { token: j.access_token, ts: Date.now() };
        } catch { /* respuesta no-JSON o ya consumida */ }
    });
}
// 3) Respaldo: leer el access_token del storage de la SPA (donde OAuth lo guarda).
async function leerTokenDeStorage() {
    if (!ejePageViva()) return null;
    try {
        const t = await _ejePage.evaluate(() => {
            const scan = (s) => {
                for (let i = 0; i < s.length; i++) {
                    const k = s.key(i), v = s.getItem(k);
                    if (!v) continue;
                    if (/access_token/i.test(k) && v.length > 40 && !/[{}]/.test(v)) return v;
                    if (/"access_token"/.test(v)) { try { const o = JSON.parse(v); if (o.access_token) return o.access_token; } catch { } }
                }
                return null;
            };
            return scan(window.localStorage) || scan(window.sessionStorage);
        });
        return t || null;
    } catch { return null; }
}
async function abrirNavegadorEje({ headless = false } = {}) {
    const { default: puppeteer } = await import("puppeteer");
    const fs = await import("fs");
    const dir = EJE_PROFILE_DIR || pathModule.join(__dirname, "..", "data", "hitl-juscaba");
    fs.mkdirSync(dir, { recursive: true });
    _ejeBrowser = await puppeteer.launch({ headless, defaultViewport: null, userDataDir: dir, args: headless ? [] : ["--start-maximized"] });
    _ejePage = (await _ejeBrowser.pages())[0] || (await _ejeBrowser.newPage());
    instalarCapturaTokenEje(_ejePage);
}
async function refrescarTokenHitl() {
    if (!ejePageViva()) return null;
    try { await _ejePage.reload({ waitUntil: "domcontentloaded", timeout: 45000 }); } catch { /* puede estar en login */ }
    for (let i = 0; i < 20; i++) { await sleep(500); if (_ejeHitlToken.token && Date.now() - _ejeHitlToken.ts < 4 * 60 * 1000) return _ejeHitlToken.token; }
    return _ejeHitlToken.token || null;
}

// Auto-login por miBA (identidad del GCBA). Abre el EJE; si el perfil ya tiene sesion
// entra solo; si cae al login, hace click en "Ingresar con miBA" y completa el form de
// miBA con EJE_USUARIO (email) y EJE_CLAVE. Best-effort: si miBA pide captcha/2FA o
// cambia el formulario, no cae token y el usuario tiene que destrabar (usar el modo HITL
// visible: EJE_HEADLESS sin setear, o iniciar_hitl_browser). Selectores capturados jul-2026.
const tokenHitlFrescoG = () => _ejeHitlToken.token && Date.now() - _ejeHitlToken.ts < 4 * 60 * 1000;
async function autoLoginMibaEje() {
    if (!ejePageViva()) await abrirNavegadorEje({ headless: ejeHeadless() });
    // La SPA (Angular) no redirige sola al login: hay que abrir el menu de usuario y
    // clickear "Iniciar Sesion", que dispara el OAuth y lleva a Keycloak.
    try { await _ejePage.goto("https://eje.juscaba.gob.ar/iol-ui/p/inicio", { waitUntil: "domcontentloaded", timeout: 90000 }); } catch { }
    for (let i = 0; i < 8 && !tokenHitlFrescoG(); i++) await sleep(1000); // sesion del perfil?
    if (tokenHitlFrescoG()) return _ejeHitlToken.token;
    try {
        // "Iniciar Sesion" es un .dropdown-item que vive SIEMPRE en el DOM (aunque el
        // menu de Bootstrap este cerrado): se clickea directo por texto, sin filtrar por
        // visibilidad. Eso dispara el OAuth de la SPA y navega a Keycloak.
        await _ejePage.waitForSelector(".dropdown-item", { timeout: 15000 });
        await Promise.all([
            _ejePage.evaluate(() => {
                const it = [...document.querySelectorAll(".dropdown-item, button, a")].find((e) => /iniciar sesi/i.test(e.textContent || ""));
                if (it) it.click();
            }),
            _ejePage.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => { }),
        ]);
        // Pantalla de login del EJE (Keycloak IOL-CABA): boton "Ingresar con miBA".
        await _ejePage.waitForSelector('a[href*="broker/miba"]', { timeout: 20000 });
        await Promise.all([
            _ejePage.click('a[href*="broker/miba"]'),
            _ejePage.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => { }),
        ]);
        // Pantalla de miBA (login.buenosaires.gob.ar): email + clave.
        await _ejePage.waitForSelector("#email", { timeout: 20000 });
        await _ejePage.type("#email", String(process.env.EJE_USUARIO), { delay: 15 });
        await _ejePage.type("#password-text-field", String(process.env.EJE_CLAVE), { delay: 15 });
        await Promise.all([
            _ejePage.click("#login").catch(() => _ejePage.keyboard.press("Enter")),
            _ejePage.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => { }),
        ]);
        for (let i = 0; i < 25 && !tokenHitlFrescoG(); i++) await sleep(1000);
    } catch { /* captcha/2FA o form distinto: queda para HITL visible */ }
    // Respaldo: si el listener no lo agarro pero ya estamos logueados, leerlo del storage.
    if (!tokenHitlFrescoG()) {
        const t = await leerTokenDeStorage();
        if (t) _ejeHitlToken = { token: t, ts: Date.now() };
    }
    return _ejeHitlToken.token || null;
}

// ---------------------------------------------------------------------------
// Servidor McpServer - patron estandar del proyecto
// ---------------------------------------------------------------------------

export const server = new McpServer({
    name: "juscaba-mcp",
    version: "1.0.0",
});

export function registerAllTools(server) {

    server.tool(
        "alcance_fuente",
        "Informa las capacidades, limitaciones y estado del conector de la Justicia de la Ciudad de Buenos Aires (JusCABA/EJE).",
        {},
        async () => {
            const info = {
                fuente: "Justicia de la Ciudad de Buenos Aires - EJE (Expediente Judicial Electronico)",
                portal: "https://eje.juscaba.gob.ar/iol-ui/",
                acceso: "Consulta PUBLICA sin login (causas publicas). OPCIONAL: capa AUTENTICADA para ver 'Mis Causas' (cartera del abogado) y las causas reservadas. Dos modos de login: A) EJE_USUARIO (CUIT) + EJE_CLAVE por entorno (.env o env del JSON); B) HITL con iniciar_hitl_browser (la clave no pasa por el conector).",
                modoActivo: hayCredencialesEje() ? "AUTENTICADO A - credenciales de entorno" : (ejePageViva() ? "AUTENTICADO B - HITL (navegador abierto)" : "PUBLICO (sin sesion)"),
                sesionAutenticada: modoAutenticado(),
                cubre: [
                    "Busqueda de causas por parte, numero, CUIJ o caratula (tipoBusqueda CAU).",
                    "Encabezado, ficha y fuero del expediente.",
                    "Actuaciones (escritos, despachos, cedulas, notas) con paginacion.",
                    "Partes/sujetos y causas relacionadas.",
                    "Ultima actuacion (monitoreo de novedades) y verificacion de sentencia.",
                    "Listado y descarga de PDFs adjuntos por actuacion.",
                    "AUTENTICADO: mis_causas (cartera exacta del letrado) y acceso a actuaciones/PDF de causas reservadas.",
                ],
                limitaciones: [
                    "Sin sesion: solo expedientes publicos; los privados/reservados devuelven code 1004.",
                    "Con sesion: se ven las causas donde el usuario es parte/letrado (incluidas reservadas).",
                    "El reconocimiento cubrio causas (CAU); otros tipos de busqueda no estan implementados.",
                    "Sin certificacion forense propia todavia.",
                ],
            };
            return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
        }
    );

    server.tool(
        "mis_causas",
        "Cartera EXACTA del abogado logueado en el EJE (JusCABA), incluidas las causas reservadas (penal/PCyF) que la consulta publica no muestra. Requiere sesion: credenciales EJE_USUARIO/EJE_CLAVE por entorno, o iniciar_hitl_browser + login del usuario.",
        {
            page: z.number().optional().default(0).describe("Pagina (0-based)."),
            size: z.number().optional().default(50).describe("Resultados por pagina."),
            orden: z.enum(["reciente", "antigua"]).optional().default("reciente").describe("Orden por fecha."),
            enriquecer: z.boolean().optional().default(true).describe("Si true, agrega caratula/estado/ultima actuacion por causa."),
        },
        async (args) => {
            try { return { content: [{ type: "text", text: JSON.stringify(await misCausas(args), null, 2) }] }; }
            catch (e) { return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }; }
        }
    );

    server.tool(
        "iniciar_hitl_browser",
        "Abre un navegador (HITL) en el EJE para que el USUARIO se loguee a mano y asi habilitar 'Mis Causas' y las reservadas (la clave no pasa por el conector). Alternativa a EJE_USUARIO/EJE_CLAVE. REGLA: avisale al usuario ANTES en tu mensaje previo ('se abre una ventana de Chromium; logueate en el EJE y avisame con un ok') y recien entonces llama con aviso_dado=true.",
        {
            aviso_dado: z.boolean().optional().default(false).describe("OBLIGATORIO en true. Confirma que ya le avisaste al usuario en tu mensaje ANTERIOR. Si no, NO llames esta tool."),
        },
        async (args) => {
            if (!args.aviso_dado) return { content: [{ type: "text", text: "NO se abrio la ventana. Primero avisale al usuario que se va a abrir Chromium para el EJE donde debe loguearse (su clave no pasa por el conector), y despues volve a llamar con aviso_dado=true." }], isError: true };
            if (ejePageViva()) return { content: [{ type: "text", text: "El navegador del EJE ya esta abierto; la sesion sigue viva." }] };
            try {
                await abrirNavegadorEje();
                await _ejePage.goto("https://eje.juscaba.gob.ar/iol-ui/", { waitUntil: "domcontentloaded", timeout: 90000 });
                for (let i = 0; i < 12 && !_ejeHitlToken.token; i++) await sleep(1000); // sesion del perfil?
                if (_ejeHitlToken.token) return { content: [{ type: "text", text: "Navegador abierto y SESION RECUPERADA del perfil: ya estas logueado. Podes llamar a mis_causas." }] };
                return { content: [{ type: "text", text: "Navegador abierto en el EJE. Decile al usuario: 'Logueate en la ventana con tu usuario y clave del EJE; si te ofrece guardar la clave, aceptale. Avisame con un ok'. Cuando confirme, llama a mis_causas: el conector toma el token de la sesion." }] };
            } catch (e) {
                _ejeBrowser = null; _ejePage = null;
                return { content: [{ type: "text", text: `No se pudo abrir el navegador: ${e.message}` }], isError: true };
            }
        }
    );

    server.tool(
        "estado_hitl",
        "Estado de la sesion del EJE: modo (publico/autenticado), si el navegador HITL esta abierto y si hay token capturado.",
        {},
        async () => {
            let url = null; try { if (ejePageViva()) url = _ejePage.url(); } catch { }
            return { content: [{ type: "text", text: JSON.stringify({
                modo: hayCredencialesEje() ? "credenciales (A)" : (ejePageViva() ? "HITL (B)" : "publico"),
                navegadorAbierto: ejePageViva(), url,
                tokenCapturado: !!_ejeHitlToken.token,
                credencialesConfiguradas: hayCredencialesEje(),
            }, null, 2) }] };
        }
    );

    server.tool(
        "finalizar_hitl_browser",
        "Cierra el navegador HITL del EJE y descarta el token de sesion de memoria.",
        {},
        async () => {
            try { if (_ejeBrowser) await _ejeBrowser.close(); } catch { }
            _ejeBrowser = null; _ejePage = null; _ejeHitlToken = { token: null, ts: 0 };
            return { content: [{ type: "text", text: "Sesion HITL del EJE cerrada; token descartado." }] };
        }
    );

    server.tool(
        "buscar_causas",
        "Busca causas en la Justicia de la Ciudad de Buenos Aires (JusCABA) por nombre de parte, numero, CUIJ o caratula. Devuelve cada causa con CUIJ, caratula, estado, fecha de inicio y ultima actuacion.",
        {
            criterio: z.string().describe("Texto a buscar: nombre de parte/abogado, numero, CUIJ o caratula."),
            page: z.number().optional().default(0).describe("Pagina (0-based). Default 0."),
            size: z.number().optional().default(10).describe("Resultados por pagina. Default 10."),
            enriquecer: z.boolean().optional().default(true).describe("Si true, agrega caratula/estado/ultima actuacion por cada causa. Si false, solo expIds (mas rapido)."),
        },
        async (args) => {
            try {
                const result = await buscarCausas(args);
                return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
            } catch (e) {
                return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
            }
        }
    );

    server.tool(
        "obtener_encabezado",
        "Obtiene el encabezado de una causa de JusCABA por expId: CUIJ, caratula, numero, anio, estado y fecha de inicio.",
        { expId: stringOrNumber.describe("expId de la causa (lo devuelve buscar_causas).") },
        async (args) => {
            try {
                const result = await obtenerEncabezado(args.expId);
                return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
            } catch (e) {
                return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
            }
        }
    );

    server.tool(
        "obtener_ficha",
        "Obtiene la ficha detallada de una causa de JusCABA (tribunal, objeto de juicio, ubicacion, etc.) por expId.",
        { expId: stringOrNumber.describe("expId de la causa.") },
        async (args) => {
            try {
                const data = await getJson("/expedientes/ficha", { expId: args.expId });
                return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
            } catch (e) {
                return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
            }
        }
    );

    server.tool(
        "obtener_fuero",
        "Obtiene el fuero de una causa de JusCABA (CAyT, PCyF, etc.) por expId.",
        { expId: stringOrNumber.describe("expId de la causa.") },
        async (args) => {
            try {
                const data = await getJson("/expedientes/fuero", { expId: args.expId, accesoMinisterios: false });
                return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
            } catch (e) {
                return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
            }
        }
    );

    server.tool(
        "listar_actuaciones",
        "Lista las actuaciones (escritos, despachos, cedulas, notas) de una causa de JusCABA por expId, con paginacion.",
        {
            expId: stringOrNumber.describe("expId de la causa."),
            page: z.number().optional().default(0).describe("Pagina (0-based). Default 0."),
            size: z.number().optional().default(20).describe("Actuaciones por pagina. Default 20."),
        },
        async (args) => {
            try {
                const result = await listarActuaciones({ expId: args.expId, page: args.page, size: args.size });
                return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
            } catch (e) {
                return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
            }
        }
    );

    server.tool(
        "listar_partes",
        "Lista las partes/sujetos de una causa de JusCABA por expId, con vinculo (actor, demandado, etc.) y domicilios.",
        {
            expId: stringOrNumber.describe("expId de la causa."),
            page: z.number().optional().default(0),
            size: z.number().optional().default(20),
        },
        async (args) => {
            try {
                const result = await listarPartes({ expId: args.expId, page: args.page, size: args.size });
                return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
            } catch (e) {
                return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
            }
        }
    );

    server.tool(
        "listar_relacionadas",
        "Lista las causas relacionadas (incidentes, apelaciones) de una causa de JusCABA por expId.",
        {
            expId: stringOrNumber.describe("expId de la causa."),
            page: z.number().optional().default(0),
            size: z.number().optional().default(20),
        },
        async (args) => {
            try {
                const result = await listarRelacionadas({ expId: args.expId, page: args.page, size: args.size });
                return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
            } catch (e) {
                return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
            }
        }
    );

    server.tool(
        "ultima_actuacion",
        "Obtiene la ultima actuacion de una causa de JusCABA por expId. Util para monitoreo de novedades.",
        { expId: stringOrNumber.describe("expId de la causa.") },
        async (args) => {
            try {
                const data = await getJson("/expedientes/ultimaAccion", { expId: args.expId });
                return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
            } catch (e) {
                return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
            }
        }
    );

    server.tool(
        "tiene_sentencia",
        "Verifica si una causa de JusCABA tiene sentencia, por expId. Devuelve true/false.",
        { expId: stringOrNumber.describe("expId de la causa.") },
        async (args) => {
            try {
                const data = await getJson("/expedientes/tieneSentencia", { expId: args.expId });
                return { content: [{ type: "text", text: JSON.stringify({ expId: Number(args.expId), tieneSentencia: data === true || data === "true" }, null, 2) }] };
            } catch (e) {
                return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
            }
        }
    );

    server.tool(
        "listar_adjuntos",
        "Lista los PDFs adjuntos de una actuacion de JusCABA. Requiere actId (de listar_actuaciones) y expId.",
        {
            actId: stringOrNumber.describe("actId de la actuacion (lo devuelve listar_actuaciones)."),
            expId: stringOrNumber.describe("expId de la causa."),
        },
        async (args) => {
            try {
                const result = await listarAdjuntos({ actId: args.actId, expId: args.expId });
                return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
            } catch (e) {
                return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
            }
        }
    );

    server.tool(
        "descargar_pdf",
        "Descarga el PDF de una actuacion de JusCABA a disco. Requiere actId y expId. Indicar esNota=true si la actuacion es una nota.",
        {
            actId: stringOrNumber.describe("actId de la actuacion."),
            expId: stringOrNumber.describe("expId de la causa."),
            esNota: z.boolean().optional().default(false).describe("true si la actuacion es una nota."),
            carpeta_base: z.string().optional().default("juscaba pdfs").describe("Carpeta de salida. Default 'juscaba pdfs'."),
            nombre: z.string().optional().describe("Nombre del archivo (sin extension). Default exp{expId}_act{actId}."),
        },
        async (args) => {
            try {
                const result = await descargarPdf(args);
                return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
            } catch (e) {
                return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
            }
        }
    );
}

registerAllTools(server);

// Guard de entorno identico al resto del proyecto.
if (
    typeof process !== "undefined" &&
    !process.env.VERCEL &&
    !process.env.NEXT_RUNTIME
) {
    const transport = new StdioServerTransport();
    server.connect(transport).catch((err) => {
        process.stderr.write(`[juscaba] error fatal: ${err.message}\n`);
        process.exit(1);
    });
    process.stderr.write("[juscaba] JusCABA (Justicia CABA) MCP Server is running via Stdio.\n");
}
