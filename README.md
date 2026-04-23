# 🚀 TradingR3 — Advanced Trading Replay System

**TradingR3** es una alternativa gratuita para ver tus graficos en tiempo real y realizar backtest. Permite simular el movimiento del mercado vela a vela, aplicar indicadores técnicos y gestionar operaciones de forma visual y analítica, todo bajo una interfaz inspirada en los estándares de la industria.

<img width="1430" height="898" alt="image" src="https://github.com/user-attachments/assets/fda0bce4-f2d7-468b-9b2f-efc37bf28588" />
<img width="1919" height="1078" alt="image" src="https://github.com/user-attachments/assets/536e24fd-bbd7-40fc-adc7-866b3823f1e4" />
<img width="1431" height="895" alt="image" src="https://github.com/user-attachments/assets/03be17c4-a346-4ba8-88aa-be16adbc0496" />
<img width="1437" height="898" alt="image" src="https://github.com/user-attachments/assets/062865f4-a4d8-4309-96e0-c43da7410643" />
<img width="1434" height="902" alt="image" src="https://github.com/user-attachments/assets/a8fd0d63-fd55-4a05-ad1b-9cbc72d6f184" />
<img width="1920" height="1077" alt="image" src="https://github.com/user-attachments/assets/b8ddf369-389f-4b63-99c3-fa6698612eb4" />
<img width="1920" height="1080" alt="image" src="https://github.com/user-attachments/assets/13dc0827-ec75-4f0f-855b-11b28530d248" />

---

## 📥 Instalación y Uso

### 🪟 Para Usuarios de Windows (Recomendado)
Para disfrutar de la mejor experiencia sin complicaciones:
1. Ve a la sección de **[Releases](https://github.com/R3apps/TradingR3/releases)** de este repositorio.
2. Descarga el archivo comprimido `TradingR3_Portable.zip`.
3. Descomprime la carpeta en cualquier ubicación (Escritorio, Documentos, etc.).
4. Ejecuta el archivo `TradingR3.exe` para iniciar la aplicación.

> **Nota**: Al ser una versión portable, todos tus datos (configuración, backtests y dibujos) se guardarán automáticamente dentro de la propia carpeta del programa. No requiere permisos de administrador.

---

### 🐧 Para Usuarios de Linux
Si prefieres ejecutar el código fuente en Linux:

**1. Preparación (Solo la primera vez):**
Clona el repositorio e instala las dependencias necesarias:
```bash
git clone https://github.com/r3apps/TradingR3.git
cd TradingR3
python3 -m venv venv
./venv/bin/pip install -r requirements.txt
```

**2. Ejecución:**
Utiliza el script de lanzamiento incluido:
```bash
chmod +x run_app.sh
./run_app.sh
```

---

## ⚡ Criptomonedas (Sin configuración)
TradingR3 integra la **API pública de Binance** para todos los datos de criptomonedas. 
- **Plug & Play**: No requiere registro ni introducir API Keys.
- **Inmediato**: Puedes visualizar gráficos y hacer backtesting de BTC, ETH, SOL y cientos de pares más nada más iniciar la aplicación.

---

## ⚙️ Configuración de OANDA (Forex y CFD)

Para utilizar el backtest con Forex y otros activos premium, es necesario vincular una cuenta de OANDA. Sigue estos pasos para asegurar la compatibilidad con la API:

### 🌍 Registro de Cuenta Demo
Dependiendo de tu región, el acceso a la API de Oanda puede variar. Para garantizar la funcionalidad total en el entorno de desarrollo:

1. Accede al registro aquí: **[OANDA Apply](https://www.oanda.com/apply/select)**.
2. Selecciona **"Demo Trading Account"**.
3. En **"Where do you live?"**, selecciona una región compatible con el acceso API Global (ej: regiones fuera de la UE/Andorra).
4. Rellena tus datos.
5. Tras el registro, verás una pantalla de "Thanks...". Haz scroll y entra al **Oanda Hub**.

### 🔑 Obtención de API Key y Account ID
1. En el Oanda Hub, ve a la pestaña **Trading Tools** > **Oanda API** > **Generate**. Ese es tu Token/API Key.
2. Tu **Account ID** lo verás en la pestaña **"Accounts"**, bajo el nombre de tu cuenta **"primary"**.

¡Ya puedes configurar estos datos en TradingR3 y disfrutar de todo el historial!

---

## ✨ Características Principales

- **🎮 Motor de Replay**: Control total sobre la velocidad y el avance de las velas.
- **📊 Gráficos de Alta Fidelidad**: Integración con Lightweight Charts para una experiencia fluida.
- **📈 Análisis Técnico**: Indicadores RSI y Estocástico sincronizados en tiempo real.
- **📥 Reportes CSV**: Exporta el historial de tus operaciones directamente a tu escritorio.
- **💾 Sesiones Persistentes**: Guarda tus jornadas de backtest para continuarlas más tarde.

## 🛠️ Stack Tecnológico

- **Backend**: Python (FastAPI + WebSockets).
- **Frontend**: Vanilla JavaScript + HTML5.
- **Gráficos**: Lightweight Charts (TradingView).
- **Desktop**: PyWebView.

## 🗺️ Roadmap — Próximas Mejoras

Queremos que TradingR3 sea la herramienta de trading y backtest gratuita más completa. Estas son las funciones que tenemos en el radar:

- [ ] **🌐 Multi Idiomas**: Integración de otros idiomas en la v2 (Próximamente).
- [ ] **🛠️ Mejorar Herramientas de Dibujo**: Añadir otras herramientas como iman, configuración de las herramientas de dibujo (Parámetros de fibonacci, etc).
- [ ] **🛠️ Configuración de la ventana del gráfico**: Añadir tus propios colores de velas y configurar el estilo del gráfico según tus gustos.
- [ ] **🏦 Multi Brokers**: Compatibilidad con otros brokers (FX, etc.). Se valorará.
- [ ] **🧪 Multi-Indicadores**: Implementar mas indicadores, como MACD, Volatilidad, etc.
- [ ] **🖼️ Soporte Multisimbolo**: Poder abrir varios ventanas divididas.
- [ ] **📋 Panel de Estadísticas Avanzado**: Gráficas de Equity Curve y estadísticas de Drawdown detalladas en backtest.
- [ ] **🤖 Alertas de Precio**: Sistema de avisos sonoros cuando el precio llegue a niveles marcados.
- [ ] **🕒 Configuración de Zona Horaria**: Habilitar la configuración de tu zona horaria local (Actualmente en UTC).
- [ ] **☁️ Sync en la Nube**: Opción para guardar sesiones y dibujos directamente en una cuenta de usuario y sincronización en R3tools.
- [ ] **📱  App Android**: Sincroniza y trabaja donde quieras con la app de Android.
- [ ] **📱  App IOS**: Sincroniza y trabaja donde quieras con la app de IOS.
- [ ] **✨  Y más** Próximamente iremos ampliando el catálogo de modificaciones.

*¿Tienes alguna idea? ¡Abre un Issue y cuéntanosla!*

## 📄 Licencia
Este proyecto está bajo la Licencia MIT.

---
Hecho con ❤️ por R3lease para la comunidad y todos los g4mbl3rs!!
