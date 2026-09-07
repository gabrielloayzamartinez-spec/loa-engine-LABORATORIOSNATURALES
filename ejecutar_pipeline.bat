@echo off
chcp 65001 > nul
title 🎯 GHL Unified Master Engine & Radar Multi-Touch
color 0B

:MENU
cls
echo =======================================================================
echo          🎯 LOA ENGINE: 3 WORKERS CONCURRENTES (ESTADOS UNIDOS)
echo                  Laboratorios Naturales - Gabriel Loayza
echo =======================================================================
echo.
echo   [1] Iniciar Servidor 24/7 (Worker 1: Tráfico en Vivo + Webhooks + Dashboard)
echo   [2] Barrido Prioritario de Bandejas (Worker 2: De Hoy hacia Atrás, 300ms)
echo   [3] Auditoría Masiva Completa (Worker 3: Todo GHL + Reporte CSV)
echo   [4] Abrir Dashboard en el Navegador (http://localhost:3000/health)
echo   [5] Panel Interactivo CLI
echo   [6] Salir
echo.
echo =======================================================================
set /p OPCION="Elige una opción (1-6): "

if "%OPCION%"=="1" goto SERVIDOR
if "%OPCION%"=="2" goto BARRIDO_UNREAD
if "%OPCION%"=="3" goto BARRIDO_MASIVO
if "%OPCION%"=="4" goto DASHBOARD
if "%OPCION%"=="5" goto CLI
if "%OPCION%"=="6" goto SALIR

echo.
echo Opción inválida. Intenta nuevamente...
timeout /t 2 > nul
goto MENU

:SERVIDOR
cls
echo =======================================================================
echo   🚀 INICIANDO SERVIDOR 24/7 (WORKER 1: EN VIVO + DASHBOARD)...
echo =======================================================================
echo.
echo Para abrir el Dashboard ingresa en tu navegador a:
echo http://localhost:3000/health
echo.
echo Presiona Ctrl + C en cualquier momento si deseas detener el servidor.
echo.
node src/server.js
pause
goto MENU

:BARRIDO_UNREAD
cls
echo =======================================================================
echo   🛡️ WORKER 2: BARRIDO PRIORITARIO DE BANDEJAS NO LEÍDAS...
echo   • Recorre de hoy hacia atrás los chats vivos de los 6 asesores
echo   • Rate-Limit Shield activado (~3 req/seg, pausa 300ms)
echo =======================================================================
echo.
node src/agents/master_batch_runner.js --unread
echo.
echo =======================================================================
echo Barrido prioritario finalizado con éxito.
echo =======================================================================
pause
goto MENU

:BARRIDO_MASIVO
cls
echo =======================================================================
echo   🎯 WORKER 3: AUDITORÍA Y BARRIDO MASIVO DE TODA LA BASE...
echo =======================================================================
echo.
node src/agents/master_batch_runner.js
echo.
echo =======================================================================
echo Proceso masivo finalizado. El reporte CSV ha sido generado en la carpeta.
echo =======================================================================
pause
goto MENU

:CLI
cls
node src/cli.js
goto MENU

:DASHBOARD
cls
echo Abriendo Dashboard en tu navegador predeterminado...
start http://localhost:3000/health
goto MENU

:SALIR
cls
echo.
echo ¡Hasta luego! Todo tu sistema queda guardado y listo para usar.
echo.
exit
