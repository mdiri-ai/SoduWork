@echo off
setlocal
cd /d "%~dp0"
if defined SODUWORK_PYTHON goto run_explicit

set "SODUWORK_START_PY="
where py >nul 2>nul
if errorlevel 1 goto try_python312
py -3.12 --version >nul 2>nul
if not errorlevel 1 set "SODUWORK_START_PY=py -3.12"
if defined SODUWORK_START_PY goto run
py -3.13 --version >nul 2>nul
if not errorlevel 1 set "SODUWORK_START_PY=py -3.13"
if defined SODUWORK_START_PY goto run
py -3 --version >nul 2>nul
if not errorlevel 1 set "SODUWORK_START_PY=py -3"
if defined SODUWORK_START_PY goto run

:try_python312
where python3.12 >nul 2>nul
if errorlevel 1 goto try_python
set "SODUWORK_START_PY=python3.12"
goto run

:try_python
where python >nul 2>nul
if errorlevel 1 goto missing
set "SODUWORK_START_PY=python"
goto run

rem An explicit interpreter wins, so uv or conda users can pin the 3.12+ they installed.
rem The echo line makes a silent fallback to another minor version visible.
:run
echo Python interpreter: %SODUWORK_START_PY%
%SODUWORK_START_PY% start.py %*
goto finished

:run_explicit
echo Python interpreter: %SODUWORK_PYTHON% (SODUWORK_PYTHON)
"%SODUWORK_PYTHON%" start.py %*
goto finished

:missing
echo Install Python 3.12 or newer from https://www.python.org/downloads/
echo Enable "Add Python to PATH", then run this file again.
echo If Python 3.12+ is installed but not found, set SODUWORK_PYTHON to its full path.
cmd /c exit 1

:finished
set "SODUWORK_START_EXIT=%errorlevel%"
if "%SODUWORK_START_EXIT%"=="0" goto done
if "%SODUWORK_NO_PAUSE%"=="1" goto done
:check_pause
if [%1]==[] goto pause_on_error
if "%~1"=="--password-stdin" goto done
shift
goto check_pause
:pause_on_error
pause
:done
exit /b %SODUWORK_START_EXIT%
