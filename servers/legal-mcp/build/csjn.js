#!/usr/bin/env node
/**
 * csjn.js - Conector Jurisprudencia CSJN (Secretaria de Jurisprudencia) - 24/06/2026
 *
 * Base de SUMARIOS de la Corte Suprema de Justicia de la Nacion (1863-2026).
 * Portal: https://sjconsulta.csjn.gov.ar/sjconsulta/consultaSumarios/consulta.html
 *
 * --- Contrato de la API (mapeado por recon en vivo, 24/06/2026) ---
 * El portal es un front jQuery sobre un backend Java (Stripes, campos `filter.*`).
 * La busqueda es STATEFUL en la sesion del servidor y va en 3 pasos:
 *
 *   1) GET  /consultaSumarios/consulta.html          -> crea sesion (2 cookies)
 *   2) POST /consultaSumarios/buscar.html  (form)    -> guarda la busqueda en la
 *        sesion y devuelve HTML contenedor con `var totalResultados = "N"`.
 *   3) GET  /consultaSumarios/paginarSumarios.html?startIndex=K  -> JSON array de
 *        sumarios (10 por pagina) de la busqueda guardada en esa sesion.
 *
 * --- Detalle del fallo (mapeado 24/06/2026) ---
 * El sumario trae idDocumento (via linkDocumento) pero NO trae idAnalisis. El
 * analisis documental se pide por idAnalisis, no por idDocumento. Flujo:
 *
 *   a) GET /documentos/verDocumentoByIdLinksJSP.html?idDocumento=ID -> HTML del
 *      visor; de ahi se extrae `var idAnalisis = '...'` (fuente confiable).
 *      Fallback empirico si el regex falla: idAnalisis = floor(idDocumento/10)
 *      (observado en recon, NO documentado; se marca como aproximado).
 *   b) GET /fallos/abrirAnalisis.html?idAnalisis=IDA   -> JSON analisis documental
 *      (competencia, recurso, sentido, remision, voces, normas, votos, destacado).
 *   c) GET /sumarios/getSumariosAnalisis.html?idAnalisis=IDA -> JSON sumarios del
 *      fallo.
 *   PDF del fallo: /documentos/verDocumentoById.html?idDocumento=ID  (no LinksJSP).
 *
 * --- WAF (critico) ---
 * El sitio esta detras de un Web Application Firewall con firma por cliente. Un
 * `curl.exe` pelado recibe 403 (pagina "Web Application Firewall", ~35KB) por su
 * fingerprint TLS. Node (stack TLS del sistema, igual que Invoke-WebRequest de
 * Windows) SI pasa. Igualmente mandamos headers de navegador y, sobre todo,
 * respetamos el flujo con cookies de sesion: sin el GET inicial, el POST da 500.
 *
 * --- Campos del formulario (POST /buscar.html) ---
 *   filter.fullText   texto libre (min 3 chars; max 4000)
 *   filter.terminos   modo: T=todas, A=algunas, E=frase exacta, C=cercanas
 *   filter.autos      caratula (min 3 chars)
 *   filter.fechaExacta / filter.fechaDesde / filter.fechaHasta   dd/mm/yyyy
 *   filter.tomo       tomo de Fallos (numerico)
 *   filter.pagina     pagina de Fallos (numerico)
 *   filter.idsVocesElegidas  (repetible) codigos de voz; no usado aun
 *   g-recaptcha-response     se manda vacio; el backend no lo valida en este flujo
 *
 * Sin credenciales. Solo lectura de jurisprudencia publica.
 */
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
const axiosClient = axios.create({ timeout: 45000 });
installTlsFallback(axiosClient, "csjn");

