#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios from "axios";
import https from "https";

const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const axiosClient = axios.create({ httpsAgent });

import crypto from "crypto";
let globalBrowser = null;
let globalPage = null;
export function registerAllTools(server) {
    // Tool: pjn_buscar_jurisprudencia_por_expediente
    server.tool("pjn_buscar_jurisprudencia_por_expediente", "Busca la jurisprudencia y fallos asociados a un número de expediente específico. Requiere año y número.", {
        numero: z.number().describe("Número de expediente exacto (sin año)."),
        anio: z.number().describe("Año de inicio del expediente a 4 dígitos (ej. 2021)."),
        camara_id: z.enum(["CSJ", "CIV", "CAF", "CCF", "CNE", "CSS", "CPE", "CNT", "CFP", "CCC", "COM", "CPF", "CPN", "FBB", "FCR", "FCB", "FCT", "FGR", "FLP", "FMP", "FMZ", "FPO", "FPA", "FRE", "FSA", "FRO", "FSM", "FTU"]).optional().describe("Fuero o Cámara (opcional pero recomendado)."),
        captchaToken: z.string().describe("Token de reCAPTCHA obtenido vía HITL.")
    }, async (args) => {
        try {
            const targetUrl = "https://scw.pjn.gov.ar/scw/api/jurisprudencia";
            const response = await axiosClient.post(targetUrl, {
                modo: "expediente",
                numero: args.numero,
                anio: args.anio,
                camara_id: args.camara_id,
                captchaToken: args.captchaToken
            }, {
                headers: {
                    "Content-Type": "application/json",
                    "User-Agent": "Mozilla/5.0 (compatible; pjn-juris-mcp/1.0)"
                }
            });
            const data = response.data;
            let resultText = "# PJN - Jurisprudencia por Expediente\n\n";
            resultText += `**Expediente:** ${args.numero}/${args.anio}\n`;
            if (args.camara_id)
                resultText += `**Cámara:** ${args.camara_id}\n\n`;
            if (data && data.resultados && data.resultados.length > 0) {
                data.resultados.forEach((r) => {
                    resultText += `### ${r.caratula || "N/A"}\n`;
                    resultText += `- **Tribunal:** ${r.tribunal || "N/A"}\n`;
                    resultText += `- **Fecha:** ${r.fecha || "N/A"}\n`;
                    resultText += `- **Sumario:** ${r.sumario || "N/A"}\n\n`;
                });
            }
            else {
                resultText += "No se encontraron resultados.\n";
            }
            return { content: [{ type: "text", text: resultText }] };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { content: [{ type: "text", text: `Error en pjn_buscar_jurisprudencia_por_expediente: ${message}` }], isError: true };
        }
    });
    // Tool: pjn_buscar_jurisprudencia_por_caratula
    server.tool("pjn_buscar_jurisprudencia_por_caratula", "Busca jurisprudencia filtrando por el nombre de las partes involucradas (carátula).", {
        caratula: z.string().describe("Nombre de las partes (ej. apellidos). Para mayor éxito usar al menos 3 letras o un apellido completo."),
        camara_id: z.enum(["CSJ", "CIV", "CAF", "CCF", "CNE", "CSS", "CPE", "CNT", "CFP", "CCC", "COM", "CPF", "CPN", "FBB", "FCR", "FCB", "FCT", "FGR", "FLP", "FMP", "FMZ", "FPO", "FPA", "FRE", "FSA", "FRO", "FSM", "FTU"]).optional().describe("Filtro de Cámara o Fuero para acotar la búsqueda."),
        captchaToken: z.string().describe("Token de reCAPTCHA obtenido vía HITL.")
    }, async (args) => {
        try {
            const targetUrl = "https://scw.pjn.gov.ar/scw/api/jurisprudencia";
            const response = await axiosClient.post(targetUrl, {
                modo: "caratula",
                caratula: args.caratula,
                camara_id: args.camara_id,
                captchaToken: args.captchaToken
            }, {
                headers: {
                    "Content-Type": "application/json",
                    "User-Agent": "Mozilla/5.0 (compatible; pjn-juris-mcp/1.0)"
                }
            });
            const data = response.data;
            let resultText = "# PJN - Jurisprudencia por Carátula\n\n";
            resultText += `**Carátula:** ${args.caratula}\n`;
            if (args.camara_id)
                resultText += `**Cámara:** ${args.camara_id}\n\n`;
            if (data && data.resultados && data.resultados.length > 0) {
                data.resultados.forEach((r) => {
                    resultText += `### ${r.expediente || "N/A"}\n`;
                    resultText += `- **Carátula:** ${r.caratula || "N/A"}\n`;
                    resultText += `- **Tribunal:** ${r.tribunal || "N/A"}\n`;
                    resultText += `- **Fecha:** ${r.fecha || "N/A"}\n\n`;
                });
            }
            else {
                resultText += "No se encontraron resultados.\n";
            }
            return { content: [{ type: "text", text: resultText }] };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { content: [{ type: "text", text: `Error en pjn_buscar_jurisprudencia_por_caratula: ${message}` }], isError: true };
        }
    });
    // Tool: pjn_buscar_jurisprudencia_por_fallo
    server.tool("pjn_buscar_jurisprudencia_por_fallo", "Busca jurisprudencia por los datos específicos de la sentencia (número de fallo, rango de fechas de la sentencia o nombre de los jueces).", {
        numero_sentencia: z.number().optional().describe("Número exclusivo de la sentencia (sin años ni siglas)."),
        fecha_desde: z.string().optional().describe("Fecha de inicio del fallo. Formato DD/MM/YYYY."),
        fecha_hasta: z.string().optional().describe("Fecha de fin del fallo. Formato DD/MM/YYYY."),
        magistrado: z.string().optional().describe("Apellido del magistrado, juez o ministro interviniente (requiere al menos 2 letras)."),
        camara_id: z.enum(["CSJ", "CIV", "CAF", "CCF", "CNE", "CSS", "CPE", "CNT", "CFP", "CCC", "COM", "CPF", "CPN", "FBB", "FCR", "FCB", "FCT", "FGR", "FLP", "FMP", "FMZ", "FPO", "FPA", "FRE", "FSA", "FRO", "FSM", "FTU"]).optional().describe("Cámara o Fuero."),
        captchaToken: z.string().describe("Token de reCAPTCHA obtenido vía HITL.")
    }, async (args) => {
        try {
            const targetUrl = "https://scw.pjn.gov.ar/scw/api/jurisprudencia";
            const response = await axiosClient.post(targetUrl, {
                modo: "fallo",
                numero_sentencia: args.numero_sentencia,
                fecha_desde: args.fecha_desde,
                fecha_hasta: args.fecha_hasta,
                magistrado: args.magistrado,
                camara_id: args.camara_id,
                captchaToken: args.captchaToken
            }, {
                headers: {
                    "Content-Type": "application/json",
                    "User-Agent": "Mozilla/5.0 (compatible; pjn-juris-mcp/1.0)"
                }
            });
            const data = response.data;
            let resultText = "# PJN - Jurisprudencia por Fallo\n\n";
            if (args.numero_sentencia)
                resultText += `**Número Sentencia:** ${args.numero_sentencia}\n`;
            if (args.magistrado)
                resultText += `**Magistrado:** ${args.magistrado}\n`;
            if (args.fecha_desde || args.fecha_hasta)
                resultText += `**Fechas:** ${args.fecha_desde || ""} a ${args.fecha_hasta || ""}\n\n`;
            if (data && data.resultados && data.resultados.length > 0) {
                data.resultados.forEach((r) => {
                    resultText += `### ${r.expediente || "N/A"}\n`;
                    resultText += `- **Carátula:** ${r.caratula || "N/A"}\n`;
                    resultText += `- **Tribunal:** ${r.tribunal || "N/A"}\n`;
                    resultText += `- **Fecha:** ${r.fecha || "N/A"}\n\n`;
                });
            }
            else {
                resultText += "No se encontraron resultados.\n";
            }
            return { content: [{ type: "text", text: resultText }] };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { content: [{ type: "text", text: `Error en pjn_buscar_jurisprudencia_por_fallo: ${message}` }], isError: true };
        }
    });
    // Tool: pjn_buscar_jurisprudencia_por_texto_corte_suprema
    server.tool("pjn_buscar_jurisprudencia_por_texto_corte_suprema", "Busca texto completo de fallos exclusivamente en la Corte Suprema de Justicia de la Nación (CSJN).", {
        texto_contiene: z.string().describe("Palabras o frases exactas que deben estar en el texto del fallo. Soporta el comodín asterisco (*)."),
        texto_no_contiene: z.string().optional().describe("Términos que se deben excluir del documento (NOT lógico)."),
        criterio_frase: z.enum(["TODAS_LAS_FRASES", "ALGUNA_DE_LAS_FRASES"]).optional().describe("Define el tipo de búsqueda de texto."),
        fecha_desde: z.string().optional().describe("Formato DD/MM/YYYY."),
        fecha_hasta: z.string().optional().describe("Formato DD/MM/YYYY."),
        captchaToken: z.string().describe("Token de reCAPTCHA obtenido vía HITL.")
    }, async (args) => {
        try {
            const targetUrl = "https://scw.pjn.gov.ar/scw/api/jurisprudencia";
            const response = await axiosClient.post(targetUrl, {
                modo: "texto_csjn",
                texto_contiene: args.texto_contiene,
                texto_no_contiene: args.texto_no_contiene,
                criterio_frase: args.criterio_frase,
                fecha_desde: args.fecha_desde,
                fecha_hasta: args.fecha_hasta,
                camara_id: "CSJN",
                captchaToken: args.captchaToken
            }, {
                headers: {
                    "Content-Type": "application/json",
                    "User-Agent": "Mozilla/5.0 (compatible; pjn-juris-mcp/1.0)"
                }
            });
            const data = response.data;
            let resultText = "# PJN - Jurisprudencia CSJN por Texto\n\n";
            resultText += `**Texto contiene:** ${args.texto_contiene}\n`;
            if (args.texto_no_contiene)
                resultText += `**Texto no contiene:** ${args.texto_no_contiene}\n`;
            if (args.criterio_frase)
                resultText += `**Criterio:** ${args.criterio_frase}\n\n`;
            if (data && data.resultados && data.resultados.length > 0) {
                data.resultados.forEach((r) => {
                    resultText += `### ${r.expediente || "N/A"}\n`;
                    resultText += `- **Carátula:** ${r.caratula || "N/A"}\n`;
                    resultText += `- **Fecha:** ${r.fecha || "N/A"}\n`;
                    resultText += `- **Sumario:** ${r.sumario || "N/A"}\n\n`;
                });
            }
            else {
                resultText += "No se encontraron resultados.\n";
            }
            return { content: [{ type: "text", text: resultText }] };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { content: [{ type: "text", text: `Error en pjn_buscar_jurisprudencia_por_texto_corte_suprema: ${message}` }], isError: true };
        }
    });
    // Tool: pjn_buscar_jurisprudencia_por_texto_camaras
    server.tool("pjn_buscar_jurisprudencia_por_texto_camaras", "Busca jurisprudencia (fallos de segunda instancia) por texto en las diferentes Cámaras Nacionales y Federales del país.", {
        texto_contiene: z.string().describe("Términos jurídicos a buscar. Soporta el comodín asterisco (*)."),
        texto_no_contiene: z.string().optional().describe("Términos que se deben excluir."),
        criterio_frase: z.enum(["TODAS_LAS_FRASES", "ALGUNA_DE_LAS_FRASES"]).optional().describe("Define el tipo de búsqueda de texto."),
        camara_id: z.enum(["CFCP", "CNACCF", "CNACCFED", "CNACAF", "CFSS", "CNAC", "CNAT", "CNCOM", "CNE", "CNPE", "CNACC"]).describe("Identificador de la cámara obligatoria."),
        fecha_desde: z.string().optional().describe("Formato DD/MM/YYYY."),
        fecha_hasta: z.string().optional().describe("Formato DD/MM/YYYY."),
        captchaToken: z.string().describe("Token de reCAPTCHA obtenido vía HITL.")
    }, async (args) => {
        try {
            const targetUrl = "https://scw.pjn.gov.ar/scw/api/jurisprudencia";
            const response = await axiosClient.post(targetUrl, {
                modo: "texto_camaras",
                texto_contiene: args.texto_contiene,
                texto_no_contiene: args.texto_no_contiene,
                criterio_frase: args.criterio_frase,
                camara_id: args.camara_id,
                fecha_desde: args.fecha_desde,
                fecha_hasta: args.fecha_hasta,
                captchaToken: args.captchaToken
            }, {
                headers: {
                    "Content-Type": "application/json",
                    "User-Agent": "Mozilla/5.0 (compatible; pjn-juris-mcp/1.0)"
                }
            });
            const data = response.data;
            let resultText = "# PJN - Jurisprudencia Cámaras por Texto\n\n";
            resultText += `**Cámara:** ${args.camara_id}\n`;
            resultText += `**Texto contiene:** ${args.texto_contiene}\n\n`;
            if (data && data.resultados && data.resultados.length > 0) {
                data.resultados.forEach((r) => {
                    resultText += `### ${r.expediente || "N/A"}\n`;
                    resultText += `- **Carátula:** ${r.caratula || "N/A"}\n`;
                    resultText += `- **Fecha:** ${r.fecha || "N/A"}\n`;
                    resultText += `- **Sumario:** ${r.sumario || "N/A"}\n\n`;
                });
            }
            else {
                resultText += "No se encontraron resultados.\n";
            }
            return { content: [{ type: "text", text: resultText }] };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { content: [{ type: "text", text: `Error en pjn_buscar_jurisprudencia_por_texto_camaras: ${message}` }], isError: true };
        }
    });
    // Tool: pjn_buscar_sumarios
    server.tool("pjn_buscar_sumarios", "Busca exclusivamente dentro de los 'Sumarios' (extractos o 'abstracts' elaborados por la Secretaría de Jurisprudencia).", {
        texto_contiene: z.string().describe("Concepto jurídico, doctrina o vocablo a buscar en el sumario."),
        camara_id: z.enum(["CSJN", "CFCP", "CNACCF", "CNACCFED", "CNACAF", "CFSS", "CNAC", "CNAT", "CNCOM", "CNE", "CNPE", "CNACC"]).optional().describe("Filtro opcional por cámara."),
        fecha_desde: z.string().optional().describe("Formato DD/MM/YYYY."),
        fecha_hasta: z.string().optional().describe("Formato DD/MM/YYYY."),
        captchaToken: z.string().describe("Token de reCAPTCHA obtenido vía HITL.")
    }, async (args) => {
        try {
            const targetUrl = "https://scw.pjn.gov.ar/scw/api/jurisprudencia";
            const response = await axiosClient.post(targetUrl, {
                modo: "sumarios",
                texto_contiene: args.texto_contiene,
                camara_id: args.camara_id,
                fecha_desde: args.fecha_desde,
                fecha_hasta: args.fecha_hasta,
                captchaToken: args.captchaToken
            }, {
                headers: {
                    "Content-Type": "application/json",
                    "User-Agent": "Mozilla/5.0 (compatible; pjn-juris-mcp/1.0)"
                }
            });
            const data = response.data;
            let resultText = "# PJN - Búsqueda de Sumarios\n\n";
            resultText += `**Texto contiene:** ${args.texto_contiene}\n`;
            if (args.camara_id)
                resultText += `**Cámara:** ${args.camara_id}\n\n`;
            if (data && data.resultados && data.resultados.length > 0) {
                data.resultados.forEach((r) => {
                    resultText += `### ${r.expediente || "N/A"}\n`;
                    resultText += `- **Carátula:** ${r.caratula || "N/A"}\n`;
                    resultText += `- **Sumario:** ${r.sumario || "N/A"}\n\n`;
                });
            }
            else {
                resultText += "No se encontraron resultados.\n";
            }
            return { content: [{ type: "text", text: resultText }] };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { content: [{ type: "text", text: `Error en pjn_buscar_sumarios: ${message}` }], isError: true };
        }
    });
    // Tool: pjn_descargar_fallo_pdf
    // [NO IMPLEMENTADO] El endpoint scw.pjn.gov.ar/scw/api/jurisprudencia/descargar no es público.
    // El portal PJN no expone descarga directa de PDF por ID vía API REST documentada.
    // Para descargar un fallo: usar iniciar_hitl_browser, navegar al resultado y descargar manualmente.
    server.tool("pjn_descargar_fallo_pdf", "[NO DISPONIBLE] El portal PJN no expone un endpoint público de descarga de fallos por ID. Para descargar un fallo, usar iniciar_hitl_browser y navegar al resultado.", {
        fallo_id: z.string().describe("Identificador interno del fallo."),
        captchaToken: z.string().describe("Token de reCAPTCHA obtenido vía HITL.")
    }, async (args) => {
        return {
            content: [{ type: "text", text: `[NO IMPLEMENTADO] pjn_descargar_fallo_pdf: el portal PJN no expone un endpoint público de descarga de fallos por ID (fallo_id: ${args.fallo_id}). Para descargar el documento, usar iniciar_hitl_browser, navegar al fallo en https://scw.pjn.gov.ar y descargarlo desde la interfaz web.` }],
            isError: true
        };
    });
    // Tool: buscar_jurisprudencia_fed
    // Mantenido por compatibilidad con el prompt investigacion_jurisprudencia.
    // Internamente delega a modo "texto_camaras" con camara_id CNACAF (Contencioso Admin Fed),
    // alineando el body con el patrón estándar del resto de los tools.
    // El parámetro `pagina` se conserva en la firma pero el API del PJN no lo soporta vía REST;
    // se documenta como ignorado hasta confirmar soporte real.
    server.tool("buscar_jurisprudencia_fed", "Busca fallos en el fuero Contencioso Administrativo Federal por texto libre. Para búsquedas más específicas usar pjn_buscar_jurisprudencia_por_expediente, pjn_buscar_jurisprudencia_por_caratula o pjn_buscar_sumarios.", {
        criterio: z.string().describe("Término de búsqueda legal (ej. 'daño moral', 'prescripción', número de expediente)."),
        pagina: z.number().optional().default(1).describe("Reservado para paginación futura. Actualmente ignorado por el API del PJN."),
        captchaToken: z.string().describe("Token de reCAPTCHA obligatorio para consultar el portal.")
    }, async (args) => {
        try {
            const targetUrl = "https://scw.pjn.gov.ar/scw/api/jurisprudencia";
            const response = await axiosClient.post(targetUrl, {
                modo: "texto_camaras",
                texto_contiene: args.criterio,
                camara_id: "CNACAF",
                captchaToken: args.captchaToken
            }, {
                headers: {
                    "Content-Type": "application/json",
                    "User-Agent": "Mozilla/5.0 (compatible; pjn-juris-mcp/1.0)"
                }
            });
            const data = response.data;
            let resultText = "# PJN - Jurisprudencia Contencioso Admin Fed\n\n";
            resultText += `**Búsqueda:** ${args.criterio}\n`;
            resultText += `**Cámara:** CNACAF (Cámara Nacional de Apelaciones en lo Contencioso Administrativo Federal)\n\n`;
            if (data && data.resultados && data.resultados.length > 0) {
                data.resultados.forEach((r) => {
                    resultText += `### ${r.expediente || "N/A"}\n`;
                    resultText += `- **Carátula:** ${r.caratula || "N/A"}\n`;
                    resultText += `- **Tribunal:** ${r.tribunal || "N/A"}\n`;
                    resultText += `- **Fecha:** ${r.fecha || "N/A"}\n`;
                    resultText += `- **Sumario:** ${r.sumario || "N/A"}\n\n`;
                });
            }
            else {
                resultText += "No se encontraron resultados.\n";
            }
            return { content: [{ type: "text", text: resultText }] };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { content: [{ type: "text", text: `Error en buscar_jurisprudencia_fed: ${message}` }], isError: true };
        }
    });
    // MCP Prompts
    server.prompt("investigacion_jurisprudencia", "Prepara una investigación de jurisprudencia en el fuero Contencioso Administrativo Federal.", {
        tema: z.string().describe("El tema a investigar")
    }, (args) => ({
        messages: [{
                role: "user",
                content: {
                    type: "text",
                    text: `Investiga jurisprudencia del fuero Contencioso Administrativo Federal sobre: ${args.tema}.\n\nHerramientas disponibles (usar en este orden según el caso):\n1. iniciar_hitl_browser + finalizar_hitl_browser para obtener el captchaToken.\n2. buscar_jurisprudencia_fed para búsqueda por texto libre en CNACAF.\n3. pjn_buscar_jurisprudencia_por_caratula si se conoce el nombre de las partes.\n4. pjn_buscar_jurisprudencia_por_expediente si se conoce el número de expediente.\n5. pjn_buscar_sumarios para buscar en extractos de la Secretaría de Jurisprudencia.\n6. exportar_fallo para exportar los resultados a Markdown con frontmatter YAML.\n\nNota: el captchaToken es obligatorio para todas las consultas al portal PJN.`
                }
            }]
    }));
    // Tool: iniciar_hitl_browser
    server.tool("iniciar_hitl_browser", "Abre un navegador interactivo para resolver Captchas manualmente.", {}, async () => {
        if (globalBrowser) {
            return { content: [{ type: "text", text: "El navegador ya está abierto. Por favor resuelve el Captcha en https://scw.pjn.gov.ar y ejecuta finalizar_hitl_browser." }] };
        }
        try {
            const { default: puppeteer } = await import("puppeteer");
            globalBrowser = await puppeteer.launch({
                headless: false,
                defaultViewport: null,
            });
            globalPage = await globalBrowser.newPage();
            await globalPage.goto('https://scw.pjn.gov.ar', { waitUntil: 'networkidle2' });
            return { content: [{ type: "text", text: "Navegador abierto en https://scw.pjn.gov.ar. Por favor resuelve el Captcha y ejecuta finalizar_hitl_browser." }] };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { content: [{ type: "text", text: `Error al iniciar el navegador: ${message}` }], isError: true };
        }
    });
    // Tool: finalizar_hitl_browser
    server.tool("finalizar_hitl_browser", "Cierra el navegador interactivo y extrae los tokens y cookies de la sesión.", {}, async () => {
        if (!globalBrowser || !globalPage) {
            return { content: [{ type: "text", text: "No hay un navegador abierto. Ejecuta iniciar_hitl_browser primero." }], isError: true };
        }
        try {
            const cookies = await globalPage.cookies();
            const userAgent = await globalBrowser.userAgent();
            await globalBrowser.close();
            globalBrowser = null;
            globalPage = null;
            return { content: [{ type: "text", text: JSON.stringify({ status: "success", sessionData: { userAgent, cookies } }) }] };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { content: [{ type: "text", text: `Error al finalizar la sesión HITL: ${message}` }], isError: true };
        }
    });
    // Tool: alcance_fuente
    server.tool("alcance_fuente", "Informa las capacidades, fuentes de datos, limitaciones y disclaimer del conector pjn-juris-mcp.", {}, async () => {
        const text = [
            "# Alcance y Fuentes - PJN Jurisprudencia (pjn-juris-mcp)",
            "",
            "## Datos del Conector",
            "- **Servidor:** pjn-juris-mcp v1.0.0",
            "- **Fuente oficial:** https://scw.pjn.gov.ar",
            "- **Viabilidad:** Baja-Media - el portal usa Google reCAPTCHA. Todas las consultas requieren captchaToken obtenido via iniciar_hitl_browser + finalizar_hitl_browser.",
            "",
            "## Herramientas Operativas",
            "Estas herramientas realizan llamadas reales al portal PJN:",
            "",
            "### Busqueda de jurisprudencia (requieren captchaToken)",
            "- `pjn_buscar_jurisprudencia_por_expediente` - Por numero y anio de expediente. Endpoint: modo=expediente.",
            "- `pjn_buscar_jurisprudencia_por_caratula` - Por nombre de las partes. Endpoint: modo=caratula.",
            "- `pjn_buscar_jurisprudencia_por_fallo` - Por numero de sentencia, magistrado o rango de fechas. Endpoint: modo=fallo.",
            "- `pjn_buscar_jurisprudencia_por_texto_corte_suprema` - Texto completo en CSJN. Endpoint: modo=texto_csjn.",
            "- `pjn_buscar_jurisprudencia_por_texto_camaras` - Texto completo en camaras nacionales/federales. Endpoint: modo=texto_camaras.",
            "- `pjn_buscar_sumarios` - En extractos de la Secretaria de Jurisprudencia. Endpoint: modo=sumarios.",
            "- `buscar_jurisprudencia_fed` - Alias de texto_camaras preconfigurado para CNACAF. Compatibilidad con prompt investigacion_jurisprudencia.",
            "",
            "### Busqueda semantica y relacional",
            "- `buscar_por_semantica` - Expande el concepto con sinonimos antes de buscar (modo=texto_camaras).",
            "- `relacionar_fallos` - Busca fallos con partes o temas similares (modo=caratula).",
            "",
            "### Utilidades",
            "- `iniciar_hitl_browser` - Abre Chromium para resolver el CAPTCHA manualmente.",
            "- `finalizar_hitl_browser` - Cierra el navegador y extrae cookies/userAgent de sesion.",
            "- `exportar_fallo` - Exporta datos de un fallo a Markdown con frontmatter YAML. Recibe los datos como argumentos (no hace fetch por ID).",
            "- `detector_plazos_jurisprudencia` - Detecta plazos y fechas limite en el texto de un fallo.",
            "- `alcance_fuente` - Este informe.",
            "",
            "## Herramientas NO Disponibles [NO IMPLEMENTADO]",
            "El portal PJN no expone endpoints REST publicos para estas funciones:",
            "- `pjn_descargar_fallo_pdf` - No hay API de descarga por ID. Usar iniciar_hitl_browser.",
            "- `generar_certificacion_forense` - Requiere descarga real; sin ella el hash carece de valor forense.",
            "- `pjn_buscar_guia_judicial` - La guia es HTML estatico en /guia_judicial/.",
            "- `pjn_consultar_concursos` - Los concursos se publican como paginas HTML.",
            "- `pjn_buscar_formularios_csjn` - Los formularios CSJN son PDFs en csjn.gov.ar.",
            "- `pjn_estadisticas` - Las estadisticas son informes PDF/HTML en /estadisticas/.",
            "",
            "## Aviso Legal",
            "Conector automatizado para investigacion legal. No constituye asesoramiento profesional.",
            "Las consultas se realizan sobre portales oficiales publicos de la Republica Argentina."
        ].join("\n");
        return { content: [{ type: "text", text }] };
    });
    // Tool: detector_plazos_jurisprudencia
    server.tool("detector_plazos_jurisprudencia", "Audita el texto de fallos jurisprudenciales para detectar e indexar plazos, fechas límite y hitos temporales relevantes (plazos de apelación, prescripciones, vencimientos)", {
        texto_fallo: z.string().describe("Texto del fallo jurisprudencial a analizar"),
    }, async (args) => {
        try {
            const text = args.texto_fallo;
            // Define deadline detection patterns for jurisprudence context
            const patterns = [
                { regex: /\b\d+\s+(días?\s+(habiles|corridos)?|meses|años?)\b/i, name: "Plazo numérico" },
                { regex: /\b(plazo|término)\s+de\s+(días?|meses|años?)\b/i, name: "Cláusula de plazo" },
                { regex: /\b(prescribe|prescripción)\b/i, name: "Prescripción" },
                { regex: /\b(caduca|caducidad)\b/i, name: "Caducidad" },
                { regex: /\b(vencimiento|mora)\b/i, name: "Vencimiento/Mora" },
                { regex: /\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/g, name: "Fecha específica" },
                { regex: /\b(hasta\s+el\s+(?:\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|el\s+día\s+\d+))/i, name: "Fecha límite" },
                { regex: /\b(dentro\s+de\s+(?:los\s+)?\d+\s+(días?|meses|años?))\b/i, name: "Plazo desde notificación" },
                { regex: /\b(apelar|apelación|recurso)\b/i, name: "Plazo de apelación" },
                { regex: /\b(consignar|depósito|caución)\b/i, name: "Plazo de consignación" },
            ];
            // Split text into paragraphs for analysis
            const paragraphs = text.split(/\n\n+/);
            const results = [];
            for (const paragraph of paragraphs) {
                const trimmed = paragraph.trim();
                if (!trimmed || trimmed.length < 10)
                    continue;
                const foundMatches = [];
                for (const pattern of patterns) {
                    if (pattern.regex.test(trimmed)) {
                        foundMatches.push(pattern.name);
                    }
                }
                if (foundMatches.length > 0) {
                    results.push({
                        paragraph: trimmed.substring(0, 500) + (trimmed.length > 500 ? '...' : ''),
                        matches: foundMatches
                    });
                }
            }
            let content = `# Auditoría de Plazos y Hitos Temporales en Jurisprudencia\n\n`;
            content += `## Resumen\n`;
            content += `Se identificaron **${results.length}** cláusulas con indicadores temporales relevantes.\n\n`;
            if (results.length === 0) {
                content += `No se detectaron plazos, fechas límite o hitos temporales en el texto analizado.\n`;
                content += `Esto puede indicar:\n`;
                content += `- El fallo no contiene plazos temporales\n`;
                content += `- Los plazos están expresados en formato no detectado por los patrones actuales\n`;
                content += `- El texto es muy breve o no es legible\n\n`;
            }
            else {
                content += `## Cláusulas Temporales Detectadas\n\n`;
                results.forEach((r, idx) => {
                    content += `### ${idx + 1}. Cláusula Temporal (Indicador: ${r.matches.join(', ')})\n`;
                    content += `> ${r.paragraph}\n\n`;
                });
            }
            content += `## Patrones de Búsqueda Utilizados\n`;
            patterns.forEach((p, idx) => {
                content += `${idx + 1}. **${p.name}**: ${p.regex.source}\n`;
            });
            content += `\n> **Nota:** Esta herramienta detecta patrones de texto comunes en fallos jurisprudenciales. No constituye asesoramiento legal. Verificar siempre los plazos directamente en el documento original del PJN.`;
            return {
                content: [{ type: "text", text: content }],
            };
        }
        catch (error) {
            return {
                isError: true,
                content: [{ type: "text", text: `Error al detectar plazos jurisprudenciales: ${error.message}` }],
            };
        }
    });
    // Tool: generar_certificacion_forense
    // [NO IMPLEMENTADO] Requiere descarga real del fallo vía endpoint no público.
    // La certificación SHA-256 sobre un buffer descargado desde un endpoint inexistente
    // no tiene valor forense. Se marca como no disponible hasta implementar descarga real.
    server.tool("generar_certificacion_forense", "[NO DISPONIBLE] Requiere acceso a un endpoint de descarga de fallos que el PJN no expone públicamente. La certificación forense sería sobre un documento no descargado.", {
        fallo_id: z.string().describe("ID del fallo a certificar."),
        captchaToken: z.string().describe("Token de reCAPTCHA para acceso al documento.")
    }, async (args) => {
        return {
            content: [{ type: "text", text: `[NO IMPLEMENTADO] generar_certificacion_forense: el portal PJN no expone un endpoint público de descarga por ID (fallo_id: ${args.fallo_id}). Sin acceso al documento original no es posible generar un hash SHA-256 con valor forense. Para certificar un fallo, descargarlo manualmente vía iniciar_hitl_browser y calcular el hash sobre el archivo local.` }],
            isError: true
        };
    });
    // Tool: buscar_por_semantica
    server.tool("buscar_por_semantica", "Busca jurisprudencia en el PJN utilizando expansión semántica de términos. El LLM debe generar sinónimos y términos equivalentes antes de llamar esta herramienta.", {
        concepto: z.string().describe("Concepto central a buscar (ej. 'despido', 'daño moral', 'responsabilidad civil')"),
        terminos_equivalentes: z.array(z.string()).describe("Lista de sinónimos o términos relacionados generados por el LLM (ej. ['terminación', 'extinción', 'rescisión'])"),
        camara_id: z.enum(["CSJN", "CFCP", "CNACCF", "CNACCFED", "CNACAF", "CFSS", "CNAC", "CNAT", "CNCOM", "CNE", "CNPE", "CNACC"]).optional().describe("ID de la cámara (opcional)"),
        captchaToken: z.string().describe("Token de reCAPTCHA para acceso al portal"),
    }, async (args) => {
        try {
            const concepto = args.concepto;
            const terminos = args.terminos_equivalentes || [];
            // Combine concept with equivalent terms for broader search
            const allTerms = [concepto, ...terminos].join(' ');
            const targetUrl = "https://scw.pjn.gov.ar/scw/api/jurisprudencia";
            const response = await axiosClient.post(targetUrl, {
                modo: "texto_camaras",
                texto_contiene: allTerms,
                camara_id: args.camara_id,
                captchaToken: args.captchaToken
            }, {
                headers: {
                    "Content-Type": "application/json",
                    "User-Agent": "Mozilla/5.0 (compatible; pjn-juris-mcp/1.0)"
                }
            });
            const data = response.data;
            let content = `# Búsqueda Semántica de Jurisprudencia - "${concepto}"\n\n`;
            content += `## Términos de Búsqueda Utilizados\n`;
            content += `- **Concepto principal:** ${concepto}\n`;
            content += `- **Términos equivalentes:** ${terminos.join(', ') || 'Ninguno'}\n`;
            content += `- **Query completa:** "${allTerms}"\n`;
            if (args.camara_id) {
                content += `- **Cámara:** ${args.camara_id}\n`;
            }
            content += `\n`;
            content += `## Resultados Encontrados\n`;
            if (data && data.resultados && data.resultados.length > 0) {
                data.resultados.forEach((r) => {
                    content += `### ${r.expediente || "N/A"}\n`;
                    content += `- **Carátula:** ${r.caratula || "N/A"}\n`;
                    content += `- **Tribunal:** ${r.tribunal || "N/A"}\n`;
                    content += `- **Fecha:** ${r.fecha || "N/A"}\n`;
                    content += `- **Sumario:** ${r.sumario || "N/A"}\n\n`;
                });
            }
            else {
                content += "No se encontraron resultados.\n";
            }
            content += `\n> **Nota:** Esta herramienta utiliza expansión semántica para capturar fallos que pueden no usar la terminología exacta del concepto buscado.`;
            return {
                content: [{ type: "text", text: content }],
            };
        }
        catch (error) {
            return {
                isError: true,
                content: [{ type: "text", text: `Error en búsqueda semántica: ${error.message}` }],
            };
        }
    });
    // Tool: relacionar_fallos
    server.tool("relacionar_fallos", "Busca fallos relacionados con un fallo específico (mismas partes, temas similares, misma cámara)", {
        criterio_base: z.string().describe("Criterio base del fallo de referencia (carátula, expediente o tema)"),
        terminos_relacionados: z.array(z.string()).optional().describe("Términos relacionados para buscar fallos conexos"),
        camara_id: z.enum(["CSJN", "CFCP", "CNACCF", "CNACCFED", "CNACAF", "CFSS", "CNAC", "CNAT", "CNCOM", "CNE", "CNPE", "CNACC"]).optional().describe("ID de la cámara (opcional)"),
        captchaToken: z.string().describe("Token de reCAPTCHA para acceso al portal"),
    }, async (args) => {
        try {
            const criterioBase = args.criterio_base;
            const terminosRelacionados = args.terminos_relacionados || [];
            // Combine base criteria with related terms
            const searchQuery = [criterioBase, ...terminosRelacionados].join(' ');
            const targetUrl = "https://scw.pjn.gov.ar/scw/api/jurisprudencia";
            const response = await axiosClient.post(targetUrl, {
                modo: "caratula",
                caratula: searchQuery,
                camara_id: args.camara_id,
                captchaToken: args.captchaToken
            }, {
                headers: {
                    "Content-Type": "application/json",
                    "User-Agent": "Mozilla/5.0 (compatible; pjn-juris-mcp/1.0)"
                }
            });
            const data = response.data;
            let content = `# Fallos Relacionados - "${criterioBase}"\n\n`;
            content += `## Fallo de Referencia\n`;
            content += `- **Criterio base:** ${criterioBase}\n`;
            if (args.camara_id) {
                content += `- **Cámara:** ${args.camara_id}\n`;
            }
            content += `\n`;
            content += `## Criterio de Búsqueda\n`;
            content += `**Query:** "${searchQuery}"\n`;
            content += `**Términos relacionados:** ${terminosRelacionados.join(', ') || 'Ninguno'}\n\n`;
            content += `## Resultados Encontrados\n`;
            if (data && data.resultados && data.resultados.length > 0) {
                data.resultados.forEach((r) => {
                    content += `### ${r.expediente || "N/A"}\n`;
                    content += `- **Carátula:** ${r.caratula || "N/A"}\n`;
                    content += `- **Tribunal:** ${r.tribunal || "N/A"}\n`;
                    content += `- **Fecha:** ${r.fecha || "N/A"}\n\n`;
                });
            }
            else {
                content += "No se encontraron resultados.\n";
            }
            content += `\n> **Nota:** Esta herramienta busca por similitud temática y contextual. Las relaciones no son oficiales del PJN.`;
            return {
                content: [{ type: "text", text: content }],
            };
        }
        catch (error) {
            return {
                isError: true,
                content: [{ type: "text", text: `Error al relacionar fallos: ${error.message}` }],
            };
        }
    });
    // Tool: exportar_fallo
    // Exporta metadata + sumario de un fallo obtenido previamente via búsqueda.
    // No intenta descarga por ID (endpoint no público). Recibe el objeto fallo como argumento.
    server.tool("exportar_fallo", "Exporta la información de un fallo a Markdown con frontmatter YAML (Notion, Obsidian). Requiere pasar los datos del fallo obtenidos previamente con las herramientas de búsqueda.", {
        fallo_id: z.string().describe("Identificador del fallo (para referencia en el frontmatter)."),
        caratula: z.string().optional().describe("Carátula del expediente."),
        tribunal: z.string().optional().describe("Tribunal o cámara."),
        fecha: z.string().optional().describe("Fecha de la sentencia."),
        sumario: z.string().optional().describe("Texto del sumario obtenido de la búsqueda.")
    }, async (args) => {
        try {
            const exportDate = new Date().toISOString();
            let content = `---\n`;
            content += `title: "${args.caratula || `Fallo ${args.fallo_id}`}"\n`;
            content += `fallo_id: "${args.fallo_id}"\n`;
            content += `tribunal: "${args.tribunal || "N/A"}"\n`;
            content += `fecha: "${args.fecha || "N/A"}"\n`;
            content += `source: "Poder Judicial de la Nación (PJN) - Jurisprudencia"\n`;
            content += `source_url: "https://scw.pjn.gov.ar"\n`;
            content += `export_date: "${exportDate}"\n`;
            content += `tags:\n  - PJN\n  - jurisprudencia\n  - fallo-${args.fallo_id}\n`;
            content += `---\n\n`;
            content += `# ${args.caratula || `Fallo ${args.fallo_id}`}\n\n`;
            content += `| Campo | Dato |\n|---|---|\n`;
            content += `| **Fallo ID** | ${args.fallo_id} |\n`;
            content += `| **Tribunal** | ${args.tribunal || "N/A"} |\n`;
            content += `| **Fecha** | ${args.fecha || "N/A"} |\n\n`;
            if (args.sumario) {
                content += `## Sumario\n\n${args.sumario}\n\n`;
            }
            content += `---\n*Exportado desde PJN Jurisprudencia. Verificar en la fuente oficial: https://scw.pjn.gov.ar*`;
            return { content: [{ type: "text", text: content }] };
        }
        catch (error) {
            return {
                isError: true,
                content: [{ type: "text", text: `Error al exportar fallo: ${error.message}` }]
            };
        }
    });
    // Tool: pjn_buscar_guia_judicial
    // [NO IMPLEMENTADO] El PJN no expone un endpoint REST para la guía judicial.
    // La guía es una página HTML en https://www.pjn.gov.ar/guia_judicial/ - requiere scraping.
    // Para consultar: usar iniciar_hitl_browser y navegar manualmente.
    server.tool("pjn_buscar_guia_judicial", "[NO DISPONIBLE] El PJN no expone un endpoint REST para la guía judicial. Para consultar tribunales y personal judicial, usar iniciar_hitl_browser y navegar a https://www.pjn.gov.ar/guia_judicial/", {
        tribunal: z.string().optional().describe("Nombre del tribunal a buscar."),
        fuero: z.enum(["CIVIL", "COMERCIAL", "PENAL", "LABORAL", "CONTENCIOSO_ADMINISTRATIVO", "FEDERAL", "ELECTORAL", "SEGURIDAD_SOCIAL"]).optional().describe("Fuero o rama del derecho."),
        localidad: z.string().optional().describe("Localidad o ciudad.")
    }, async (args) => {
        return {
            content: [{ type: "text", text: `[NO IMPLEMENTADO] pjn_buscar_guia_judicial: el PJN no expone un endpoint REST para la guía judicial${args.tribunal ? ` (${args.tribunal})` : ""}. Para consultar, usar iniciar_hitl_browser y navegar a https://www.pjn.gov.ar/guia_judicial/` }],
            isError: true
        };
    });
    // Tool: pjn_consultar_concursos
    // [NO IMPLEMENTADO] El PJN no expone un endpoint REST para concursos judiciales.
    server.tool("pjn_consultar_concursos", "[NO DISPONIBLE] El PJN no expone un endpoint REST para concursos judiciales. Para consultar concursos vigentes, usar iniciar_hitl_browser y navegar al sitio oficial del PJN.", {
        fuero: z.enum(["CIVIL", "COMERCIAL", "PENAL", "LABORAL", "FEDERAL"]).optional().describe("Fuero del concurso."),
        estado: z.enum(["ABIERTO", "CERRADO", "EN_CURSO", "FINALIZADO"]).optional().describe("Estado del concurso.")
    }, async (args) => {
        return {
            content: [{ type: "text", text: `[NO IMPLEMENTADO] pjn_consultar_concursos: el PJN no expone un endpoint REST para concursos judiciales${args.fuero ? ` (fuero: ${args.fuero})` : ""}. Para consultar concursos vigentes, usar iniciar_hitl_browser y navegar a https://www.pjn.gov.ar` }],
            isError: true
        };
    });
    // Tool: pjn_buscar_formularios_csjn
    // [NO IMPLEMENTADO] Los formularios CSJN (Acordada 12/2020) se publican como PDFs,
    // no via endpoint REST con filtros por tipo/fuero.
    server.tool("pjn_buscar_formularios_csjn", "[NO DISPONIBLE] Los formularios CSJN (Acordada 12/2020) no se exponen via endpoint REST. Para acceder a los formularios, usar iniciar_hitl_browser y navegar a https://www.csjn.gov.ar", {
        tipo_formulario: z.enum(["DEMANDA", "RECURSO_DIRECTO", "RECURSO_QUEJA", "AMPARO", "HABEAS_CORPUS", "HABEAS_DATA"]).optional().describe("Tipo de formulario."),
        fuero: z.enum(["CIVIL", "COMERCIAL", "PENAL", "CONTENCIOSO_ADMINISTRATIVO", "LABORAL"]).optional().describe("Fuero del formulario.")
    }, async (args) => {
        return {
            content: [{ type: "text", text: `[NO IMPLEMENTADO] pjn_buscar_formularios_csjn: los formularios CSJN (Acordada 12/2020) no se exponen via endpoint REST${args.tipo_formulario ? ` (tipo: ${args.tipo_formulario})` : ""}. Para acceder, usar iniciar_hitl_browser y navegar a https://www.csjn.gov.ar` }],
            isError: true
        };
    });
    // Tool: pjn_estadisticas
    // [NO IMPLEMENTADO] Las estadisticas del PJN se publican como informes PDF/HTML,
    // no via endpoint REST con filtros por jurisdiccion y fuero.
    server.tool("pjn_estadisticas", "[NO DISPONIBLE] Las estadisticas del PJN no se exponen via endpoint REST. Para acceder a informes estadisticos, usar iniciar_hitl_browser y navegar a https://www.pjn.gov.ar/estadisticas/", {
        jurisdiccion: z.enum(["CSJ", "CIV", "CAF", "CCF", "CNE", "CSS", "CPE", "CNT", "CFP", "CCC", "COM", "CPF", "CPN", "FBB", "FCR", "FCB", "FCT", "FGR", "FLP", "FMP", "FMZ", "FPO", "FPA", "FRE", "FSA", "FRO", "FSM", "FTU"]).optional().describe("Jurisdiccion."),
        fuero: z.enum(["CIVIL", "COMERCIAL", "PENAL", "LABORAL", "CONTENCIOSO_ADMINISTRATIVO", "FEDERAL"]).optional().describe("Fuero."),
        anio: z.number().optional().describe("Anio (4 digitos).")
    }, async (args) => {
        return {
            content: [{ type: "text", text: `[NO IMPLEMENTADO] pjn_estadisticas: las estadisticas del PJN no se exponen via endpoint REST${args.jurisdiccion ? ` (jurisdiccion: ${args.jurisdiccion})` : ""}${args.anio ? `, anio: ${args.anio}` : ""}. Para acceder a informes estadisticos, usar iniciar_hitl_browser y navegar a https://www.pjn.gov.ar/estadisticas/` }],
            isError: true
        };
    });
}
// Initialize the local server instance
export const server = new McpServer({
    name: "pjn-juris-mcp",
    version: "1.0.0"
});
// Register tools
registerAllTools(server);
// Connect with stdio (only when run directly and not in Vercel/Next environment)
if (typeof process !== "undefined" && !process.env.VERCEL && !process.env.NEXT_RUNTIME) {
    // FIX: cleanup Puppeteer browser on process exit to prevent zombie Chromium
    const cleanupBrowser = async () => {
        if (globalBrowser) {
            try { await globalBrowser.close(); } catch { /* ignorar */ }
            globalBrowser = null;
            globalPage = null;
        }
    };
    process.on("SIGINT",  async () => { await cleanupBrowser(); process.exit(0); });
    process.on("SIGTERM", async () => { await cleanupBrowser(); process.exit(0); });
    process.on("exit",    ()       => { if (globalBrowser) { try { globalBrowser.process()?.kill(); } catch { /* ignorar */ } } });
    const transport = new StdioServerTransport();
    server.connect(transport).catch((err) => {
        console.error("Server connection failed", err);
        process.exit(1);
    });
    console.error("PJN - Jurisprudencia Contencioso Admin Fed MCP Server is running via Stdio.");
}
//# sourceMappingURL=pjnjuris.js.map