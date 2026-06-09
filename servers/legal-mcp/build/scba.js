#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios from "axios";
import * as cheerio from "cheerio";
import https from "https";
import { fileURLToPath } from "url";
import * as pathModule from "path";

// FIX: __dirname anclado al módulo para uso en guardar_documentos_en_disco
const __filename = fileURLToPath(import.meta.url);
const __dirname = pathModule.dirname(__filename);

// NOTA DE SEGURIDAD: rejectUnauthorized: false es INTENCIONAL y AISLADO a este conector.
// sentencias.scba.gov.ar presenta un certificado con cadena de confianza rota (cert intermedio
// no servido por el servidor). Todos los demas conectores usan validacion TLS estandar.
// CWE-295 aceptado como riesgo residual documentado: el trafico es de lectura publica
// (jurisprudencia SCBA) y no involucra credenciales ni datos sensibles del usuario.
const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const axiosClient = axios.create({ httpsAgent, timeout: 30000 });

const BASE_URL = "https://sentencias.scba.gov.ar/RegistroElectronico";

const ID_REGISTRO = { sentencias: "1", resoluciones: "2" };

const HEADERS = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/html, */*",
    "Referer": "https://sentencias.scba.gov.ar/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
};

// ---------------------------------------------------------------------------
// Helpers HTML
// ---------------------------------------------------------------------------

function extraerOptions(html) {
    const re = /<option\s+value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/gi;
    const items = [];
    let m;
    while ((m = re.exec(html)) !== null) {
        const value = m[1].trim();
        const text = m[2]
            .replace(/&#xBA;/g, "º").replace(/&#xB0;/g, "°")
            .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
            .trim();
        if (value && value !== "-1") items.push({ value, text });
    }
    return items;
}

function extraerFilas(raw) {
    try {
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (parsed && Array.isArray(parsed.data)) return parsed.data;
        if (parsed && Array.isArray(parsed)) return parsed;
    } catch { /* no es JSON */ }
    return [];
}

/**
 * Extrae texto de .card-body usando cheerio en lugar de regex,
 * para capturar correctamente el contenido con divs anidados.
 * FIX: el regex original capturaba solo hasta el primer </div> hijo.
 */
function extraerTextoDocumento(html) {
    const $ = cheerio.load(html);
    const partes = [];
    $('[class*="card-body"]').each((_, el) => {
        const texto = $(el).text().replace(/\s+/g, " ").trim();
        if (texto) partes.push(texto);
    });
    if (partes.length) return partes.join("\n");
    // Fallback: texto plano de todo el body
    return $("body").text().replace(/\s+/g, " ").trim();
}

