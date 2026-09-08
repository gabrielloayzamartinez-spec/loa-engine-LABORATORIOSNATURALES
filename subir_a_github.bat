@echo off
chcp 65001 > nul
title 🚀 Subir LOA Engine a GitHub
color 0A
echo =======================================================================
echo          🚀 SUBIENDO LOA ENGINE A GITHUB (Laboratorios Naturales)
echo =======================================================================
echo.
echo Repositorio destino:
echo https://github.com/gabrielloayzamartinez-spec/loa-engine-LABORATORIOSNATURALES.git
echo.
echo Subiendo ramas y archivos...
git push -u origin main
echo.
echo =======================================================================
if %ERRORLEVEL% EQU 0 (
    echo   ✅ ¡SUBIDA EXITOSA A GITHUB!
    echo   Todos los archivos ya están listos en tu repositorio de GitHub.
    echo   Ahora puedes ir a Render.com para conectarlo.
) else (
    echo   ⚠️ Hubo un detalle al subir. Revisa tu inicio de sesión de GitHub.
)
echo =======================================================================
echo.
pause
