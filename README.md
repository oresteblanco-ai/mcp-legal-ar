# mcp-legal-ar

8 conectores jurídicos argentinos integrados en uno solo. 100% local. Sin servidores externos de terceros. Código abierto y auditable.

---

## ¿Qué es esto y para qué sirve?

Claude Desktop puede conectarse a bases de datos externas a través de conectores llamados MCP. Este repositorio instala un único conector que le da acceso simultáneo a las principales fuentes jurídicas argentinas:

- Jurisprudencia: JUBA, SCBA
- Boletines oficiales: BORA, BOPBA
- Legislación: InfoLEG, Normativa PBA
- Doctrina administrativa y fiscal: PTN, TFN

Sin este hub, cada fuente requeriría instalar y configurar un conector por separado. Con este hub, se instala uno solo y las 8 fuentes quedan disponibles al mismo tiempo.

Este repositorio no crea ninguna fuente nueva. Unifica conectores desarrollados por la comunidad argentina de legal tech; el mérito de cada uno corresponde a sus autores originales.

---

## Arquitectura

`mcp-legal-ar` es un servidor proxy MCP. Al iniciarse, levanta cada conector como proceso hijo, registra todas sus herramientas y las expone como un único servidor. Claude Desktop ve un solo conector con todas las herramientas disponibles.

```
Claude Desktop
     └── mcp-legal-ar (proxy)
           ├── bora__*         → proceso hijo Node
           ├── bopba__*        → proceso hijo Node
           ├── infoleg__*      → proceso hijo Node
           ├── normativapba__* → proceso hijo Node
           ├── juba__*         → proceso hijo Node
           ├── ptn__*          → proceso hijo Node
           ├── tfn__*          → proceso hijo Node
           └── scba__*         → proceso hijo Node
```

---

## Seguridad y privacidad

**Transporte local (stdio).** El hub se comunica con Claude Desktop directamente en tu máquina, sin pasar por ningún servidor intermediario. Las consultas no salen hacia infraestructura de terceros.

**Solo lectura.** El hub no escribe archivos, no ejecuta comandos y no actúa sobre ningún endpoint. No registra consultas ni las envía a ningún destino externo.

**Auditable.** El código fuente completo está en GitHub. Cualquier abogado o profesional de seguridad puede verificar exactamente qué hace cada conector antes de instalarlo.

**Certificados TLS:** cada conector usa validación TLS estándar. La única excepción es SCBA (`sentencias.scba.gov.ar`), cuyo servidor oficial presenta un certificado con cadena de confianza incompleta. Para ese conector la verificación está desactivada de forma aislada dentro de su propio cliente HTTP, sin afectar al resto del stack. El tráfico involucrado es exclusivamente de lectura de jurisprudencia pública, sin credenciales ni datos del usuario.

---

## Requisitos

Antes de instalar, necesitás tener en tu computadora:

