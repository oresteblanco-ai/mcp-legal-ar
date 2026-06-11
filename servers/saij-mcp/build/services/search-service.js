import axios from "axios";
import { apiClient } from "./api-client.js";
import { FilterBuilder, PRESET_FILTERS } from "./filter-builder.js";
import { SearchResponseSchema, } from "../types/saij.js";
import { documentService } from "./document-service.js";
/**
 * SearchService provides specialized methods for searching SAIJ documents.
 * It coordinates FilterBuilder and ApiClient.
 */
export class SearchService {
    /**
     * Resolves a free-text legal citation (e.g., "Ley 24240", "Código Civil") to a document.
     */
    async resolveCitation(text) {
        // 1. Detect Law number patterns (e.g., "Ley 24.240" or "Ley 24240")
        const lawMatch = text.match(/ley\s*(\d+[\.\d+]*)/i);
        if (lawMatch) {
            const lawNumber = lawMatch[1].replace(/\./g, "");
            // FIX 11/06/2026 (verificado en vivo): buscar por texto libre traia
            // cualquier norma que MENCIONARA el numero (ej. una adhesion
            // provincial) en vez de la ley misma. El campo numero-norma del
            // indice matchea exacto: numero-norma:24240 + tipo Ley +
            // jurisdiccion Nacional devuelve unicamente la Ley 24.240.
            for (const jurisdiccion of ["Nacional", undefined]) {
                const exactos = await this.searchLegislacion({
                    query: `numero-norma:${lawNumber}`,
                    tipoNorma: "Ley",
                    jurisdiccion,
                    offset: 0,
                    pageSize: 1,
                    view: "colapsada",
                });
                if (exactos.results.length > 0) {
                    return await documentService.getFullDocument(exactos.results[0].uuid);
                }
            }
            // Fallback historico: texto libre (puede traer normas que solo
            // citan el numero; mejor que nada si numero-norma no matcheo)
            const results = await this.searchLegislacion({ query: lawNumber, offset: 0, pageSize: 1, view: "colapsada" });
            if (results.results.length > 0) {
                return await documentService.getFullDocument(results.results[0].uuid);
            }
        }
        // 2. Detect Code patterns
        if (text.toLowerCase().includes("codigo civil")) {
            const results = await this.searchRaw(PRESET_FILTERS.codigos, { query: "Civil", offset: 0, pageSize: 1, view: "colapsada" });
            if (results.results.length > 0) {
                return await documentService.getFullDocument(results.results[0].uuid);
            }
        }
        // 3. Fallback to general search
        return await this.searchRaw("Total", { query: text, offset: 0, pageSize: 5, view: "colapsada" });
    }
    /**
     * Search jurisprudencia with specific filters.
     */
    async searchJurisprudencia(params) {
        const filterStr = FilterBuilder.jurisprudencia({
            jurisdiccion: params.jurisdiccion,
            tribunal: params.tribunal,
            materia: params.materia,
            tipoDoc: params.tipoDoc,
            fechaDesde: params.fechaDesde,
            fechaHasta: params.fechaHasta,
        });
        return this.searchRaw(filterStr, params);
    }
    /**
     * Search legislacion with specific filters.
     */
    async searchLegislacion(params) {
        const filterStr = FilterBuilder.legislacion({
            tipoNorma: params.tipoNorma,
            jurisdiccion: params.jurisdiccion,
            estadoVigencia: params.estadoVigencia,
            organismo: params.organismo,
            tema: params.tema,
        });
        return this.searchRaw(filterStr, params);
    }
    /**
     * Search doctrina with specific filters.
     */
    async searchDoctrina(params) {
        const filterStr = FilterBuilder.doctrina({
            materia: params.materia,
            autor: params.autor,
            fechaDesde: params.fechaDesde,
            fechaHasta: params.fechaHasta,
        });
        return this.searchRaw(filterStr, params);
    }
    /**
     * Search dictamenes with specific filters.
     */
    async searchDictamenes(params) {
        const filterStr = FilterBuilder.dictamenes({
            organismo: params.organismo,
            tema: params.tema,
        });
        return this.searchRaw(filterStr, params);
    }
    /**
     * Search the digital library.
     *
     * FIX 11/06/2026 (Warning 3 del informe de tests, cerrado): la faceta
     * "Publicación/Biblioteca digital" del indice de saij.gob.ar esta VACIA
     * (verificado en vivo: facet-browse con +id:* => total_results 0). El
     * catalogo real de la Biblioteca Digital de Ediciones SAIJ vive en una
     * plataforma Omeka aparte: bibliotecadigital.gob.ar (Ministerio de
     * Justicia). Se busca alli:
     *   /items/browse?search=<q>&output=json  -> ids + total_results
     *   /items/browse?search=<q>              -> titulos (HTML, regex)
     * Los uuid "omeka-item-<id>" NO sirven para saij_get_document: el texto
     * se lee/descarga desde el enlace de cada item.
     */
    async searchBiblioteca(params) {
        const base = "http://www.bibliotecadigital.gob.ar";
        const q = String(params.query || "").trim();
        const pageSize = 10; // paginado fijo de Omeka en este sitio
        const offset = params.offset || 0;
        const page = Math.floor(offset / pageSize) + 1;
        const headers = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };
        // Colecciones con ID verificado en vivo (11/06/2026). El browse combina
        // search + collection sin problemas (probado: search=codigo&collection=20
        // => 35 resultados, todos collection_id 20).
        const COLECCIONES = {
            libros_saij: "20",
            patrimonio_historico: "13",
            politica_criminal: "21",
            en_buena_ley: "33",
            revistas_saij: "31", // deducido en vivo: los items de las subcolecciones de revistas traen collection_id 31
        };
        let col = null;
        if (params.coleccion !== undefined && params.coleccion !== null && String(params.coleccion).trim() !== "") {
            const clave = String(params.coleccion).trim().toLowerCase().replace(/\s+/g, "_");
            col = COLECCIONES[clave] || (/^\d+$/.test(clave) ? clave : null);
        }
        const colParams = col ? { collection: col } : {};
        // Subcoleccion de Revistas SAIJ (element_id 87 del esquema Omeka,
        // verificado en vivo 11/06/2026; combina con search y con collection).
        const SUBCOLECCIONES = {
            derecho_privado: "Derecho Privado",
            derecho_penal: "Derecho Penal",
            derecho_publico: "Derecho Público",
            derechos_humanos: "Derechos Humanos",
            derecho_del_trabajo: "Derecho del Trabajo",
            filosofia_del_derecho: "Filosofía del Derecho",
        };
        let subcol = null;
        if (params.subcoleccion !== undefined && params.subcoleccion !== null && String(params.subcoleccion).trim() !== "") {
            const claveSub = String(params.subcoleccion).trim().toLowerCase()
                .normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, "_");
            subcol = SUBCOLECCIONES[claveSub] || String(params.subcoleccion).trim();
        }
        const advParams = subcol
            ? {
                "advanced[0][element_id]": "87",
                "advanced[0][type]": "is exactly",
                "advanced[0][terms]": subcol,
            }
            : {};
        // page=1 explicito devolvio respuestas vacias en pruebas; se omite.
        const pageParams = page > 1 ? { page } : {};
        // Sin termino, el browse lista el catalogo completo (1438 items al
        // 11/06/2026), paginado de a 10; util combinado con coleccion o
        // subcoleccion. Se omite el parametro search vacio.
        const qParams = q ? { search: q } : {};
        const jsonRes = await axios.get(`${base}/items/browse`, {
            params: { ...qParams, output: "json", ...colParams, ...advParams, ...pageParams },
            headers,
            timeout: 20000,
        });
        const data = typeof jsonRes.data === "string" ? JSON.parse(jsonRes.data) : jsonRes.data;
        const items = Array.isArray(data?.items) ? data.items : [];
        const total = data?.total_results ?? items.length;
        // Titulos desde el HTML de la misma pagina de resultados (el JSON de
        // Omeka no incluye metadatos). Si falla, se devuelven igual los enlaces.
        const titulos = new Map();
        try {
            const htmlRes = await axios.get(`${base}/items/browse`, {
                params: { ...qParams, ...colParams, ...advParams, ...pageParams },
                headers,
                timeout: 20000,
            });
            const html = String(htmlRes.data);
            const re = /<a\s+[^>]*href="[^"]*\/items\/show\/(\d+)[^"]*"[^>]*>([^<]+)<\/a>/g;
            let m;
            while ((m = re.exec(html)) !== null) {
                const id = m[1];
                const texto = m[2].replace(/\s+/g, " ").trim();
                if (!texto || /^ingresar$/i.test(texto))
                    continue; // anchors del carrusel de portada
                if (!titulos.has(id))
                    titulos.set(id, texto);
            }
        }
        catch {
            // sin titulos: los enlaces alcanzan para abrir cada item
        }
        const results = items.map((it) => ({
            uuid: `omeka-item-${it.id}`,
            document_score: 0,
            document_abstract: JSON.stringify({
                titulo: titulos.get(String(it.id)) || `Item ${it.id} (titulo no disponible; abrir enlace)`,
                enlace: `${base}/items/show/${it.id}`,
                agregado: it.added || null,
            }),
        }));
        return {
            total_results: total,
            offset: (page - 1) * pageSize,
            page_size: pageSize,
            results,
            query: q,
            expanded_query: `${base}/items/browse?${q ? `search=${encodeURIComponent(q)}` : ""}${col ? `&collection=${col}` : ""}${page > 1 ? `&page=${page}` : ""}`.replace("?&", "?"),
            coleccion: col ? `collection=${col}` : "todas",
            subcoleccion: subcol || "todas",
            fuente: "bibliotecadigital.gob.ar (Biblioteca Digital de Ediciones SAIJ, plataforma Omeka)",
            nota: "Los uuid omeka-item-* no funcionan con saij_get_document; usar el enlace de cada item para leer/descargar el PDF o EPUB.",
        };
    }
    /**
     * Ficha completa de una obra de la Biblioteca Digital (bibliotecadigital.gob.ar).
     *
     * AGREGADO 11/06/2026 (ronda 18): la ficha items/show/{id} trae metadatos
     * ricos (resumen/sumario del tomo, director, anio, numero, ISSN, temas) y
     * el enlace de descarga directa del PDF en /files/original/ (verificado en
     * vivo con el item 1430, "Derecho del Trabajo N° 8"). Parseo por regex
     * sobre la estructura <h3>Campo</h3>...contenido... del tema Omeka
     * AvantGarde, con whitelist de campos conocidos (saij-mcp no tiene cheerio).
     */
    async getBibliotecaItem(itemId) {
        const base = "http://www.bibliotecadigital.gob.ar";
        const id = String(itemId).replace(/^omeka-item-/i, "").trim();
        if (!/^\d+$/.test(id)) {
            throw new Error("ID invalido: se espera el numero de item (ej. 1430) o el uuid omeka-item-<n> devuelto por search_biblioteca.");
        }
        const url = `${base}/items/show/${id}`;
        const res = await axios.get(url, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
            timeout: 20000,
        });
        const html = String(res.data);
        const decode = (s) => s
            .replace(/<[^>]+>/g, " ")
            .replace(/&nbsp;/gi, " ")
            .replace(/&amp;/gi, "&")
            .replace(/&lt;/gi, "<")
            .replace(/&gt;/gi, ">")
            .replace(/&quot;/gi, '"')
            .replace(/&middot;/gi, "·")
            .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
            .replace(/\bVer (menos|m[aá]s) autores\b/gi, " ")
            .replace(/\s+/g, " ")
            .trim();
        const titulo = decode((html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/·\s*Biblioteca Digital\s*$/i, ""));
        const CAMPOS_VALIDOS = new Set([
            "Título", "Subtítulo", "Resumen", "Director/a", "Autor/es", "Autor/a",
            "Editorial", "Año", "Número", "Colección del libro", "Fecha", "Idioma",
            "Identificador / ID", "ISSN", "ISBN", "Tipo de publicación", "Tema",
            "Cita bibliográfica", "Descripción", "Materia",
        ]);
        const campos = {};
        const bloques = html.split(/<h3>/i).slice(1);
        for (const bloque of bloques) {
            const cierre = bloque.indexOf("</h3>");
            if (cierre === -1)
                continue;
            const nombre = decode(bloque.slice(0, cierre));
            if (!CAMPOS_VALIDOS.has(nombre))
                continue;
            // contenido hasta el proximo encabezado de cualquier nivel o tabla
            const resto = bloque.slice(cierre + 5);
            const corte = resto.search(/<h[2-4]|<table/i);
            const contenido = decode(corte === -1 ? resto : resto.slice(0, corte)).slice(0, 1500);
            if (contenido && !campos[nombre])
                campos[nombre] = contenido;
        }
        const archivos = [];
        const vistos = new Set();
        const reArchivo = /href="((?:https?:\/\/[^"]*)?\/files\/original\/[^"]+\.(?:pdf|epub))"/gi;
        let m;
        while ((m = reArchivo.exec(html)) !== null) {
            const enlace = m[1].startsWith("http") ? m[1] : `${base}${m[1]}`;
            if (vistos.has(enlace))
                continue;
            vistos.add(enlace);
            archivos.push({ nombre: decodeURIComponent(enlace.split("/").pop() || ""), enlace });
        }
        return {
            id,
            titulo: titulo || campos["Título"] || `Item ${id}`,
            ficha: url,
            campos,
            archivos,
            fuente: "bibliotecadigital.gob.ar (Biblioteca Digital de Ediciones SAIJ, plataforma Omeka)",
        };
    }
    /**
     * Retrieves the latest legal news (novedades).
     */
    async getNovedades(limit = 10) {
        // FIX 11/06/2026 v2 (re-test ronda 10, capturado de la portada real):
        // la home de saij.gob.ar pide las novedades con r=destacada:1, f=Total
        // y p=500, y ORDENA EN EL CLIENTE por fecha (parserFechaCompleta en su
        // JS). El intento v1 (s=fecha-rango|DESC sobre la faceta
        // "Publicación/Novedad") fallaba porque esa faceta es un indice viejo
        // (datos 2017) y el orden server-side no aplico ahi. Se replica
        // exactamente lo que hace la portada: traer destacadas y ordenar aca.
        const extraerFecha = (abstract) => {
            if (typeof abstract !== "string")
                return null;
            const iso = abstract.match(/"fecha[^"]*"\s*:\s*"(\d{4})-(\d{2})-(\d{2})/);
            if (iso)
                return `${iso[1]}-${iso[2]}-${iso[3]}`;
            const esp = abstract.match(/(\d{2})\/(\d{2})\/(\d{4})/);
            if (esp)
                return `${esp[3]}-${esp[2]}-${esp[1]}`;
            const anio = abstract.match(/"fecha[^"]*"\s*:\s*"(\d{4})"/);
            return anio ? `${anio[1]}-01-01` : null;
        };
        try {
            const res = await this.searchRaw("Total", {
                rawQuery: "destacada:1",
                pageSize: 500,
                offset: 0,
                view: "detallada",
            });
            if (res.results.length > 0) {
                const ordenados = res.results
                    .map((r) => ({ r, fecha: extraerFecha(r.document_abstract) }))
                    .sort((a, b) => (b.fecha || "0000").localeCompare(a.fecha || "0000"));
                return {
                    ...res,
                    page_size: limit,
                    results: ordenados.slice(0, Math.max(1, limit)).map((x) => x.r),
                    query: "destacada:1 (novedades de portada, orden por fecha desc aplicado client-side)",
                };
            }
        }
        catch (_e) {
            // cae al fallback historico
        }
        // Fallback: faceta historica de novedades (indice viejo, sin orden)
        const res = await this.searchRaw(PRESET_FILTERS.novedades || "Publicación/Novedad", {
            query: "*:*",
            pageSize: limit,
            offset: 0,
            view: "detallada",
        });
        res.advertencia = "Se uso el indice historico 'Publicación/Novedad' (la consulta de portada destacada:1 fallo o vino vacia); las fechas pueden ser viejas. Verificar antes de usar.";
        return res;
    }
    /**
     * Generic search using a raw filter string.
     *
     * FIX 10/06/2026 (capturado del trafico real del buscador de saij.gob.ar):
     * el termino de busqueda viaja en el parametro `r` (rawQuery), NO en `s`.
     * Mandar el termino en `s` provoca HTTP 500 ("Ocurrió un error durante la
     * operación"). Formato verificado: r="+titulo: despido", r="+tema:despido",
     * frases con "?" entre palabras (r="+tema:despido?por?riña"); `s` va vacio.
     */
    buildRawQuery(query) {
        if (!query || query === "*:*") return "";
        const q = String(query).trim();
        // Verificado en vivo 10/06/2026:
        //   - "+titulo: despido" y "+texto: despido" devuelven resultados reales.
        //   - el texto libre sin campo se expande server-side a "contenido:" que
        //     NO matchea nada (campo muerto) -> se mapea a "texto:".
        //   - la frase con "?" ("locacion?de?obra") da 0: los stopwords no estan
        //     en el indice y rompen la frase -> multipalabra = AND de terminos
        //     por campo, sin stopwords.
        const STOP = new Set(["de", "la", "el", "los", "las", "y", "o", "u", "del", "al", "en", "por", "para", "con", "sin", "sobre", "a", "e", "un", "una", "unos", "unas", "que", "se", "su", "sus", "lo"]);
        const m = q.match(/^\+?([a-z][a-z-]*):\s*(.+)$/i);
        const campo = m ? m[1].toLowerCase() : "texto";
        const valor = (m ? m[2] : q).trim();
        const palabras = valor.split(/\s+/).filter((w) => w && !STOP.has(w.toLowerCase()));
        if (!palabras.length) return "";
        if (palabras.length === 1) return `+${campo}: ${palabras[0]}`;
        return palabras.map((w) => `+${campo}:${w}`).join(" ");
    }
    async searchRaw(filterStr, params) {
        const queryParams = {
            o: (params.offset || 0).toString(),
            p: (params.pageSize || 20).toString(),
            f: filterStr,
            // `s` es el parametro de ORDEN (no el termino de busqueda, que va
            // en `r`). Vacio = orden por relevancia del indice.
            s: params.sort || "",
            v: params.view || "colapsada",
        };
        // rawQuery explicito (passthrough, ej. "destacada:1" como lo manda la
        // portada) tiene prioridad sobre la construccion desde params.query.
        const r = params.rawQuery !== undefined ? params.rawQuery : this.buildRawQuery(params.query);
        if (r) queryParams.r = r;
        const data = await apiClient.get("/busqueda", {
            params: queryParams,
        });
        return this.parseResponse(data, params.query || "*:*");
    }
    /**
     * Provides autocomplete suggestions for legal terms or topics.
     */
    async suggestTerms(term, amount = 10) {
        const data = await apiClient.get("/suggest", {
            params: {
                key: term,
                amount: amount.toString(),
                suggesterName: "suggest",
            },
        });
        try {
            const suggestions = typeof data === "string" ? JSON.parse(data) : data;
            return Array.isArray(suggestions) ? suggestions : [];
        }
        catch (e) {
            return [];
        }
    }
    /**
     * Parses the raw API response into a validated SearchResponse.
     */
    parseResponse(data, query) {
        const queryData = data.queryObjectData || {};
        const searchData = data.searchResults || {};
        const results = (searchData.documentResultList || []).map((item) => ({
            uuid: item.uuid || "",
            document_score: item.documentScore || 0.0,
            document_abstract: item.documentAbstract || null,
        }));
        const response = {
            total_results: searchData.totalSearchResults || 0,
            offset: queryData.offset || 0,
            page_size: queryData.pageSize || 20,
            results: results,
            query: query,
            expanded_query: searchData.expandedQuery || null,
        };
        return SearchResponseSchema.parse(response);
    }
}
// Export a singleton instance
export const searchService = new SearchService();
