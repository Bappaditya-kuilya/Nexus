<p align="center">
  <img src="extension/icons/nexus-logo.svg" width="128" alt="Nexus logo">
</p>

<h1 align="center">Nexus</h1>

<p align="center">
  A Chrome extension that reads assignment questions from any webpage, answers them with Gemini AI, and auto-fills the form.
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

### From source (no build step)

1. Download or clone this repo
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked** and select the `extension/` folder
5. Nexus appears in your toolbar

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

## Test

```sh
npm test
```

Runs 8 Playwright tests against local HTML fixtures (React, legacy Course Builder, Swayam layout).

## Project structure

```
extension/
  manifest.json     MV3 manifest, loaded on demand
  content.js        DOM discovery + fill engine
  gemini.js         Gemini API client
  sidepanel.*       UI (HTML/CSS/JS)
  background.js     Opens side panel on icon click
  icons/            Logo assets
fixtures/           Offline test pages
test/               Playwright test suite
```

## License

MIT
