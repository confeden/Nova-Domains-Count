// d:\Desktop\Scripts\Chrome\domain-analyzer\vite.config.ts

/// <reference types="node" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { crx, defineManifest } from '@crxjs/vite-plugin'

const manifest = defineManifest({
    manifest_version: 3,
    name: "Nova Domains Count",
    version: "1.0.0",
    action: {
        default_popup: "index.html",
        default_icon: "icon.png"
    },
    icons: {
        "16": "icon.png",
        "48": "icon.png",
        "128": "icon.png"
    },
    permissions: ["activeTab", "scripting", "tabs"],
    content_scripts: [
        {
            matches: ["<all_urls>"],
            js: ["src/content.ts"],
            run_at: "document_start"
        },
        {
            matches: ["<all_urls>"],
            js: ["src/inject.ts"],
            world: "MAIN",
            run_at: "document_start"
        }
    ]
})

export default defineConfig({
    plugins: [react(), crx({ manifest })],
})
