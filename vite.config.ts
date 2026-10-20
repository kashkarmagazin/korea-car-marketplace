import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages: KC_BASE=/korea-car/ bilan build qilinadi
export default defineConfig({ base: process.env.KC_BASE || "/", plugins: [react()] });
