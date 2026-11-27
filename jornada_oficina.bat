@echo off
REM ============================================================================
REM  JORNADA: OFICINA (07:00 - 22:00)
REM  Los trabajos de N2 van LENTOS para no quitarle cuota al N1 (redes).
REM ============================================================================
cd /d "%~dp0"
node tools\jornada.mjs oficina
echo.
echo  A partir de ahora los runners usan: 1200 ms entre tandas y 2 en paralelo.
echo  El N1 (atencion de redes en GHL) queda con la mayor parte de la cuota.
pause
