@echo off
rem Starts the local service if necessary and opens the configured local URL.
cd /d "%~dp0"
node bin/open.mjs
