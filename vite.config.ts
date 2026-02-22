// d:\Desktop\Scripts\Chrome\domain-analyzer\vite.config.ts

/// <reference types="node" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { crx, defineManifest } from '@crxjs/vite-plugin'

const manifest = defineManifest({
    manifest_version: 3,
    name: "Nova Domains Count",
    version: "1.1.0",
    action: {
        default_popup: "index.html",
        default_icon: "icon.png"
    },
    icons: {
        "16": "icon.png",
        "48": "icon.png",
        "128": "icon.png"
    },
    permissions: ["activeTab", "tabs", "webRequest"],
    host_permissions: ["<all_urls>"],
    background: {
        service_worker: "src/background.ts",
        type: "module"
    }
})

export default defineConfig({
    plugins: [react(), crx({ manifest })],
})
