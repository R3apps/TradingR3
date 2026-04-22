# Permitir ejecución de scripts
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser -Force

Write-Host "Iniciando TradingR3..." -ForegroundColor Cyan

# 1. Verificar Python
if (!(Get-Command python -ErrorAction SilentlyContinue)) {
    Write-Error "Python no encontrado en PATH."
    exit 1
}

# 2. Crear entorno virtual si no existe
if (!(Test-Path "venv")) {
    Write-Host "Creando entorno virtual..." -ForegroundColor Yellow
    python -m venv venv
}

# 3. Activar entorno virtual
Write-Host "Activando entorno virtual..." -ForegroundColor Yellow
. .\venv\Scripts\Activate.ps1

# 4. Actualizar pip
python -m pip install --upgrade pip --quiet

# 5. Instalar todas las dependencias directo desde PyPI
Write-Host "Instalando dependencias..." -ForegroundColor Yellow
pip install pywebview==4.4.1 fastapi==0.111.0 uvicorn==0.30.0 websockets==12.0 pandas==2.2.2 httpx==0.27.0 aiohttp==3.9.5 pandas-ta-classic

# Descargar lightweight-charts localmente si no existe
if (!(Test-Path "frontend/lightweight-charts.standalone.production.js")) {
    Write-Host "Descargando lightweight-charts localmente..." -ForegroundColor Yellow
    Invoke-WebRequest -Uri "https://unpkg.com/lightweight-charts@4.2.1/dist/lightweight-charts.standalone.production.js" `
        -OutFile "frontend/lightweight-charts.standalone.production.js"
}

# 6. Lanzar la aplicación
Write-Host "Lanzando ventana de escritorio..." -ForegroundColor Green
python main.py
