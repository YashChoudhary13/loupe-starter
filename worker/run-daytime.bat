@echo off
rem Daytime: answer Identify within seconds and keep originals syncing. Run at logon (Task Scheduler) or by hand.
cd /d %~dp0
call .venv\Scripts\activate.bat
loupe-worker run --kinds sync,identify --daemon --poll 3
