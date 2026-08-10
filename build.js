#!/usr/bin/env node
/**
 * Cross-browser build: copies extension/ into dist/chrome/ and dist/firefox/.
 *
 * Chrome: files as-is.
 * Firefox: manifest rewritten for sidebar_action + gecko settings,
 *          background.js and sidepanel.js patched with a browser API polyfill.
 *
 * Usage: node build.js
 */
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = join(__dirname, "extension");
const dist = join(__dirname, "dist");
const chromeDir = join(dist, "chrome");
const firefoxDir = join(dist, "firefox");

// ---- clean + copy both builds as-is first ---------------------------

rmrf(chromeDir);
rmrf(firefoxDir);
mkdirSync(chromeDir, { recursive: true });
mkdirSync(firefoxDir, { recursive: true });

cpSync(src, chromeDir, { recursive: true });
cpSync(src, firefoxDir, { recursive: true });

// ---- Firefox manifest.json ------------------------------------------

const manifest = JSON.parse(readFileSync(join(firefoxDir, "manifest.json"), "utf8"));

// Remove side_panel, add sidebar_action
delete manifest.side_panel;
manifest.sidebar_action = {
  default_title: "Nexus",
  default_panel: "sidepanel.html",
  default_icon: "icons/icon-48.png",
  browser_style: false,
};

// Drop "sidePanel" from permissions (Firefox doesn't know it)
manifest.permissions = manifest.permissions.filter((p) => p !== "sidePanel");

// Background: Firefox MV3 uses scripts only, no service_worker
manifest.background = {
  scripts: ["background.js"],
};

// Gecko-specific settings
manifest.browser_specific_settings = {
  gecko: {
    id: "nexus@assignment-solver",
    strict_min_version: "109.0",
    data_collection_permissions: {
      isExempt: true,
      description: "Nexus only sends assignment questions to the user's own Gemini API key. No data is collected by the extension.",
    },
  },
};

// Action button (keep it; Firefox shows it in the toolbar)
manifest.action = manifest.action || { default_title: "Open assignment assistant" };

writeFileSync(join(firefoxDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

// ---- Firefox JS patches: browser API polyfill -----------------------

const API_POLYFILL =
  '// browser API polyfill — Firefox uses browser.*, Chrome uses chrome.*\n' +
  "const api = typeof browser !== 'undefined' ? browser : chrome;\n\n";

// background.js: replace chrome.sidePanel calls with sidebarAction
const bgSrc = readFileSync(join(firefoxDir, "background.js"), "utf8");
const bgPatched =
  API_POLYFILL +
  bgSrc
    .replace(/chrome\.sidePanel\.setPanelBehavior\(\{.*\}\)\.catch\(\(\) => \{\}\);?/, () =>
      // Firefox: open sidebar on action click is the default behaviour,
      // but we can explicitly open it to match Chrome's UX.
      "api.sidebarAction.open().catch(() => {});"
    )
    .replace(/chrome\./g, "api.");
writeFileSync(join(firefoxDir, "background.js"), bgPatched);

// sidepanel.js: replace chrome.* with api.*
const spSrc = readFileSync(join(firefoxDir, "sidepanel.js"), "utf8");
const spPatched = API_POLYFILL + spSrc.replace(/chrome\./g, "api.");
writeFileSync(join(firefoxDir, "sidepanel.js"), spPatched);

// ---- Done -----------------------------------------------------------

console.log("Built dist/chrome/   (Chrome MV3)");
console.log("Built dist/firefox/  (Firefox MV3)");
console.log("");
console.log("Chrome:  load dist/chrome/   via chrome://extensions (Developer mode)");
console.log("Firefox: load dist/firefox/  via about:debugging#/runtime/this-firefox");

// ---- helpers --------------------------------------------------------

function rmrf(p) {
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {
    // best effort
  }
}
