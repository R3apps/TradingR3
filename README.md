# 🚀 TradingR3 — Advanced Trading Replay System

**TradingR3** es una alternativa gratuita para ver tus graficos en tiempo real y realizar backtest. Permite simular el movimiento del mercado vela a vela, aplicar indicadores técnicos y gestionar operaciones de forma visual y analítica, todo bajo una interfaz inspirada en los estándares de la industria.

![TradingR3 Preview](https://via.placeholder.com/800x450?text=TradingR3+Dashboard) 

---

## 📥 Instalación y Uso

### 🪟 Para Usuarios de Windows (Recomendado)
Para disfrutar de la mejor experiencia sin complicaciones:
1. Ve a la sección de **[Releases](https://github.com/R3apps/TradingR3/releases)** de este repositorio.
2. Descarga el archivo instalador `TradingR3_Setup.exe`.
3. Ejecútalo y sigue el asistente de instalación (**Siguiente, Siguiente, Instalar**).
4. El programa se instalará automáticamente y creará un acceso directo en tu escritorio.

> **Nota**: Durante la instalación, Windows podría mostrar un aviso de "SmartScreen". Haz clic en "Más información" y "Ejecutar de todas formas" para continuar.

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

## ⚙️ Configuración de OANDA

Para utilizar el backtest con Forex y otros activos premium, es necesario crear una cuenta en OANDA. Sigue estos pasos para evitar las restricciones regionales en Europa:

### 🌍 Creación de Cuenta Demo
Las cuentas de Oanda están limitadas para residentes en Europa. Para habilitar la API, debemos registrarnos como residentes en **Andorra** o fuera de Europa.

1. Accede al registro aquí: **[OANDA Apply](https://www.oanda.com/apply/select)**.
2. Selecciona **"Demo Trading Account"**.
3. En **"Where do you live?"**, selecciona siempre **Andorra**.
4. Rellena tus datos. El teléfono debe llevar el prefijo de tu país real (esto no influye en la restricción).
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

Queremos que TradingR3 sea la herramienta de backtest gratuita más completa. Estas son las funciones que tenemos en el radar:

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
