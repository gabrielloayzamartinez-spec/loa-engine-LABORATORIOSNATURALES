@echo off
REM ============================================================================
REM  PAUSAR TODOS LOS TRABAJOS  (almuerzo, salida, lo que sea)
REM ============================================================================
REM  Los runners quedan vivos pero SIN gastar cuota. Se reanudan con
REM  reanudar_trabajos.bat o solos cuando vence el tiempo indicado.
REM ============================================================================

cd /d "%~dp0"
set /p MINUTOS=  Cuantos minutos pausar? (Enter = indefinido): 
set /p MOTIVO=  Motivo (ej. almuerzo): 

if "%MINUTOS%"=="" (
  node tools\runner_control.mjs pausar --motivo="%MOTIVO%"
) else (
  node tools\runner_control.mjs pausar --motivo="%MOTIVO%" --minutos=%MINUTOS%
)

echo.
node tools\runner_control.mjs estado
pause
