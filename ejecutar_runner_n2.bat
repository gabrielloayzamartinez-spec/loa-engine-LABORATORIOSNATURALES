@echo off
REM ============================================================================
REM  RUNNER N2 — sincroniza la cola atrasada de vTiger -> GHL en ESTA máquina
REM ============================================================================
REM  Qué hace: recorre compradores y contactos (2026 -> 2019) de cada sede
REM  configurada en .env y re-publica cada ficha con TODOS sus CF.
REM  Es reanudable: si lo cierras, al volver a abrirlo continúa donde quedó.
REM
REM  Uso: doble clic, o desde consola:  ejecutar_runner_n2.bat
REM ============================================================================

cd /d "%~dp0"

if not exist "logs" mkdir "logs"

echo [%date% %time%] RUNNER N2 iniciado >> "logs\runner_n2.log"

REM  --limite 40 : fichas por página
REM  --rate 6    : pausa entre tandas (más alto = más rápido)
REM  --concurrencia 4 : fichas en paralelo (sube el caudal)
start "" /b node tools\runner_n2.mjs --limite=40 --rate=6 --concurrencia=4 >> "logs\runner_n2.log" 2>&1

echo.
echo  Runner N2 lanzado en segundo plano.
echo  Progreso:  type scratch\runner_n2.json
echo  Registro:  type logs\runner_n2.log
echo.
echo  Para DETENERLO: cierra la ventana de Node en el Administrador de tareas
echo  (proceso "Node.js JavaScript Runtime") o usa:  taskkill /IM node.exe /F
echo.
pause
