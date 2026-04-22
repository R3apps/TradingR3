#!/bin/bash

# Colores para la terminal
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${CYAN}Iniciando TradingR3 en Linux...${NC}"

# 1. Verificar si python3 está presente
if ! command -v python3 &> /dev/null
then
    echo -e "${RED}Error: python3 no está instalado. Por favor instala python3 y python3-venv.${NC}"
    exit 1
fi

# 2. Crear entorno virtual si no existe
if [ ! -d "venv" ]; then
    echo -e "${YELLOW}Creando entorno virtual...${NC}"
    python3 -m venv venv
fi

# 3. Activar entorno virtual
echo -e "${YELLOW}Activando entorno virtual...${NC}"
source venv/bin/activate

# 4. Actualizar pip
python3 -m pip install --upgrade pip --quiet

# 5. Instalar todas las dependencias
echo -e "${YELLOW}Instalando dependencias en el entorno virtual...${NC}"
pip install pywebview==4.4.1 fastapi==0.111.0 uvicorn==0.30.0 websockets==12.0 pandas==2.2.2 httpx==0.27.0 aiohttp==3.9.5 pandas-ta-classic

# 6. Descargar lightweight-charts localmente si no existe
if [ ! -f "frontend/lightweight-charts.standalone.production.js" ]; then
    echo -e "${YELLOW}Descargando lightweight-charts localmente...${NC}"
    if command -v curl &> /dev/null; then
        curl -L "https://unpkg.com/lightweight-charts@4.2.1/dist/lightweight-charts.standalone.production.js" -o "frontend/lightweight-charts.standalone.production.js"
    elif command -v wget &> /dev/null; then
        wget "https://unpkg.com/lightweight-charts@4.2.1/dist/lightweight-charts.standalone.production.js" -O "frontend/lightweight-charts.standalone.production.js"
    else
        echo -e "${RED}Error: Se requiere curl o wget para descargar librerías base.${NC}"
    fi
fi

# 7. Lanzar la aplicación
echo -e "${GREEN}Lanzando aplicación TradingR3...${NC}"
python3 main.py
