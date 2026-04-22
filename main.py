import webview
import threading
import time
import uvicorn
import os
import sys
import ctypes
import asyncio

import sys

def resource_path(relative_path):
    """ Obtiene la ruta absoluta para recursos, compatible con PyInstaller """
    try:
        # PyInstaller crea una carpeta temporal y guarda la ruta en _MEIPASS
        base_path = sys._MEIPASS
    except Exception:
        base_path = os.path.abspath(".")
    return os.path.join(base_path, relative_path)

# SOLUCIÓN CRÍTICA: Evitar errores ConnectionResetError (WinError 10054) en Windows
if sys.platform == 'win32':
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

# PARCHE PARA PANDAS-TA-CLASSIC EN PYINSTALLER
if getattr(sys, 'frozen', False):
    try:
        import os
        import pandas_ta_classic
        # Forzar la ruta base al directorio _internal del ejecutable
        base_path = os.path.join(sys._MEIPASS, 'pandas_ta_classic')
        if os.path.exists(base_path):
            pandas_ta_classic.PATH = base_path
    except Exception as e:
        # Usamos texto plano para evitar errores de encoding en consolas Windows
        print(f"PyInstaller patch skip: {e}")

class WindowAPI:
    def __init__(self):
        self.window = None
        # Inicializados para evitar AttributeError en el .exe
        self.drag_start_mouse_x = 0
        self.drag_start_mouse_y = 0
        self.drag_start_win_x = 0
        self.drag_start_win_y = 0

    def set_window(self, window):
        self.window = window

    def set_title(self, title):
        if self.window:
            self.window.title = title

    def start_drag_session(self, x, y):
        """Inicia una sesión de arrastre guardando las posiciones iniciales en Python"""
        if self.window:
            self.drag_start_mouse_x = int(x)
            self.drag_start_mouse_y = int(y)
            self.drag_start_win_x = self.window.x
            self.drag_start_win_y = self.window.y

    def drag_to(self, current_x, current_y):
        """Mueve la ventana basándose en el desplazamiento desde el inicio de la sesión"""
        if self.window:
            try:
                dx = int(current_x) - self.drag_start_mouse_x
                dy = int(current_y) - self.drag_start_mouse_y
                self.window.move(self.drag_start_win_x + dx, self.drag_start_win_y + dy)
            except Exception:
                pass

    def minimize(self):
        if self.window:
            try:
                self.window.minimize()
            except Exception:
                pass

    def toggle_maximize(self):
        if self.window:
            try:
                self.window.toggle_fullscreen()
            except Exception:
                pass

    def close(self):
        if self.window:
            try:
                self.window.destroy()
            except Exception:
                pass
        os._exit(0)

    def get_position(self):
        if self.window:
            return [self.window.x, self.window.y]
        return [0, 0]

    def save_csv_dialog(self, content):
        if not self.window:
            return False
        
        try:
            file_types = ('CSV Files (*.csv)', 'All files (*.*)')
            save_path = self.window.create_file_dialog(webview.SAVE_DIALOG, file_types=file_types, save_filename='backtest_results.csv')
            
            if save_path:
                if isinstance(save_path, (list, tuple)):
                    save_path = save_path[0]
                
                with open(save_path, 'w', encoding='utf-8') as f:
                    f.write(content)
                return True
        except Exception as e:
            print(f"Error saving CSV: {e}")
        return False

from backend.websocket_server import app as fastapi_app

def start_server():
    """
    Starts the FastAPI server in a dedicated thread.
    """
    config = uvicorn.Config(fastapi_app, host="127.0.0.1", port=8765, log_level="error")
    server = uvicorn.Server(config)
    server.run()

# ==================== CONFIGURACIÓN DE IDENTIDAD Y ICONO ====================
ICON_PATH = resource_path("TradingR3.ico")

if sys.platform == 'win32':
    try:
        import clr
        clr.AddReference('System.Windows.Forms')
        clr.AddReference('System.Drawing')
    except:
        pass

def setup_app_identity():
    """Obliga a Windows a tratar este proceso como una App única y no como Python"""
    if sys.platform == "win32":
        try:
            # ID único para evitar que se agrupe con el icono de Python
            myappid = 'TradingR3.TradingView.Clone.v1.0'
            ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(myappid)
        except:
            pass

def force_icon_aggressive(window):
    """Inyecta el icono directamente en el handle de Windows (HWND)"""
    if not os.path.exists(ICON_PATH):
        print(f"❌ Icono no encontrado: {ICON_PATH}")
        return

    # Esperamos un momento para asegurar que el HWND esté registrado en el OS
    time.sleep(1.0) 

    if sys.platform == "win32":
        try:
            # En v4.4.1 window.set_icon no existe, saltamos directo al refuerzo
            # 2. Hack Directo a Win32 API vía ctypes (Sin necesidad de pywin32)
            hwnd = None
            if hasattr(window, 'gui') and hasattr(window.gui, 'form'):
                hwnd = window.gui.form.Handle.ToInt64()
            
            if not hwnd:
                # Fallback: buscar por título si el acceso al objeto falla
                hwnd = ctypes.windll.user32.FindWindowW(None, window.title)

            if hwnd:
                # Cargar el handle del icono real (.ico)
                # IMAGE_ICON = 1, LR_LOADFROMFILE = 0x10
                hicon = ctypes.windll.user32.LoadImageW(0, ICON_PATH, 1, 0, 0, 0x00000010)
                
                if hicon:
                    # WM_SETICON = 0x80, ICON_SMALL = 0, ICON_BIG = 1
                    ctypes.windll.user32.SendMessageW(hwnd, 0x0080, 0, hicon) # Icono pequeño
                    ctypes.windll.user32.SendMessageW(hwnd, 0x0080, 1, hicon) # Icono grande (Taskbar)
                    
                    # REFUERZO EXTREMO: Cambiar el icono en la CLASE de la ventana (GCLP_HICON = -14, GCLP_HICONSM = -34)
                    ctypes.windll.user32.SetClassLongPtrW(hwnd, -14, hicon)
                    ctypes.windll.user32.SetClassLongPtrW(hwnd, -34, hicon)

                    # Forzar actualización de la ventana
                    ctypes.windll.user32.UpdateWindow(hwnd)
                    print("✅ Icono inyectado exitosamente (Instancia + Clase).")
        except Exception as e:
            print(f"⚠️ Error al forzar icono: {e}")

# ====================== BLOQUE PRINCIPAL ======================

if __name__ == "__main__":
    # Importante: Identidad de proceso antes que nada
    setup_app_identity()
    
    # Start the local WebSocket server in a background thread
    server_thread = threading.Thread(target=start_server, daemon=True)
    server_thread.start()
    
    # Wait for server to initialize
    time.sleep(2) 


    api = WindowAPI()
    
    window = webview.create_window(
        title="TradingR3",
        url="http://127.0.0.1:8765/frontend/index.html",
        width=1440,
        height=900,
        min_size=(1024, 650),
        resizable=True,
        background_color="#131722",
        frameless=True,
        easy_drag=False,
        js_api=api
    )

    def on_init(window):
        # CRÍTICO: set_window PRIMERO para que la API esté disponible de inmediato
        api.set_window(window)
        # Icono en hilo separado para no bloquear la UI
        threading.Thread(target=force_icon_aggressive, args=(window,), daemon=True).start()

    # Debug solo en desarrollo, desactivado automáticamente en el .exe
    is_debug = not getattr(sys, 'frozen', False)
    webview.start(on_init, window, debug=is_debug)
