@echo off
rem Korea Car Marketplace - kompyuterda sinov uchun ishga tushirish.
rem Telefondan: shu Wi-Fi tarmog'ida http://<kompyuter IP>:4320 (masalan http://192.168.1.141:4320)
cd /d C:\Users\usaym\kashkar-ish\korea-car
call npx vite build
start "" http://localhost:4320/
npx vite preview --host --port 4320 --strictPort