function limpiarNombre(texto) {
    return texto.replace(/[<>:"/\\|?*]/g, "").trim().slice(0, 150);
}

// ---------------------------------------------------------------------------
// Logica de negocio
// ---------------------------------------------------------------------------

async function listarOrganismos(tipo = "sentencias") {
    if (!ID_REGISTRO[tipo]) throw new Error("tipo_registro debe ser 'sentencias' o 'resoluciones'");
    const idRegistro = ID_REGISTRO[tipo];
    const url = `${BASE_URL}/OrganismosDeUnRegistro?idRegistro=${idRegistro}&null=`;
    const res = await axiosClient.get(url, { headers: HEADERS });
    const options = extraerOptions(res.data);
    return options.map((o) => ({ id: o.value, nombre: o.text }));
}

async function buscarDocumentos({
    organismo,
    fecha_desde,
    fecha_hasta,
    texto_busqueda,
    tipo_registro = "sentencias",
    max_documentos = 20,
}) {
    const reFecha = /^\d{2}\/\d{2}\/\d{4}$/;
    if (!reFecha.test(fecha_desde))
        return { error: `Fecha desde invalida: '${fecha_desde}'. Use DD/MM/AAAA` };
    if (!reFecha.test(fecha_hasta))
        return { error: `Fecha hasta invalida: '${fecha_hasta}'. Use DD/MM/AAAA` };
    if (!ID_REGISTRO[tipo_registro])
        return { error: "tipo_registro debe ser 'sentencias' o 'resoluciones'" };

    let idOrganismo = organismo;
    let nombreOrganismo = organismo;
    if (isNaN(Number(organismo))) {
        const lista = await listarOrganismos(tipo_registro);
        const encontrado = lista.find(
            (o) => o.nombre.toLowerCase().trim() === organismo.toLowerCase().trim()
        );
        if (!encontrado)
            return { error: `Organismo no encontrado: '${organismo}'. Usa listar_organismos para ver los disponibles.` };
        idOrganismo = encontrado.id;
        nombreOrganismo = encontrado.nombre;
    }

    const body = {
        fDesde: fecha_desde,
        fHasta: fecha_hasta,
        texoIncluido: texto_busqueda,
        idOrganismo: String(idOrganismo),
        idRegistro: ID_REGISTRO[tipo_registro],
        nombreOrganismo: nombreOrganismo,
        registro: tipo_registro === "sentencias" ? "REGISTRO DE SENTENCIAS" : "REGISTRO DE RESOLUCIONES",
    };

    const res = await axiosClient.post(
        `${BASE_URL}/BuscarRegistrosPorFechaYOrganismo`,
        body,
        { headers: HEADERS }
    );
    const filas = extraerFilas(res.data);

    if (!filas.length) {
        return {
            total_encontrados: 0,
            tipo_registro,
            organismo: nombreOrganismo,
            documentos: [],
            errores: [],
            nota: "Sin resultados para los criterios indicados.",
        };
    }

    const documentos = [];
    const errores = [];
    const limite = Math.min(filas.length, max_documentos);

    for (let i = 0; i < limite; i++) {
        const fila = filas[i];
        try {
            const id       = Array.isArray(fila) ? fila[0]                       : fila.id;
            const nroReg   = Array.isArray(fila) ? (fila[1]?.display ?? fila[1]) : fila.nroReg;
            const fecha    = Array.isArray(fila) ? (fila[2]?.display ?? fila[2]) : fila.fecha;
            const nroExp   = Array.isArray(fila) ? (fila[3]?.display ?? fila[3]) : fila.nroExp;
            const caratula = Array.isArray(fila) ? fila[4]                       : fila.caratula;

            const resDoc = await axiosClient.post(
                `${BASE_URL}/ObtenerRegistroVisualizar/`,
                { idCodigoAcceso: id },
                { headers: HEADERS }
            );

            let contenido = "";
            if (resDoc.data) {
                contenido = extraerTextoDocumento(
                    typeof resDoc.data === "string" ? resDoc.data : JSON.stringify(resDoc.data)
                );
            } else {
                errores.push(`Doc ${i + 1}: respuesta vacia`);
            }

            documentos.push({
                titulo:         limpiarNombre(String(caratula || `doc_${i + 1}`)),
                nro_registro:   String(nroReg  || ""),
                fecha:          String(fecha   || ""),
                nro_expediente: String(nroExp  || ""),
                caratula:       String(caratula || ""),
                contenido,
            });
        } catch (e) {
            errores.push(`Doc ${i + 1}: ${String(e).slice(0, 120)}`);
        }
    }

    return {
        total_encontrados: documentos.length,
        total_en_servidor: filas.length,
        tipo_registro,
        organismo: nombreOrganismo,
        documentos,
        errores,
    };
}

async function guardarDocumentosEnDisco({
    documentos,
    organismo,
    tipo_registro = "sentencias",
    carpeta_base = "sentencias judiciales",
}) {
    const fs   = await import("fs");
    const path = await import("path");
    const nombreOrg   = organismo.replace(/[<>:"/\\|?*]/g, "").trim();
    // FIX: si carpeta_base es relativa, anclarla al directorio del módulo
    // para evitar que los archivos se creen en el cwd del proceso hub
    const resolvedBase = pathModule.isAbsolute(carpeta_base)
        ? carpeta_base
        : pathModule.join(__dirname, "..", "..", carpeta_base);
    const rutaDestino = path.join(resolvedBase, tipo_registro, nombreOrg);
    fs.mkdirSync(rutaDestino, { recursive: true });

    const guardados = [];
    const errores   = [];

    for (const doc of documentos) {
        try {
            const nombre = (doc.titulo || "sin_titulo")
                .replace(/[<>:"/\\|?*]/g, "").trim().slice(0, 150);
            const ruta = path.join(rutaDestino, `${nombre}.txt`);
            fs.writeFileSync(ruta, doc.contenido || "", "utf-8");
            guardados.push(ruta);
        } catch (e) {
            errores.push(String(e).slice(0, 120));
        }
    }

    return {
        carpeta: rutaDestino,
        archivos_guardados: guardados,
        total: guardados.length,
        errores,
    };
}

// ---------------------------------------------------------------------------
// Servidor McpServer - patron estandar del proyecto
// Reemplaza: Server + CallToolRequestSchema + ListToolsRequestSchema (SDK legacy)
// ---------------------------------------------------------------------------

export const server = new McpServer({
    name: "scba-mcp",
    version: "2.1.0",
});

export function registerAllTools(server) {

    server.tool(
        "listar_tipos_registro",
        "Devuelve los tipos de registro disponibles en la SCBA: Sentencias y Resoluciones.",
        {},
        async () => {
            const tipos = [
                { valor: "sentencias",   etiqueta: "Sentencias"   },
                { valor: "resoluciones", etiqueta: "Resoluciones" },
            ];
            return { content: [{ type: "text", text: JSON.stringify(tipos, null, 2) }] };
        }
    );

    server.tool(
        "listar_organismos",
        "Devuelve la lista de organismos judiciales disponibles en sentencias.scba.gov.ar para el tipo de registro indicado. Llamar antes de buscar_documentos para obtener los nombres y IDs exactos.",
        {
            tipo_registro: z.enum(["sentencias", "resoluciones"])
                .optional()
                .default("sentencias")
                .describe("Tipo de registro. Default: sentencias."),
        },
        async (args) => {
            try {
                const lista = await listarOrganismos(args.tipo_registro ?? "sentencias");
                return { content: [{ type: "text", text: JSON.stringify(lista, null, 2) }] };
            } catch (e) {
                return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
            }
        }
    );

    server.tool(
        "buscar_documentos",
        "Busca sentencias o resoluciones en la SCBA y devuelve el texto completo de cada documento.",
        {
            organismo:      z.string().describe("Nombre exacto o ID numerico del organismo (usar listar_organismos)."),
            fecha_desde:    z.string().describe("Fecha inicio DD/MM/AAAA."),
            fecha_hasta:    z.string().describe("Fecha fin DD/MM/AAAA."),
            texto_busqueda: z.string().describe("Palabras clave a buscar en el texto."),
            tipo_registro:  z.enum(["sentencias", "resoluciones"])
                .optional().default("sentencias")
                .describe("Tipo de registro. Default: sentencias."),
            max_documentos: z.number().optional().default(20)
                .describe("Documentos maximos a retornar. Default: 20."),
        },
        async (args) => {
            try {
                const result = await buscarDocumentos(args);
                return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
            } catch (e) {
                return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
            }
        }
    );

    server.tool(
        "guardar_documentos_en_disco",
        "Guarda los documentos obtenidos con buscar_documentos en archivos .txt en disco.",
        {
            documentos:    z.array(z.any()).describe("Lista de documentos (resultado de buscar_documentos)."),
            organismo:     z.string().describe("Nombre del organismo, usado para nombrar la carpeta de destino."),
            tipo_registro: z.enum(["sentencias", "resoluciones"])
                .optional().default("sentencias"),
            carpeta_base:  z.string().optional().default("sentencias judiciales")
                .describe("Carpeta raiz de salida. Default: 'sentencias judiciales'."),
        },
        async (args) => {
            try {
                const result = await guardarDocumentosEnDisco(args);
                return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
            } catch (e) {
                return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
            }
        }
    );
}

registerAllTools(server);

// Guard de entorno identico al resto del proyecto (bora.js, tfn.js, etc.)
if (
    typeof process !== "undefined" &&
    !process.env.VERCEL &&
    !process.env.NEXT_RUNTIME
) {
    const transport = new StdioServerTransport();
    server.connect(transport).catch((err) => {
        process.stderr.write(`[scba] error fatal: ${err.message}\n`);
        process.exit(1);
    });
    process.stderr.write("[scba] conectado y escuchando\n");
}
