@echo off
REM ============================================================================
REM  JORNADA: NOCHE (23:00 - 06:00)
REM  N2 a FULL PERFORMANCE: no hay chats que atender, la cuota queda libre.
REM ============================================================================
cd /d "%~dp0"
node tools\jornada.mjs noche
echo.
echo  A partir de ahora los runners usan: 40 ms entre tandas y 6 en paralelo.
echo  Es el momento de avanzar la sincronizacion historica.
pause