1. **Claude Desktop** - Descargar desde [claude.ai/download](https://claude.ai/download)
2. **Node.js** - Descargar desde [nodejs.org](https://nodejs.org) (elegir la versión LTS)

Para verificar si Node.js ya está instalado, abrir el símbolo del sistema (CMD) y ejecutar:

```
node --version
```

Si aparece un número de versión (por ejemplo `v20.11.0`), ya está instalado.

---

## Instalación (opción recomendada - automática)

1. Hacer clic en el botón verde **Code** arriba a la derecha y seleccionar **Download ZIP**
2. Extraer el ZIP en cualquier carpeta. GitHub crea una carpeta `mcp-legal-ar-main` al extraerlo - podés dejarla así o renombrarla
3. Dentro de esa carpeta, hacer clic derecho en `setup.ps1` y seleccionar **"Ejecutar con PowerShell"**

El script detecta automáticamente la ubicación del repositorio y configura Claude Desktop.

---

## Instalación manual (paso a paso)

### Paso 1 - Descargar el repositorio

Hacer clic en el botón verde **Code** arriba a la derecha y seleccionar **Download ZIP**. Extraer el ZIP en una carpeta. GitHub descarga el ZIP con el nombre `mcp-legal-ar-main.zip` y crea una carpeta `mcp-legal-ar-main` al extraerlo - renombrala a `mcp-legal-ar` o al nombre que prefieras. En los pasos siguientes usamos `C:\mcp-legal-ar` como ejemplo; reemplazálo por la ruta real donde extrajiste el ZIP.

### Paso 2 - Instalar dependencias

Abrir el símbolo del sistema (CMD) y ejecutar:

```
cd C:\mcp-legal-ar
npm install
npm install --prefix servers\legal-mcp
```

### Paso 3 - Configurar Claude Desktop

Abrir el archivo de configuración de Claude Desktop. La ruta depende de cómo instalaste Claude:

**Instalación clásica:**
```
C:\Users\TU_USUARIO\AppData\Roaming\Claude\claude_desktop_config.json
```

**Instalación Microsoft Store:**

Abrí PowerShell y ejecutá:
```
Get-ChildItem "$env:LOCALAPPDATA\Packages" -Filter "Claude_*" | Select-Object FullName
```
Eso te muestra la carpeta exacta. El config está en `LocalCache\Roaming\Claude\claude_desktop_config.json` dentro de esa carpeta.

Si no sabés cuál es la tuya, abrí el Explorador de archivos, pegá `%APPDATA%\Claude` en la barra de dirección y presioná Enter. Si abre una carpeta, es la instalación clásica. Si da error, es la instalación Microsoft Store.

Reemplazar `TU_USUARIO` con el nombre de usuario de Windows. Abrir ese archivo con el Bloc de notas y agregar dentro de `"mcpServers"`:

```json
"mcp-legal-ar": {
  "command": "node",
  "args": ["C:\\mcp-legal-ar\\build\\index.js"]
}
```

El archivo completo debería quedar así:

```json
{
  "mcpServers": {
    "mcp-legal-ar": {
      "command": "node",
      "args": ["C:\\mcp-legal-ar\\build\\index.js"]
    }
  }
}
```

> **Importante:** usar doble barra invertida `\\` en todas las rutas del JSON. La carpeta puede llamarse como quieras; lo que importa es que la ruta en `args` apunte al `build\index.js` de donde extrajiste el repositorio.

### Paso 4 - Reiniciar Claude Desktop

Cerrar Claude Desktop completamente: click derecho en el ícono de la bandeja del sistema (esquina inferior derecha) y seleccionar **Salir**. Volver a abrirlo. El conector `mcp-legal-ar` debería aparecer en la lista de herramientas disponibles.

---

## Solución de problemas

**El conector no aparece en Claude Desktop**

Verificar que el archivo `claude_desktop_config.json` tenga el formato correcto (sin comas de más ni llaves faltantes). Cerrar Claude Desktop completamente desde la bandeja del sistema antes de reiniciarlo.

**Error al ejecutar `npm install`**

Verificar que Node.js esté instalado correctamente ejecutando `node --version` en CMD. Si da error, reinstalar Node.js desde [nodejs.org](https://nodejs.org).

**Algún conector aparece como desconectado**

Algunos conectores dependen de que las webs oficiales estén disponibles. Si una fuente está caída, el resto sigue funcionando normalmente.

---

## Fuentes disponibles

### ✅ Operativos

| # | Nombre | Descripción | Herramientas | Crédito |
|---|--------|-------------|--------------|---------|
| 1 | **BORA** | Boletín Oficial de la República Argentina | 14 | [voftec/bora-mcp](https://github.com/voftec/bora-mcp) |
| 2 | **BOPBA** | Boletín Oficial de la Provincia de Buenos Aires | 15 | [voftec/bopba-mcp](https://github.com/voftec/bopba-mcp) |
| 3 | **InfoLeg** | Legislación nacional | 20 | [voftec/InfoLeg-MCP](https://github.com/voftec/InfoLeg-MCP) |
| 4 | **Normativa PBA** | Legislación provincial de Buenos Aires | 9 | [voftec/normativapba-mcp](https://github.com/voftec/normativapba-mcp) |
| 5 | **JUBA** | Jurisprudencia SCBA y cámaras PBA | 21 | [voftec/juba-mcp](https://github.com/voftec/juba-mcp) |
| 6 | **PTN** | Dictámenes de la Procuración del Tesoro | 22 | [voftec/ptn-mcp](https://github.com/voftec/ptn-mcp) |
| 7 | **TFN** | Tribunal Fiscal de la Nación | 15 | [voftec/tfn-mcp](https://github.com/voftec/tfn-mcp) |
| 8 | **SCBA** | Sentencias y resoluciones de la Suprema Corte de Buenos Aires | 4 | [FacundoEmanuel/scba-mcp-server](https://github.com/FacundoEmanuel/scba-mcp-server) |

### 🔧 En desarrollo

| # | Nombre | Descripción | Estado |
|---|--------|-------------|--------|
| 9 | **SAIJ** | Sistema Argentino de Información Jurídica (330.000+ documentos) | Requiere autenticación de sesión |
| 10 | **PJN Expedientes** | Estado procesal de causas federales | Requiere resolución de CAPTCHA |
| 11 | **PJN Jurisprudencia** | Fallos y sentencias federales | Requiere resolución de CAPTCHA |

---

## Créditos

Este repositorio únicamente unifica servidores MCP desarrollados por otros. Todo el mérito de cada conector corresponde a sus autores originales:

- BORA, BOPBA, InfoLeg, Normativa PBA, JUBA, PTN, TFN - [Voftec](https://github.com/voftec)
- SCBA MCP Server - [FacundoEmanuel](https://github.com/FacundoEmanuel)

Ensamblado por [@abogadoaboitiz](https://x.com/abogadoaboitiz)

---

## Licencia

Apache 2.0
