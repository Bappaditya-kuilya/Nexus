<img src="extension/icons/nexus-logo.svg" width="48" alt="Nexus">

# Nexus

A browser extension that scans assignment pages, answers questions with Gemini, and fills them in for you.

**Chrome** · **Brave** · **Edge** · **Firefox**

---

## What is this?

You open an assignment. Nexus reads every question — MCQs, checkboxes, text fields, dropdowns — sends them to Gemini using *your own* API key, and fills the answers into the form. It never submits anything. You review, then hit submit yourself.

Works on any site with standard HTML forms: NPTEL, Swayam, Canvas, Blackboard, Moodle, Google Forms, or whatever your university cooked up.

Two modes:
- **Solve** — answers and fills
- **Hints** — explains the approach, no filling (for when you actually want to learn)

## Install

### The quick version

```sh
git clone https://github.com/Bappaditya-kuilya/Nexus.git
cd Nexus
node build.js
```

Then load `dist/chrome/` (or `dist/firefox/`) as an unpacked extension in your browser.

### Chrome / Brave / Edge

All three are Chromium. Same steps for all.

1. Go to `chrome://extensions` (or `brave://extensions` or `edge://extensions`)
2. Turn on **Developer mode**
3. Click **Load unpacked** → select `dist/chrome/`
4. Pin the extension to your toolbar

### Firefox

1. Go to `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on** → pick any file in `dist/firefox/`

Heads up: temporary add-ons disappear when Firefox closes. For a permanent install, it's on [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/nexus/) (submitting now).

### API key

You need a free Gemini API key. Takes 30 seconds.

1. Go to [Google AI Studio](https://aistudio.google.com/apikey)
2. Create a key
3. Click the Nexus icon → gear icon → paste it in

## Usage

1. Open an assignment page
2. Click **Nexus** in your toolbar
3. **Scan page** — finds all questions
4. **Answer** — Gemini answers them (shows confidence per question)
5. **Fill page** — writes answers into the form
6. Check the low-confidence ones, then submit

## How it works (if you're curious)

Most NPTEL extensions break because they hardcode CSS selectors like `.qt-mc-question`. When the site redesigns, they're dead.

Nexus doesn't do that. It groups radio buttons by their `name` attribute (that's literally what makes them a radio group), climbs the DOM to find question text, and falls back to structure detection for unknown layouts. One code path handles React portals, legacy Course Builder pages, and anything else with standard HTML forms.

The fill is the tricky part. Setting `input.checked = true` directly doesn't work on React apps — React keeps a tracker on the node and reverts your change on the next render. Nexus goes through the native prototype setter and dispatches proper events so React actually picks it up.

No build step. No bundler. Plain JS, HTML, CSS. Loads straight from disk.

## Project structure

```
extension/          The extension (load this in your browser)
  content.js        Finds questions, fills answers
  gemini.js         One Gemini API call, structured JSON response
  sidepanel.*       The UI
  background.js     Opens the sidebar (3 lines)
  icons/            Logo
dist/               Built output (node build.js)
  chrome/           Chrome, Brave, Edge
  firefox/          Firefox
build.js            Generates dist/ from extension/
fixtures/           Test HTML pages
test/               Playwright tests
```

## Test

```sh
npm test
```

8 tests. The important one: fills reach React state, not just the DOM. A fill that only mutates the DOM looks fine for a frame and then React reverts it. The test asserts against React's internal state to catch exactly that.

## License

MIT
