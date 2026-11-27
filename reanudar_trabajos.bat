@echo off
REM ============================================================================
REM  REANUDAR TODOS LOS TRABAJOS
REM ============================================================================
cd /d "%~dp0"
node tools\runner_control.mjs reanudar
echo.
node tools\runner_control.mjs estado
echo.
echo  Los runners retoman solos en los proximos 20 segundos.
pause
