@echo off
curl -s -m 1 -X POST http://127.0.0.1:4317/event -H "Content-Type: application/json" --data-binary @-
exit /b 0
