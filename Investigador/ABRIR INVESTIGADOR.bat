@echo off
title Investigador do Passado
cd /d "%~dp0"
"%~dp0..\Robo Grade\node\node.exe" investigador.js
if "%errorlevel%"=="75" exit
pause
