@echo off
rem Nightly (02:00, Task Scheduler): sync anything new, embed everything waiting, stop when the queue is empty.
cd /d %~dp0
call .venv\Scripts\activate.bat
loupe-worker run --kinds sync,embed --until-empty >> logs\nightly-%date:~-4,4%%date:~-7,2%%date:~-10,2%.log 2>&1
