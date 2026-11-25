import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Edition to build: VITE_EDITION, else the hosted edition when its folder ships, else SolarOS (whose package ships only its own).
const src = (p: string) => fileURLToPath(new URL(`./src/${p}`, import.meta.url));
const present = readdirSync(src("editions")).filter((d) => existsSync(src(`editions/${d}/edition.tsx`)));
const edition = process.env.VITE_EDITION || present.find((d) => d !== "solaros") || "solaros";
if (!existsSync(src(`editions/${edition}/edition.tsx`))) throw new Error(`VITE_EDITION=${edition}: src/editions/${edition} not found`);
const page: { title: string; icon: string; brands: string[] } = JSON.parse(readFileSync(src(`editions/${edition}/page.json`), "utf8"));

/** index.html is edition-neutral: the edition's page.json supplies the tab title and icon, and which public/brand logos ship. */
const editionPage = (): Plugin => ({
  name: "edition-page",
  transformIndexHtml: { order: "pre", handler: (html) => html.replace("%EDITION_TITLE%", page.title).replace("%EDITION_ICON%", page.icon) },
  writeBundle(opts) {
    const dir = join(opts.dir ?? "dist", "brand");
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir)) if (!page.brands.some((b) => f.startsWith(`${b}-`))) rmSync(join(dir, f));
  },
});

export default defineConfig({
  plugins: [react(), tailwindcss(), editionPage()],
  resolve: { alias: { "@edition": src(`editions/${edition}/edition`) } },
  server: { proxy: { "/api": "http://127.0.0.1:8000" } },
});
