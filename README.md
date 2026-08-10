<p align="center">
  <img src="extension/icons/nexus-logo.svg" width="128" alt="Nexus logo">
</p>

<h1 align="center">Nexus</h1>

<p align="center">
  A browser extension that reads assignment questions from any webpage, answers them with Gemini AI, and auto-fills the form.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/chrome-MV3-blue" alt="Chrome MV3">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License">
  <img src="https://img.shields.io/badge/tests-8%2F8%20pass-brightgreen" alt="Tests">
</p>

---

## What it does

1. **Scan** — Opens any assignment page and discovers questions (MCQs, checkboxes, text fields, dropdowns)
2. **Answer** — Sends questions to Gemini AI and gets answers with confidence scores
3. **Fill** — Writes answers into the form, reaching React state (not just the DOM)

Works on any website — NPTEL, Swayam, Canvas, Blackboard, Moodle, Google Forms, or custom LMS portals.

## Install

Nexus works on Chrome, Brave, Edge, and Firefox. Chrome, Brave, and Edge all use Chromium, so the same build works for all three. Firefox needs a separate build.

### Chrome / Brave (manual install)

Chrome and Brave both use the Chromium extension format, so the install process is identical.

1. Download or clone this repo:

   ```sh
   git clone https://github.com/your-username/Nptel_solver.git
   ```

2. Open a terminal in the project folder and build:

   ```sh
   node build.js
   ```

   Or skip the build step — the pre-built `dist/chrome/` folder is included.

3. Open your browser's extension page:
   - **Chrome**: go to `chrome://extensions`
   - **Brave**: go to `brave://extensions`

4. Toggle **Developer mode** ON (top right corner).

5. Click **Load unpacked** and select the `dist/chrome/` folder.

6. Nexus appears in your toolbar. Pin it for easy access.

### Firefox

1. Download or clone this repo:

   ```sh
   git clone https://github.com/your-username/Nptel_solver.git
   ```

2. Open a terminal in the project folder and build:

   ```sh
   node build.js
   ```

   Or skip the build step — the pre-built `dist/firefox/` folder is included.

3. Open `about:debugging#/runtime/this-firefox` in Firefox.

4. Click **Load Temporary Add-on** and select any file inside `dist/firefox/` (e.g. `manifest.json`).

5. Nexus appears in your toolbar.

> **Note:** Temporary add-ons are removed when Firefox closes. For a permanent install, publish to [Firefox Add-ons (AMO)](https://addons.mozilla.org).

### Edge

Edge uses the same Chromium extension format as Chrome.

1. Download or clone this repo and run `node build.js` (or use `dist/chrome/` directly).

2. Open `edge://extensions` in Edge.

3. Toggle **Developer mode** ON (left sidebar).

4. Click **Load unpacked** and select the `dist/chrome/` folder.

5. Nexus appears in your toolbar.

### From store (when published)

| Browser | Store | Link |
|---------|-------|------|
| Chrome | Chrome Web Store | [Install](https://chromewebstore.google.com/detail/nexus) _(when available)_ |
| Firefox | Firefox Add-ons | [Install](https://addons.mozilla.org/en-US/firefox/addon/nexus/) _(when available)_ |
| Edge | Edge Add-ons | [Install](https://microsoftedge.microsoft.com/addons/detail/nexus) _(when available)_ |

### Get a Gemini API key

1. Go to [Google AI Studio](https://aistudio.google.com/apikey)
2. Create a free API key
3. Click the Nexus toolbar icon, open Settings (gear icon), and paste the key

## Usage

1. Open any assignment page in your browser
2. Click the **Nexus** icon in your toolbar
3. Hit **Scan page** — Nexus finds all questions
4. Hit **Answer** — Gemini answers them with confidence scores
5. Hit **Fill page** — answers are written into the form
6. Review, then submit yourself

### Modes

- **Solve** — Answers questions and fills the form
- **Hints** — Explains the approach without filling (study mode)

## How it works

Nexus uses heuristic discovery, not hardcoded selectors. It groups radio buttons by their `name` attribute, climbs the DOM to find question text, and falls back to structure detection for unknown layouts. This means it works across different platforms without platform-specific code.

Fills go through React's event system using native prototype setters, so answers persist even after page re-renders.

## Build from source

```sh
git clone https://github.com/your-username/Nptel_solver.git
cd Nptel_solver
npm install
node build.js
```

This outputs:
- `dist/chrome/` — for Chrome, Brave, and Edge
- `dist/firefox/` — for Firefox

## Test

```sh
npm test
```

Runs 8 Playwright tests against local HTML fixtures (React, legacy Course Builder, Swayam layout).

## Project structure

```
extension/          Source files
  manifest.json       MV3 manifest, loaded on demand
  content.js          DOM discovery + fill engine
  gemini.js           Gemini API client
  sidepanel.*         UI (HTML/CSS/JS)
  background.js       Opens side panel on icon click
  icons/              Logo assets
dist/               Built output (generated by build.js)
  chrome/             Chrome / Brave / Edge build
  firefox/            Firefox build
build.js            Build script — generates dist/ from extension/
fixtures/           Offline test pages
test/               Playwright test suite
```

## License

MIT
