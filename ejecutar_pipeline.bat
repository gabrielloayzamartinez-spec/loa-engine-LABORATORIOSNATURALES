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
echo   [6] Peinado Correctivo de Tratamientos (Sanar Artritis vs Potencia/Diabetes)
echo   [7] Peinado de Notas y Doble Ingreso (Ficha Limpia + Multisede + Multiproducto)
echo   [8] Subir a GitHub (git push a loa-engine-LABORATORIOSNATURALES)
echo   [9] Salir
echo.
=======================================================================
set /p OPCION="Elige una opción (1-9): "

if "%OPCION%"=="1" goto SERVIDOR
if "%OPCION%"=="2" goto BARRIDO_UNREAD
if "%OPCION%"=="3" goto BARRIDO_MASIVO
if "%OPCION%"=="4" goto DASHBOARD
if "%OPCION%"=="5" goto CLI
if "%OPCION%"=="6" goto PEINADO
if "%OPCION%"=="7" goto PEINADO_NOTAS
if "%OPCION%"=="8" goto SUBIR_GITHUB
if "%OPCION%"=="9" goto SALIR

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

:PEINADO
cls
echo =======================================================================
echo   🧹 PEINADO CORRECTIVO: TRATAMIENTOS Y FUENTES VTIGER...
echo   • Audita contactos para remover falsos positivos de Artritis
echo   • Corrige a Potencia, Diabetes, Próstata, Visión según chat real
echo   • Actualiza etiquetas y campos personalizados en GHL
echo =======================================================================
echo.
set /p LIMIT="¿Cuántos contactos recientes deseas auditar? (ej. 100): "
if "%LIMIT%"=="" set LIMIT=100
node src/scripts/peinado_correctivo_productos.js %LIMIT%
echo.
echo =======================================================================
echo Peinado correctivo finalizado.
echo =======================================================================
pause
goto MENU

:PEINADO_NOTAS
cls
echo =======================================================================
echo   🧹 PEINADO DE NOTAS Y DOBLE INGRESO (FICHA LIMPIA EJECUTIVA)...
echo   • Sustituye notas de auditoría por Ficha Limpia de Ingreso
echo   • Clasifica Doble Ingreso: Multiproducto, Multisede, Reactivación > 7d
echo   • Detecta estatus comercial (Comprador vTiger, Prospecto, Curioso)
echo   • Control de cuotas Token Bucket Queue y Blindaje de 15 min activo
echo =======================================================================
echo.
set /p LIMIT_NOTAS="¿Cuántos contactos recientes deseas procesar? (ej. 100): "
if "%LIMIT_NOTAS%"=="" set LIMIT_NOTAS=100
node src/scripts/peinar_notas_doble_ingreso.js %LIMIT_NOTAS%
echo.
echo =======================================================================
echo Peinado de notas y doble ingreso finalizado con éxito.
echo =======================================================================
pause
goto MENU

:SUBIR_GITHUB
cls
echo =======================================================================
echo   🚀 SUBIENDO LOA ENGINE A GITHUB (Laboratorios Naturales)
echo =======================================================================
echo.
echo Repositorio: https://github.com/gabrielloayzamartinez-spec/loa-engine-LABORATORIOSNATURALES.git
echo.
echo Subiendo ramas y archivos...
git push -u origin main
echo.
echo =======================================================================
if %ERRORLEVEL% EQU 0 (
    echo   ✅ ¡SUBIDA EXITOSA A GITHUB!
    echo   Todos los archivos ya están listos en tu repositorio de GitHub.
) else (
    echo   ⚠️ Hubo un detalle al subir. Revisa tu inicio de sesión de GitHub.
)
echo =======================================================================
pause
goto MENU

:SALIR
cls
echo.
echo ¡Hasta luego! Todo tu sistema queda guardado y listo para usar.
echo.
exit
