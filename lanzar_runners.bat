@echo off
REM ============================================================================
REM  LANZAR LOS 4 RUNNERS (uno por sede) — trabajan la cola atrasada de vTiger
REM ============================================================================
REM  Cada sede escribe su propio avance en scratch\runner_n2_<SEDE>.json
REM  Para PAUSAR o REANUDAR usa:  pausar_trabajos.bat  /  reanudar_trabajos.bat
REM ============================================================================

cd /d "%~dp0"
if not exist "logs" mkdir "logs"
echo [%date% %time%] LANZANDO runners >> "logs\runner_n2.log"

start "" /b node tools\runner_n2.mjs --solo=PALACIOS  --limite=40 --rate=6 --concurrencia=4 >> "logs\runner_n2_PALACIOS.log" 2>&1
start "" /b node tools\runner_n2.mjs --solo=BENAVIDES --limite=40 --rate=6 --concurrencia=4 >> "logs\runner_n2_BENAVIDES.log" 2>&1
start "" /b node tools\runner_n2.mjs --solo=ROOSEVELT --tipo=contactos --limite=40 --rate=6 --concurrencia=4 >> "logs\runner_n2_ROOSEVELT.log" 2>&1
start "" /b node tools\runner_n2.mjs --solo=PIURA     --tipo=contactos --limite=40 --rate=6 --concurrencia=4 >> "logs\runner_n2_PIURA.log" 2>&1

echo.
echo  4 runners lanzados (Palacios, Benavides, Roosevelt, Piura).
echo  Progreso:  node tools\runner_control.mjs estado
echo  Pausar:    pausar_trabajos.bat
echo.
pause
