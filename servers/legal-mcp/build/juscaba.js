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

const HEADERS = {
    "Accept": "application/json",
    "Referer": "https://eje.juscaba.gob.ar/iol-ui/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
};

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

async function getJson(path, params) {
    const res = await axiosClient.get(`${BASE_URL}${path}`, { headers: HEADERS, params });
    return res.data;
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
    const enc = await getJson("/expedientes/encabezado", { expId });
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
    const data = await getJson("/expedientes/actuaciones", { filtro, page, size });
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
    const data = await getJson("/expedientes/partes", { expId, accesoMinisterios: false, page, size });
    const items = (data.content || []).map((p) => ({
        perId: p.perId,
        nombreApellido: p.nombreApellido,
        vinculo: p.vinculo,
        domicilios: (p.domicilios || []).map((d) => ({ tipo: d.tipoDomicilio, descripcion: (d.descripcion || "").trim() })),
    }));
    return { expId: Number(expId), total: data.totalElements ?? null, partes: items };
}

async function listarRelacionadas({ expId, page = 0, size = 20 }) {
    const data = await getJson("/expedientes/relacionados", { expId, accesoMinisterios: false, page, size });
    return { expId: Number(expId), total: data.totalElements ?? null, relacionadas: data.content || [] };
}

async function listarAdjuntos({ actId, expId }) {
    const data = await getJson("/expedientes/actuaciones/adjuntos", { actId, expId, accesoMinisterios: false });
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
    let res;
    try {
        res = await axiosClient.get(`${BASE_URL}/expedientes/actuaciones/pdf`, {
            headers: { ...HEADERS, Accept: "application/pdf,*/*" },
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
                acceso: "Consulta publica, sin autenticacion ni captcha. Solo datos publicos.",
                cubre: [
                    "Busqueda de causas por parte, numero, CUIJ o caratula (tipoBusqueda CAU).",
                    "Encabezado, ficha y fuero del expediente.",
                    "Actuaciones (escritos, despachos, cedulas, notas) con paginacion.",
                    "Partes/sujetos y causas relacionadas.",
                    "Ultima actuacion (monitoreo de novedades) y verificacion de sentencia.",
                    "Listado y descarga de PDFs adjuntos por actuacion.",
                ],
                limitaciones: [
                    "Solo expedientes publicos; los privados/estrictos no exponen contenido.",
                    "El reconocimiento cubrio causas (CAU); otros tipos de busqueda no estan implementados.",
                    "Sin certificacion forense propia todavia.",
                ],
            };
            return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
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
