import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
export default defineConfig({
  plugins: [react()],
  define: { "process.env.NODE_ENV": '"production"' },
  build: {
    outDir: resolve(__dirname, "../../outreach/public/marketing/builder-dist"),
    emptyOutDir: true,
    lib: {
      entry: resolve(__dirname, "src/marketing.tsx"),
      name: "DmailioBuilder",
      formats: ["iife"],
      fileName: () => "builder.js",
    },
    cssCodeSplit: false,
    minify: true,
  },
});
