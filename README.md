# NPTEL Assignment Assistant

Reads the questions off an NPTEL/Swayam assignment page, answers them with **your own**
Gemini API key, and fills the answers into the form. It never clicks Submit.

Everything stays client-side: the key lives in `chrome.storage.local` and requests go
straight from the side panel to Google.

## Why this isn't just the existing extensions

NPTEL moved to a Next.js/React portal — `/noc25_cs01/unit?...` now redirects to
`/e-learning/course/noc25_cs01?unitId=...`. The Google Course Builder selectors that
every existing NPTEL solver hardcodes (`.qt-mc-question`, `.gcb-mcq-choice`,
`#submitbutton`) no longer exist, so those extensions find nothing to fill.

Two things here are different:

- **Discovery is heuristic, not selector-pinned.** Radios group by their `name`
  attribute — that's what makes them a radio group in the first place — so one code
  path covers both the React portal and legacy Course Builder pages. There's a
  regression fixture for each.
- **Fills go through React.** Setting `.value` directly doesn't reach React state;
  it re-renders and throws the answer away. Choices go through `.click()` on the
  input, and text goes through the prototype's native value setter to defeat React's
  `_valueTracker`. Every fill is verified afterwards, retried once, and reported if
  it still didn't take.

## Install

No build step — the extension loads as-is.

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select the `extension/` folder
3. Get a key from [Google AI Studio](https://aistudio.google.com/apikey), open the
   side panel (click the toolbar icon), and paste it into Settings

To try it on the offline fixtures, also switch on **Allow access to file URLs** on the
extension's details page.

## Use

Open an assignment, then in the side panel:

- **Scan page** — waits for React to finish rendering, then lists what it found
- **Answer** — one Gemini call for all questions, with per-question confidence and reasoning
- **Fill page** (or per-question **Fill this**) — writes the answers into the form

**Mode** toggles between *Solve* (answer outright) and *Hints* (explain the approach;
no fill buttons).

Submitting is always yours to do. Check the low-confidence ones first.

## Test

```sh
npm test
```

Drives the real content script in real Chromium against `fixtures/`. The load-bearing
test is `fills reach React state, not just the DOM` — the React fixture uses controlled
inputs, so it asserts against React state rather than `input.checked`. A fill that only
mutates the DOM passes a DOM assertion and still loses the student's answer; this one
fails, as verified by breaking the setter on purpose.

`fixtures/react-portal.html` pulls React from unpkg, so that test needs network once.

## Checking it on the live site

The portal is behind SSO, so this part is yours:

1. Log in and open a real assignment
2. **Scan page** — the question count should match what you see
3. **Answer**, then **Fill page**
4. Confirm the selections landed on the right options
5. **Navigate away and back.** If the answers survived, they reached React state rather
   than just the DOM — this is the check that matters
6. Nothing should have been submitted

If a question reports "not filled", the page shape is one the heuristic missed — the
question prompt and page URL are enough to fix it.

## Layout

```
extension/
  manifest.json    MV3; injected on demand, no declarative content script
  content.js       discovery + applicator + image capture (one file: content scripts can't be modules)
  gemini.js        one API call, JSON schema response
  sidepanel.*      UI
  background.js    opens the panel on icon click; that's all
fixtures/          offline test pages, React and legacy
test/              Playwright suite
```

## Not built yet

Parts two and three of the suite — the Swayam/NPTEL course-notice reminder (FastAPI +
CLI) and the website (Next.js dashboard with email-OTP sign-in). Neither NPTEL nor
Swayam exposes a public JSON API, so both will scrape `swayam.gov.in/search_courses`
and `onlinecourses.nptel.ac.in/<code>/announcements`.

## Caveat

Gemini is confidently wrong sometimes. Confidence is shown per question, nothing is
submitted for you, and Hints mode exists so this can work as a study aid rather than a
black box.
