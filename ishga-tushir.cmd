@echo off
rem Korea Car Marketplace — kompyuterda ishga tushirish (telefon: shu Wi-Fi da http://<kompyuter IP>:4320)
cd /d C:\Users\usaym\kashkar-ish\korea-car
call npx vite build
start "" http://localhost:4320/
npx vite preview --host --port 4320 --strictPort