const BASE = "https://sjconsulta.csjn.gov.ar/sjconsulta";
const CONSULTA_URL = `${BASE}/consultaSumarios/consulta.html`;
const BUSCAR_URL = `${BASE}/consultaSumarios/buscar.html`;
const PAGINAR_URL = `${BASE}/consultaSumarios/paginarSumarios.html`;
const VISOR_URL = `${BASE}/documentos/verDocumentoByIdLinksJSP.html`;   // HTML del visor (de ahi sale idAnalisis)
const ANALISIS_URL = `${BASE}/fallos/abrirAnalisis.html`;               // JSON analisis documental (por idAnalisis)
const SUMARIOS_ANALISIS_URL = `${BASE}/sumarios/getSumariosAnalisis.html`; // JSON sumarios del fallo (por idAnalisis)
const PDF_URL = `${BASE}/documentos/verDocumentoById.html`;             // PDF del fallo (por idDocumento)

// Headers de navegador para no quedar pegados en el WAF por firma de cliente.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const BASE_HEADERS = {
    "User-Agent": UA,
    "Accept-Language": "es-AR,es;q=0.9",
};

// Mapa de modos de busqueda expuestos -> codigo del backend.
const MODO_A_CODIGO = {
    todas: "T",
    algunas: "A",
    exacta: "E",
    cercanas: "C",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Cookie jar minimo (sin dependencias). El flujo es stateful: las cookies que
// emite el GET inicial deben viajar en el POST y en el GET de paginado.
// ---------------------------------------------------------------------------
function parseSetCookie(setCookieArr) {
    const jar = {};
    for (const raw of setCookieArr || []) {
        const first = String(raw).split(";")[0];
        const eq = first.indexOf("=");
        if (eq > 0) {
            const k = first.slice(0, eq).trim();
            const v = first.slice(eq + 1).trim();
            if (k) jar[k] = v;
        }
    }
    return jar;
}

function jarToHeader(jar) {
    return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
}

// ---------------------------------------------------------------------------
// Limpieza de texto: el portal devuelve sumarios con HTML (<p>, <font>, etc.)
// y entidades. Para uso por un LLM conviene texto plano.
// ---------------------------------------------------------------------------
function htmlAtexto(html) {
    if (html == null) return "";
    return String(html)
        .replace(/<\s*br\s*\/?\s*>/gi, "\n")
        .replace(/<\/\s*p\s*>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&aacute;/g, "a").replace(/&eacute;/g, "e").replace(/&iacute;/g, "i")
        .replace(/&oacute;/g, "o").replace(/&uacute;/g, "u").replace(/&ntilde;/g, "n")
        .replace(/&Aacute;/g, "A").replace(/&Eacute;/g, "E").replace(/&Iacute;/g, "I")
        .replace(/&Oacute;/g, "O").replace(/&Uacute;/g, "U").replace(/&Ntilde;/g, "N")
        .replace(/&ordm;/g, "o").replace(/&ndash;/g, "-").replace(/&ensp;/g, " ")
        .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"')
        .replace(/&#013;/g, "\n").replace(/&#\d+;/g, " ")
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function val(obj) {
    // Muchos campos vienen como { valor: "X", ... }. Extrae el valor legible.
    if (obj == null) return null;
    if (typeof obj === "string") return obj.trim();
    if (typeof obj === "object" && obj.valor != null) return String(obj.valor).trim();
    return null;
}

function extraerIdDocumento(link) {
    if (!link) return null;
    const m = String(link).match(/idDocumento=(\d+)/);
    return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Logica de negocio
// ---------------------------------------------------------------------------

// Paso 1+2: abre sesion y postea la busqueda. Devuelve { jar, total }.
async function abrirBusqueda(filtros) {
    // 1) GET para la sesion
    const g = await axiosClient.get(CONSULTA_URL, {
        headers: BASE_HEADERS,
        maxRedirects: 5,
        validateStatus: (s) => s >= 200 && s < 400,
    });
    const jar = parseSetCookie(g.headers["set-cookie"]);

    // 2) POST del formulario completo (todos los filter.* presentes, como el front)
    const form = new URLSearchParams();
    form.set("filter.fullText", filtros.texto ?? "");
    form.set("filter.terminos", filtros.modo ?? "T");
    form.set("filter.autos", filtros.autos ?? "");
    form.set("filter.fechaExacta", filtros.fechaExacta ?? "");
    form.set("filter.fechaDesde", filtros.fechaDesde ?? "");
    form.set("filter.fechaHasta", filtros.fechaHasta ?? "");
    form.set("filter.tomo", filtros.tomo ?? "");
    form.set("filter.pagina", filtros.pagina ?? "");
    form.set("g-recaptcha-response", "");

    const p = await axiosClient.post(BUSCAR_URL, form.toString(), {
        headers: {
            ...BASE_HEADERS,
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "X-Requested-With": "XMLHttpRequest",
            "Referer": CONSULTA_URL,
            "Origin": "https://sjconsulta.csjn.gov.ar",
            "Cookie": jarToHeader(jar),
        },
        maxRedirects: 5,
        validateStatus: (s) => s >= 200 && s < 400,
    });

    // refrescar jar si el POST renovo cookies
    Object.assign(jar, parseSetCookie(p.headers["set-cookie"]));

    const html = String(p.data || "");
    if (/Web Application Firewall/i.test(html)) {
        throw new Error("Bloqueado por el WAF de la CSJN (firma de cliente). El conector pasa con Node nativo; revisar headers/TLS si esto persiste.");
    }
    const mTot = html.match(/var\s+totalResultados\s*=\s*"?(\d+)"?/);
    const total = mTot ? Number(mTot[1]) : null;
    return { jar, total };
}

// Paso 3: trae una pagina de sumarios (JSON) de la busqueda ya abierta.
async function traerPagina(jar, startIndex) {
    const r = await axiosClient.get(PAGINAR_URL, {
        headers: {
            ...BASE_HEADERS,
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "X-Requested-With": "XMLHttpRequest",
            "Referer": BUSCAR_URL,
            "Cookie": jarToHeader(jar),
        },
        params: { startIndex },
        validateStatus: (s) => s >= 200 && s < 400,
    });
    if (typeof r.data === "string") {
        // por si el server contesta texto: intentar parsear
        try { return JSON.parse(r.data); } catch { return []; }
    }
    return Array.isArray(r.data) ? r.data : [];
}

// Mapea un sumario crudo a una vista legible y compacta.
function mapearSumario(s) {
    const ad = s.analisisDocumental || {};
    const ministros = (ad.votosAnalisisDocumental || [])
        .flatMap((v) => (v.ministros || []).map((m) => m.descripcion))
        .filter(Boolean);
    const tipoVoto = (ad.votosAnalisisDocumental || [])
        .map((v) => v.tipoVoto && v.tipoVoto.descripcion)
        .filter(Boolean)[0] || null;
    const normas = (ad.referenciasNormativas || []).map((rn) => {
        const tipo = val(rn.norma) || "NORMA";
        const num = rn.numeroNorma != null ? ` ${rn.numeroNorma}` : "";
        const art = rn.articulo ? `, art. ${rn.articulo}` : "";
        const inc = rn.inciso ? `, inc. ${rn.inciso}` : "";
        return `${tipo}${num}${art}${inc}`.trim();
    });
    const fallos = (s.tomo != null && s.pagina != null) ? `Fallos ${s.tomo}:${s.pagina}` : null;
    const destacado = ad.falloDestacado
        ? { titulo: ad.falloDestacado.titulo || null, sintesis: htmlAtexto(ad.falloDestacado.cabecilla) || null }
        : null;

    return {
        id: s.id,
        idDocumento: extraerIdDocumento(s.linkDocumento),
        fecha: s.fechaString || null,
        caratula: s.autos || s.caratulaWeb || null,
        cita: fallos,
        expediente: s.numeroExpediente || null,
        voces: s.voces ? String(s.voces).split(" - ").map((x) => x.trim()).filter(Boolean) : [],
        sumario: htmlAtexto(s.texto),
        sentidoPronunciamiento: val(ad.sentidoPronunciamiento),
        tipoRecurso: val(ad.tipoRecurso),
        competencia: val(ad.competencia),
        remision: val(ad.remision),
        materia: val(ad.materiaSecretaria),
        ministros,
        tipoVoto,
        normasCitadas: normas,
        falloDestacado: destacado,
        // documentos descargables (dictamenes, etc.) por idDocumento
        documentos: (s.documentosDTO || []).map((d) => ({
            idDocumento: extraerIdDocumento(d.link) || (d.id != null ? String(d.id) : null),
            tipo: d.tipoDocumento || null,
            fecha: d.fecha || null,
            etiqueta: d.etiqueta || null,
        })),
    };
}

// Busqueda de alto nivel: abre sesion, postea, y trae N paginas (10 c/u).
async function buscarSumarios({ texto = "", modo = "todas", autos = "", fechaDesde = "", fechaHasta = "", fechaExacta = "", tomo = "", pagina = "", maxResultados = 10 }) {
    const modoCod = MODO_A_CODIGO[String(modo).toLowerCase()] || "T";
    if (texto && texto.length > 0 && texto.length < 3) {
        throw new Error("El texto a buscar debe tener al menos 3 caracteres.");
    }
    if (autos && autos.length > 0 && autos.length < 3) {
        throw new Error("Los autos (caratula) deben tener al menos 3 caracteres.");
    }

    const { jar, total } = await abrirBusqueda({
        texto, modo: modoCod, autos,
        fechaDesde, fechaHasta, fechaExacta, tomo, pagina,
    });

    if (total === 0) {
        return { total: 0, devueltos: 0, sumarios: [] };
    }

    const limite = Math.max(1, Math.min(Number(maxResultados) || 10, 50));
    const sumarios = [];
    let startIndex = 0;
    // pagina de 10; iteramos hasta cubrir el limite o agotar resultados
    while (sumarios.length < limite && (total == null || startIndex < total)) {
        const lote = await traerPagina(jar, startIndex);
        if (!lote.length) break;
        for (const s of lote) {
            sumarios.push(mapearSumario(s));
            if (sumarios.length >= limite) break;
        }
        startIndex += 10;
        if (sumarios.length < limite) await sleep(150); // buen ciudadano
    }

    return {
        total: total ?? null,
        devueltos: sumarios.length,
        criterio: { texto, modo, autos, fechaDesde, fechaHasta, fechaExacta, tomo, pagina },
        sumarios,
    };
}

// Resuelve el idAnalisis a partir del idDocumento. Fuente confiable: el HTML del
// visor expone `var idAnalisis = '...'`. Devuelve { idAnalisis, fuente }.
async function resolverIdAnalisis(idDocumento) {
    try {
        const r = await axiosClient.get(VISOR_URL, {
            headers: {
                ...BASE_HEADERS,
                "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
                "Referer": CONSULTA_URL,
            },
            params: { idDocumento },
            validateStatus: (s) => s >= 200 && s < 400,
        });
        const html = String(r.data || "");
        if (/Web Application Firewall/i.test(html)) {
            throw new Error("WAF");
        }
        const m = html.match(/var\s+idAnalisis\s*=\s*'(\d+)'/);
        if (m) return { idAnalisis: m[1], fuente: "visor" };
    } catch {
        /* cae al fallback */
    }
    // Fallback empirico (NO documentado): idAnalisis = floor(idDocumento/10).
    const n = Number(idDocumento);
    if (Number.isFinite(n) && n >= 10) {
        return { idAnalisis: String(Math.floor(n / 10)), fuente: "derivado_aproximado" };
    }
    return { idAnalisis: null, fuente: "no_resuelto" };
}

async function getJsonAnalisis(url, idAnalisis) {
    const r = await axiosClient.get(url, {
        headers: {
            ...BASE_HEADERS,
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "X-Requested-With": "XMLHttpRequest",
            "Referer": CONSULTA_URL,
        },
        params: { idAnalisis },
        validateStatus: (s) => s >= 200 && s < 400,
    });
    let data = r.data;
    if (typeof data === "string") {
        try { data = JSON.parse(data); } catch { return null; }
    }
    return data;
}

// ---------------------------------------------------------------------------
// Parseo del cuerpo del PDF (best-effort). El analisis documental (JSON) a veces
// no trae normas (referenciasNormativas vacio) y nunca trae el texto de los
// votos; el cuerpo del fallo si. PERO muchos fallos son escaneos con OCR sucio:
// las firmas quedan ilegibles y puede haber digitos corrompidos (p.ej. un tomo
// de Fallos). Por eso esto se devuelve etiquetado como extraccion automatica y
// SEPARADO de analisis.normasConsideradas (la fuente documental autoritativa).
// Asi la provenance queda explicita: quien lee sabe que esto salio del PDF.
// ---------------------------------------------------------------------------
async function bajarPdfBuffer(idDocumento) {
    const r = await axiosClient.get(PDF_URL, {
        headers: {
            ...BASE_HEADERS,
            "Accept": "application/pdf,*/*;q=0.8",
            "Referer": CONSULTA_URL,
        },
        params: { idDocumento },
        responseType: "arraybuffer",
        validateStatus: (s) => s >= 200 && s < 400,
    });
    const buf = Buffer.from(r.data);
    // El WAF responde HTML; un PDF real empieza con "%PDF".
    if (buf.slice(0, 4).toString("latin1") !== "%PDF") {
        const txt = buf.toString("latin1");
        if (/Web Application Firewall/i.test(txt)) throw new Error("WAF al bajar el PDF");
        throw new Error("La respuesta del endpoint de PDF no es un PDF.");
    }
    return buf;
}

// Une palabras cortadas a fin de linea y colapsa saltos: deja un texto corrido
// apto para correr regex de citas normativas.
function normalizarCuerpo(texto) {
    return String(texto || "")
        .replace(/-\n(?=[a-záéíóúñ])/g, "")
        .replace(/\n/g, " ")
        .replace(/\s{2,}/g, " ");
}

// Extrae citas normativas del cuerpo. Captura corridas (listas con ; , o "y")
// para no perder los Fallos/decretos encadenados. NO verifica: es best-effort.
function extraerNormasDeTexto(t) {
    const leyes = new Set(), decretos = new Set(), fallos = new Set(), otros = new Set();
    for (const m of t.matchAll(/\bley(?:es)?\s+(?:n[º°.]?\s*)?(\d{1,3}(?:[.\s]\d{3})*)/gi))
        leyes.add(m[1].replace(/\s/g, ""));
    for (const m of t.matchAll(/\bdecretos?\s+(?:nacional(?:es)?\s+)?(?:n[º°.]?\s*)?((?:\d{1,5}\/\d{2,4}(?:\s*,\s*)?)+)/gi))
        for (const d of m[1].matchAll(/\d{1,5}\/\d{2,4}/g)) decretos.add(d[0]);
    for (const m of t.matchAll(/\bFallos:\s*((?:\d{3}\s*:\s*\d+(?:\s*[;,]\s*|\s+y\s+)?)+)/gi))
        for (const f of m[1].matchAll(/(\d{3})\s*:\s*(\d+)/g)) fallos.add(`${f[1]}:${f[2]}`);
    if (/art[íi]?c?u?l?o?\.?\s+18\s+de\s+la\s+Constituci[óo]n/i.test(t)) otros.add("art. 18 CN");
    for (const m of t.matchAll(/art[íi]?c?u?l?o?\.?\s+(\d+)\s+del\s+C[óo]digo\s+Procesal\s+Civil/gi))
        otros.add(`art. ${m[1]} CPCCN`);
    if (/art[íi]?c?u?l?o?\.?\s+14\s+(?:de\s+la\s+)?ley\s+48/i.test(t)) otros.add("art. 14 ley 48");
    if (/Estatuto\s+de\s+Roma/i.test(t)) otros.add("Estatuto de Roma");
    if (/N[üu]remberg/i.test(t)) otros.add("Estatuto del TMI de Nuremberg");
    return { leyes: [...leyes], decretos: [...decretos], fallos: [...fallos], otros: [...otros] };
}

// Detecta encabezados de voto/disidencia por separado en el cuerpo. Tolera que
// el OCR rompa el prefijo "VOTO" (visto como "-//-TO"). Es un cross-check: la
// firma escaneada de la mayoria suele ser ilegible, asi que NO se intenta leer.
function detectarVotosSeparados(t) {
    const re = /(?:VOTO|[-/~]{0,4}TO|DISIDENCIA(?:\s+PARCIAL)?)\s+DE[LA]?\s+(?:L[OA]S?\s+)?SE[ÑN]ORE?A?S?\s+MINISTROS?\s+DOCTORE?A?S?\s+DO[ÑN]A?\s+([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ.\s'Y-]{4,60}?)\s+Considerando/gi;
    const out = [];
    for (const m of t.matchAll(re)) {
        const nom = m[1].replace(/\s+/g, " ").trim();
        if (nom && !out.includes(nom)) out.push(nom);
    }
    return out;
}

// Baja el PDF y devuelve el bloque cuerpoFallo. Degrada con gracia: si el PDF no
// baja, no tiene texto, o pdf-parse falla (p.ej. version de Node), devuelve
// disponible:false con advertencia y NO rompe el resto de la respuesta.
async function parsearCuerpoPdf(idDocumento) {
    try {
        const buf = await bajarPdfBuffer(idDocumento);
        const { PDFParse } = await import("pdf-parse");
        const parser = new PDFParse({ data: buf });
        let texto = "";
        try {
            const res = await parser.getText();
            texto = (res && res.text) ? res.text : "";
        } finally {
            await parser.destroy().catch(() => {});
        }
        if (!texto.trim()) {
            return { disponible: false, advertencia: "El PDF no expone texto extraible (posible escaneo sin capa OCR)." };
        }
        const t = normalizarCuerpo(texto);
        return {
            fuente: "extraccion_automatica_pdf",
            disponible: true,
            caracteres: texto.length,
            normasCitadas: extraerNormasDeTexto(t),
            votosSeparadosDetectados: detectarVotosSeparados(t),
            nota: "Extraccion best-effort sobre el text-layer del PDF, SEPARADA del analisis documental. En fallos escaneados el OCR puede corromper digitos (un tomo de Fallos, una fecha) y vuelve ilegibles las firmas; los votos por separado se detectan por encabezado, no por la firma de la mayoria. Verificar contra el PDF antes de citar.",
        };
    } catch (e) {
        return { disponible: false, advertencia: `No se pudo parsear el cuerpo del PDF: ${e.message}` };
    }
}

// Detalle del fallo por idDocumento: resuelve idAnalisis, trae analisis documental
// y sumarios del fallo, y arma el link al PDF.
async function obtenerDocumento(idDocumento, incluirCuerpo = true) {
    const { idAnalisis, fuente } = await resolverIdAnalisis(idDocumento);
    const pdf = `${PDF_URL}?idDocumento=${encodeURIComponent(idDocumento)}`;

    if (!idAnalisis) {
        return {
            idDocumento: String(idDocumento),
            idAnalisis: null,
            advertencia: "No se pudo resolver el idAnalisis del fallo. Se devuelve solo el link al PDF.",
            pdf,
        };
    }

    const ad = await getJsonAnalisis(ANALISIS_URL, idAnalisis);
    const sumariosRaw = await getJsonAnalisis(SUMARIOS_ANALISIS_URL, idAnalisis);

    const out = {
        idDocumento: String(idDocumento),
        idAnalisis: String(idAnalisis),
        fuenteIdAnalisis: fuente, // "visor" (confiable) o "derivado_aproximado"
        pdf,
    };

    if (ad && typeof ad === "object") {
        const gruposVoto = (ad.votosAnalisisDocumental || ad.votos || []).map((v) => ({
            tipo: (v.tipoVoto && (v.tipoVoto.descripcion || v.tipoVoto.valor)) || null,
            ministros: (v.ministros || [])
                .map((m) => m.descripcion || (m.ministro && m.ministro.descripcion))
                .filter(Boolean),
        })).filter((g) => g.ministros.length);
        const ministros = gruposVoto.flatMap((g) => g.ministros);
        out.analisis = {
            competencia: val(ad.competencia),
            tipoRecurso: val(ad.tipoRecurso),
            sentidoPronunciamiento: val(ad.sentidoPronunciamiento),
            remision: val(ad.remision),
            inconstitucional: ad.inconstitucional === true || ad.inconstitucional === "S",
            voces: Array.isArray(ad.voces)
                ? ad.voces.map((v) => v.tipoVoz && v.tipoVoz.valor)
                    .filter((v) => v && /[A-Za-zÁÉÍÓÚÑ]/.test(v))
                : [],
            normasConsideradas: (ad.referenciasNormativas || []).map((rn) => {
                const tipo = val(rn.norma) || "NORMA";
                const num = rn.numeroNorma != null ? ` ${rn.numeroNorma}` : "";
                const anio = rn.anioNorma ? `/${rn.anioNorma}` : "";
                const art = rn.articulo ? `, art. ${rn.articulo}` : "";
                const inc = rn.inciso ? `, inc. ${rn.inciso}` : "";
                const incon = (rn.inconstitucional === "S") ? " [declara inconstitucionalidad]" : "";
                return `${tipo}${num}${anio}${art}${inc}${incon}`.trim();
            }),
            ministros,
            votos: gruposVoto,
            observaciones: htmlAtexto(ad.observaciones) || null,
            falloDestacado: ad.falloDestacado
                ? { titulo: ad.falloDestacado.titulo || null, sintesis: htmlAtexto(ad.falloDestacado.cabecilla) || null }
                : null,
        };
    } else {
        out.analisis = null;
        out.advertencia = "No se pudo recuperar el analisis documental (abrirAnalisis no devolvio JSON).";
    }

    if (Array.isArray(sumariosRaw) && sumariosRaw.length) {
        out.sumarios = sumariosRaw
            .filter((s) => s.publico == null || s.publico === "S")
            .map((s) => ({
                id: s.id,
                voces: s.voces ? String(s.voces).split(" - ").map((x) => x.trim()).filter(Boolean) : [],
                texto: htmlAtexto(s.texto),
                holding: s.holding > 0 || undefined,
            }));
    } else {
        out.sumarios = [];
    }

    if (incluirCuerpo) {
        out.cuerpoFallo = await parsearCuerpoPdf(idDocumento);
    }

    return out;
}

// ---------------------------------------------------------------------------
// Servidor McpServer - patron estandar del proyecto
// ---------------------------------------------------------------------------

export const server = new McpServer({
    name: "csjn-mcp",
    version: "1.0.0",
});

export function registerAllTools(server) {

    server.tool(
        "alcance_fuente",
        "Informa las capacidades, cobertura y limitaciones del conector de Jurisprudencia de la CSJN (base de Sumarios, Secretaria de Jurisprudencia).",
        {},
        async () => {
            const info = {
                fuente: "Corte Suprema de Justicia de la Nacion - Secretaria de Jurisprudencia (base de Sumarios)",
                portal: "https://sjconsulta.csjn.gov.ar/sjconsulta/consultaSumarios/consulta.html",
                cobertura: "Sumarios de fallos de la CSJN, 1863-2026.",
                acceso: "Consulta publica, sin autenticacion ni captcha. Solo jurisprudencia publica.",
                cubre: [
                    "Busqueda de sumarios por texto libre (modos: todas/algunas/exacta/cercanas).",
                    "Filtros por caratula (autos), rango de fechas o fecha exacta, y tomo:pagina de Fallos.",
                    "Cada sumario: caratula, fecha, cita Fallos, voces, sentido del pronunciamiento, recurso, competencia, ministros, tipo de voto, normas citadas y fallo destacado.",
                    "Detalle del fallo por idDocumento: analisis documental completo, sumarios del fallo y link al PDF.",
                ],
                limitaciones: [
                    "El sitio esta detras de un WAF con firma de cliente: corre bien desde Node nativo, pero un fetch con fingerprint atipico puede recibir 403.",
                    "La busqueda es stateful (sesion del servidor): cada consulta abre su propia sesion y pagina de a 10.",
                    "El sumario no expone idAnalisis; obtener_documento lo resuelve leyendo el visor (si falla, lo deriva de forma aproximada y lo marca).",
                    "Solo la base de SUMARIOS. 'Todos los Fallos' y la base de Recurso Extraordinario (REX) tienen endpoints propios y aun no estan integrados.",
                    "Filtro por 'voces' (codigos tematicos) no implementado todavia.",
                    "Sin certificacion forense propia todavia.",
                ],
            };
            return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
        }
    );

    server.tool(
        "buscar_sumarios",
        "Busca sumarios de jurisprudencia de la CSJN (1863-2026) por texto libre y filtros. Devuelve cada sumario con caratula, fecha, cita de Fallos, voces, sentido del pronunciamiento, ministros, normas citadas y, si corresponde, el fallo destacado. Usar obtener_documento con el idDocumento para el detalle.",
        {
            texto: z.string().optional().default("").describe("Texto libre a buscar en el sumario (min 3 caracteres)."),
            modo: z.enum(["todas", "algunas", "exacta", "cercanas"]).optional().default("todas").describe("Modo de coincidencia del texto: todas las palabras, algunas, frase exacta o palabras cercanas."),
            autos: z.string().optional().default("").describe("Filtro por caratula/autos (min 3 caracteres)."),
            fechaDesde: z.string().optional().default("").describe("Fecha desde, formato dd/mm/yyyy."),
            fechaHasta: z.string().optional().default("").describe("Fecha hasta, formato dd/mm/yyyy."),
            fechaExacta: z.string().optional().default("").describe("Fecha exacta, formato dd/mm/yyyy."),
            tomo: z.string().optional().default("").describe("Tomo de la coleccion Fallos (numerico)."),
            pagina: z.string().optional().default("").describe("Pagina de la coleccion Fallos (numerico)."),
            maxResultados: z.number().optional().default(10).describe("Cantidad maxima de sumarios a devolver (1-50). Pagina de a 10."),
        },
        async (args) => {
            try {
                if (!args.texto && !args.autos && !args.fechaDesde && !args.fechaHasta && !args.fechaExacta && !args.tomo) {
                    return { content: [{ type: "text", text: "Indica al menos un criterio: texto, autos, un filtro de fecha o tomo." }], isError: true };
                }
                const result = await buscarSumarios(args);
                return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
            } catch (e) {
                return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
            }
        }
    );

    server.tool(
        "obtener_documento",
        "Obtiene el detalle de un fallo de la CSJN por su idDocumento (devuelto por buscar_sumarios): analisis documental (competencia, recurso, sentido, remision, voces, normas consideradas, ministros, votos, observaciones, fallo destacado), los sumarios del fallo y el link al PDF. Resuelve internamente el idAnalisis leyendo el visor del fallo. Con incluirCuerpo=true (defecto) ademas baja el PDF y agrega un bloque cuerpoFallo con las normas citadas y los votos separados detectados en el texto, etiquetado como extraccion automatica best-effort y separado del analisis documental.",
        {
            idDocumento: z.union([z.string(), z.number()]).transform((v) => String(v)).describe("idDocumento del fallo, devuelto por buscar_sumarios (campo idDocumento)."),
            incluirCuerpo: z.boolean().optional().default(true).describe("Si es true (defecto), baja y parsea el cuerpo del PDF para extraer normas citadas y detectar votos separados (best-effort, etiquetado como extraccion automatica y separado del analisis documental). false = respuesta mas rapida y liviana, solo con el analisis documental."),
        },
        async (args) => {
            try {
                const result = await obtenerDocumento(args.idDocumento, args.incluirCuerpo);
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
        process.stderr.write(`[csjn] error fatal: ${err.message}\n`);
        process.exit(1);
    });
    process.stderr.write("[csjn] Jurisprudencia CSJN (Sumarios) MCP Server is running via Stdio.\n");
}
