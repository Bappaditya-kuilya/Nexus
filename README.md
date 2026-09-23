<img src="extension/icons/nexus-logo.svg" width="48" alt="Nexus">

# Nexus

A browser extension that reads assignment questions on the page, explains them with your choice of AI model, and optionally fills the answers. Your API keys, your browser, nothing submitted without you.

**Chrome · Brave · Edge · Firefox** · [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/nexus-solver/)

---

## What it does

Open an assignment page, hit **Scan**. Nexus finds every MCQ, checkbox, text field, and dropdown, then you pick how to use it:

| Mode | What you get | Touches the form? |
|---|---|---|
| **Explain** | Concept and approach per question, opened on demand | No |
| **Solve** | Answers with confidence, optional fill into the fields | Fill only when you click it |
| **Chat** | Ask follow-ups about any question in a sidebar thread | No |

Nothing is ever submitted for you. Review, then hit submit yourself.

Works on any page with standard HTML forms: NPTEL, Swayam, Canvas, Blackboard, Moodle, Google Forms, and custom university portals.

## Install

```sh
git clone https://github.com/Bappaditya-kuilya/Nexus.git
cd Nexus
node build.js
```

**Chrome / Brave / Edge:** `chrome://extensions` → Developer mode on → Load unpacked → `dist/chrome/`

**Firefox (local):** `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → any file in `dist/firefox/`

**Firefox (permanent):** install from [addons.mozilla.org](https://addons.mozilla.org/en-US/firefox/addon/nexus-solver/)

### API keys (bring your own)

Nexus never runs on our servers. You paste your own keys in Settings (gear icon); they stay in `chrome.storage.local` on your machine.

1. **Gemini** — free key from [Google AI Studio](https://aistudio.google.com/apikey)
2. **Groq** (optional fallback) — key from [console.groq.com](https://console.groq.com/keys)

Developers can pre-fill both in a local `.env` (copy `.env.example`) before `node build.js`; end users only ever see the Settings fields.

## Usage

1. Open an assignment page
2. Click **Nexus** → **Scan**
3. Pick a mode: **Explain**, **Solve**, or type into **Chat**
4. In Solve mode: **Answer** shows model output with a confidence bar; **Fill page** writes into the form when you ask it to
5. In Explain mode: click a question, read the approach, answer it yourself

## Test results

Full suite run on 2026-09-23, after the extraction-hardening / dual-provider / chat build:

| Suite | Command | Result |
|---|---|---|
| Page extraction + fill (Playwright) | `npm test` | **12 / 12 pass** |
| Gemini → Groq fallback | `node --test test/groq-fallback.test.mjs` | **4 / 4 pass** |
| Chat endpoint contract | `node --test test/chat.test.mjs` | **4 / 4 pass** |
| Lint | `npx eslint extension/` | **0 errors, 0 warnings** |
| **Total** | | **20 / 20 tests green** |

What those 12 Playwright tests actually assert (not smoke tests):

- **React state, not just DOM.** Fills on the React fixture are checked against React’s internal controlled-component state. A fill that only sets `input.checked` passes a DOM check and then gets reverted on the next render; this suite fails that.
- **Extraction counts and text quality** on 7 layouts: React portal (4 questions), Swayam (5), legacy Course Builder (3), web-component shadow DOM (2), image-only options (3, read from `img[alt]`), SPA route swap (2 before → 2 after mid-test), same-origin iframe (0 on `file://` by browser origin policy, 2 over `http://`).
- **Zero short prompts** across every fixture (`prompt.length < 10` count = 0).
- **Hints mode never mutates.** Same page, same code path: Explain-style payload leaves `input:checked` at 0 → 0 while Solve moves it 0 → 3. Chat replies only render in the sidebar.
- **No submit path.** A dedicated test scans the extension surface and fails if anything clicks a submit control.

## Why it holds up where others break

| Failure mode in typical assignment helpers | Nexus behavior | Where it’s enforced |
|---|---|---|
| Hardcoded selectors (`.qt-mc-question`) die on redesign | Groups radios by `name` (the HTML semantics of a radio group), climbs the DOM for prompt text, structural fallback for unknown layouts | `content.js` discovery tiers 1–4 |
| Misses questions inside widgets | Traverses open shadow roots and same-origin iframes | `allRoots()` / `sameOriginFrames()` |
| Picks up “Question 5 of 10” as the prompt | Rejects nav-like and repeated chrome text before accepting a prompt | `isNavText()` filter |
| Image-only options come back as `""` or the input value `"0"` | Reads `img[alt]` / `img[title]`, else marks the option for manual review | `optionText()` |
| SPA swaps the quiz without a reload; sidebar goes stale | Debounced re-scan on added/removed nodes (400ms, ignores typing) | `MutationObserver` in `content.js` |
| Fill looks fine for a frame, React reverts it | Native prototype setter + `input`/`change` events + `rAF` flush; test asserts React state | `setValue()` / `fillOne()` |
| One provider down, extension dead | Auto-fallback Gemini → Groq on any failure; honest combined error if both fail | `solve()` / `chat()` in `gemini.js` |
| Keys shipped in the repo or sent to a third party | BYOK only: keys live in local extension storage, sent only to the provider you chose | Settings + `chrome.storage.local` |
| Auto-submits graded work | No submit call exists; test fails if one appears | `test/autofill.test.mjs` |

Chat and Solve share extraction and the provider fallback; Explain mode strips option IDs before display and blocks the fill function at its only caller.

## Project structure

```
extension/          Source (load via build output, not directly)
  content.js        Discovery, extraction, fill — no submit
  gemini.js         Gemini + Groq clients, solve() and chat()
  sidepanel.*       UI: scan, modes, chat, settings
  defaults.js       Empty key stub; build fills from .env
  background.js     Opens the side panel
dist/               node build.js output (chrome/ + firefox/)
fixtures/           7 test layouts (React, Swayam, GCB, shadow, iframe, images, SPA)
test/               Playwright suite + provider/chat unit tests
build.js            Copies extension/ → dist/, rewrites Firefox manifest, injects .env keys
.env.example        GEMINI_API_KEY / GROQ_API_KEY template
```

## Development

```sh
npm ci
npx playwright install chromium
npm test
npx eslint extension/
node build.js
```

CI (GitHub Actions) runs the same install → test → lint path on every push and PR to `main`.

## License

MIT
