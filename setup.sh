#!/usr/bin/env bash
# setup.sh - mcp-legal-ar installer para macOS y Linux
# Ejecutar desde la carpeta donde extrajiste el ZIP:
#   bash setup.sh

set -euo pipefail

echo ""
echo "========================================"
echo "   mcp-legal-ar - Instalacion automatica"
echo "========================================"
echo ""

# -------------------------------------------------------
# 1. Verificar Node.js
# -------------------------------------------------------
echo "Verificando Node.js..."

NODE_EXE=""
for p in "/usr/local/bin/node" "/opt/homebrew/bin/node" "/usr/bin/node"; do
    if [ -x "$p" ]; then NODE_EXE="$p"; break; fi
done
if [ -z "$NODE_EXE" ] && command -v node &>/dev/null; then
    NODE_EXE=$(command -v node)
fi

if [ -z "$NODE_EXE" ]; then
    echo ""
    echo "[ERROR] Node.js no esta instalado."
    echo ""
    echo "Por favor seguí estos pasos:"
    echo "  1. Abrí el navegador y andá a: https://nodejs.org"
    echo "  2. Hacé clic en el boton verde 'Download Node.js (LTS)'"
    echo "  3. Instalá el programa descargado"
    echo "  4. Abrí una nueva terminal y volvé a ejecutar este script"
    echo ""
    exit 1
fi

NODE_VERSION=$("$NODE_EXE" --version)
MAJOR=$(echo "$NODE_VERSION" | sed 's/v//' | cut -d. -f1)
if [ "$MAJOR" -lt 18 ]; then
    echo ""
    echo "[ERROR] Node.js instalado ($NODE_VERSION) es muy antiguo. Se necesita v18 o superior."
    echo ""
    echo "Andá a https://nodejs.org, descargá la version LTS y volvé a ejecutar este script."
    echo ""
    exit 1
fi
echo "[OK] Node.js $NODE_VERSION encontrado."

# -------------------------------------------------------
# 2. Detectar ubicacion del repo
# -------------------------------------------------------
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENTRY_POINT="$REPO_DIR/build/index.js"

echo "[OK] Repositorio encontrado en: $REPO_DIR"

if [ ! -f "$ENTRY_POINT" ]; then
    echo ""
    echo "[ERROR] No se encontro el archivo principal del hub."
    echo "        Archivo esperado: $ENTRY_POINT"
    echo ""
    echo "Asegurate de haber extraido el ZIP completo sin mover ni borrar carpetas."
    echo ""
    exit 1
fi

# -------------------------------------------------------
# 3. Instalar dependencias
# -------------------------------------------------------
echo ""
echo "Instalando dependencias (puede tardar unos minutos)..."

export PUPPETEER_SKIP_DOWNLOAD=true

cd "$REPO_DIR"
echo "  > npm install (hub raiz)..."
npm install --prefer-offline --silent

cd "$REPO_DIR/servers/legal-mcp"
echo "  > npm install (legal-mcp)..."
npm install --prefer-offline --silent

cd "$REPO_DIR"
echo "[OK] Dependencias instaladas."

# -------------------------------------------------------
# 4. Configurar Claude Desktop
# -------------------------------------------------------
echo ""
echo "Configurando Claude Desktop..."

if [[ "$OSTYPE" == "darwin"* ]]; then
    CONFIG_DIR="$HOME/Library/Application Support/Claude"
else
    CONFIG_DIR="$HOME/.config/Claude"
fi
CONFIG_PATH="$CONFIG_DIR/claude_desktop_config.json"

mkdir -p "$CONFIG_DIR"

if [ -f "$CONFIG_PATH" ]; then
    if ! python3 -c "import json; json.load(open('$CONFIG_PATH'))" 2>/dev/null; then
        echo "[AVISO] El config existente tiene errores de formato. Se creara uno nuevo."
        echo '{}' > "$CONFIG_PATH"
    else
        echo "[INFO] Config existente encontrado. Mergeando..."
    fi
else
    echo "[INFO] No habia config previo. Creando uno nuevo."
    echo '{}' > "$CONFIG_PATH"
fi

python3 - "$CONFIG_PATH" "$NODE_EXE" "$ENTRY_POINT" <<'PYEOF'
import json, sys

config_path = sys.argv[1]
node_exe    = sys.argv[2]
entry_point = sys.argv[3]

with open(config_path, "r", encoding="utf-8") as f:
    config = json.load(f)

if "mcpServers" not in config:
    config["mcpServers"] = {}

config["mcpServers"]["mcp-legal-ar"] = {
    "command": node_exe,
    "args": [entry_point]
}

with open(config_path, "w", encoding="utf-8") as f:
    json.dump(config, f, indent=2, ensure_ascii=False)
PYEOF

echo "[OK] Claude Desktop configurado."
echo "     Archivo: $CONFIG_PATH"

# -------------------------------------------------------
# 5. Resumen final
# -------------------------------------------------------
echo ""
echo "========================================"
echo "   Instalacion completada con exito!    "
echo "========================================"
echo ""
echo "Proximo paso:"
echo "  Cerrá Claude Desktop completamente y volvé a abrirlo."
echo "  El conector mcp-legal-ar aparecera con las herramientas disponibles."
echo ""
