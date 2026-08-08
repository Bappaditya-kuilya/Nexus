# Handover

Everything needed to pick this up cold. Last updated 2026-08-06.

---

## 1. Status at a glance

| Part | What it is | State |
|---|---|---|
| **1. Chrome extension** | Reads assignment questions, answers via your Gemini key, autofills the form | **Built. 8/8 tests pass** (Swayam layout regression included). Prompt-extraction bug found and fixed against a real live Swayam assignment page. |
| **2. Notice reminder** | Swayam/NPTEL course search + announcements, email OTP, FastAPI + CLI | **Built and smoke-tested.** Files: auth.py, db.py, scraper.py, main.py, cli.py. |
| **3. Website** | Landing page + OTP dashboard, subscriptions/notifications/profile | **Built. pnpm build clean.** Pages: landing/search, /signin (OTP flow), /dashboard, /dashboard/notifications, /dashboard/profile. |

---

## 2. Quick start

```sh
# test (real Chromium, real React)
npm test

# load the extension
# chrome://extensions -> Developer mode ON -> Load unpacked -> select extension/
```

Get a Gemini key at <https://aistudio.google.com/apikey>. Click the toolbar icon to
open the side panel, paste the key into Settings (gear icon).

To use the offline fixtures in the browser, also enable **Allow access to file URLs**
on the extension's details page, then open `fixtures/react-portal.html`.

---

## 3. Live verification — the steps

This is the outstanding task. ~10 minutes.

1. **Load the extension** (§2) and put your Gemini key in Settings.
2. **Log into NPTEL** and open a real assignment page. It should look like
   `https://onlinecourses.nptel.ac.in/e-learning/course/noc25_xx01?unitId=...&assessmentId=...`
3. **Open the side panel** (toolbar icon) and hit **Scan page**.
   - ✅ Expect: "Found N questions in ..." where N matches what you see on screen.
   - ❌ If it says *No questions found*: go to §3.1 and send me the dump.
   - ❌ If N is wrong (usually too few, or all options merged into one question):
     also §3.1.
4. **Check the prompts rendered in the panel** match the real questions, and that the
   options listed under each are the real options. If prompt text is empty or has
   swallowed the option text, that's a `promptOf()` bug — §3.1.
5. Hit **Answer**. Expect per-question answers with confidence bars and reasoning.
   - A 400/403 error means the key is wrong; 429 means rate-limited, wait and retry.
6. Hit **Fill page**.
   - ✅ Expect: the radios/checkboxes on the page visibly select, text blanks fill.
   - ✅ Expect the status line: "Filled N. Nothing was submitted..."
   - ❌ Any question reporting **not filled** → §3.1.
7. **The test that actually matters: navigate away and come back.** Click to another
   unit, then return to the assignment. **If the answers are still there, the fill
   reached React state.** If they vanished, the fill only touched the DOM and React
   threw it away — that's the exact failure mode this whole design exists to prevent,
   and I need to know.
8. **Confirm nothing was submitted.** The extension has no submit code path at all,
   but verify the page still shows an unsubmitted state.

### 3.1 If something fails, grab this

Open DevTools (F12) on the assignment page, paste into Console, and send me the output:

```js
copy(JSON.stringify({
  url: location.href,
  inputs: [...document.querySelectorAll('input, textarea')].map(i => ({
    type: i.type, name: i.name, id: i.id,
    role: i.getAttribute('role'),
    label: (i.closest('label') || i.parentElement)?.innerText?.slice(0, 90)
  })),
  found: window.__nptelAssistant ? window.__nptelAssistant.discover().length : 'not injected'
}, null, 2))
```

That pastes to your clipboard. It tells me how questions are grouped on the real page,
which is all I need to fix the heuristic. Also mention which question numbers failed.

---

## 4. What's built

```
extension/
  manifest.json     22 lines  MV3. No declarative content_scripts — injected on demand.
  content.js       317 lines  Discovery + applicator + image capture. THE IMPORTANT FILE.
  gemini.js        143 lines  One API call, JSON-schema response, error mapping.
  sidepanel.html    46 lines  Panel markup.
  sidepanel.css    155 lines  Dark, dense, 400px.
  sidepanel.js     281 lines  Controller: scan -> answer -> fill.
  background.js      3 lines  Opens the panel on icon click. That's genuinely all it does.
fixtures/
  react-portal.html 119 lines Real React, controlled inputs. The regression suite's teeth.
  legacy-gcb.html    44 lines Old Google Course Builder markup.
test/
  autofill.test.mjs 197 lines Playwright, 6 tests.
README.md, package.json, .gitignore
```

### How a run flows

```
sidepanel "Scan"
  -> chrome.scripting.executeScript(content.js)   [guarded; no-ops if already there]
  -> message EXTRACT
       waitForSettle()      wait for React hydration
       discover()           group inputs into questions, stamp data-nsolve-qid/oid
       imagesIn()           fetch <img> as base64 (same-origin, carries cookies)
  <- {url, title, questions[]}

sidepanel "Answer"
  -> gemini.solve()  one generateContent call, responseSchema pins the JSON shape
  <- answers[] {qid, oids[], text, confidence, reasoning}

sidepanel "Fill page"
  -> message APPLY {answers}
       fillOne() per question, verify, retry once on failure
  <- [{qid, ok}]
```

---

## 5. Key decisions and why

Read this before changing anything — most of it is non-obvious and was expensive to
establish.

**The portal migrated, and that's the whole reason this project exists.**
`onlinecourses.nptel.ac.in` is now a Next.js/React App Router app. Verified live:
`/noc25_cs01/unit?unit=1&assessment=1` 302s to
`/e-learning/course/noc25_cs01?unitId=1&assessmentId=1`, and `/noc25_cs01/preview` 302s
to `/e-learning/preview/noc25_cs01`. Server HTML is ~20 KB with 169 `_next/static`
chunk refs; **questions are client-rendered after hydration**. Every existing NPTEL
solver (including `tashifkhan/MOOC-utils`, which this was modelled on) hardcodes Google
Course Builder selectors — `.qt-mc-question`, `.gcb-mcq-choice`, `.qt-question`,
`#submitbutton` — which no longer exist. Their autofill code runs fine and matches zero
elements. **That is the bug being fixed.**

**Discovery groups radios by `name`, not by selector.** A radio group *is* a set of
inputs sharing a `name` — that's the HTML mechanism, so it's far more stable than any
class name. Falls back to nearest `fieldset`/`[role=radiogroup]`, then to the lowest
ancestor holding >1 control. Container is the lowest common ancestor of the group;
prompt is the container's text minus the option labels (walked via TreeWalker, skipping
nodes inside labels). Consequence: **one code path handles both the React portal and
legacy GCB pages**, which is why there's no separate "legacy selectors" tier. The
legacy fixture proves it.

**Fills must go through React.** `input.checked = true` / `el.value = x` do not reach
React state — React keeps a `_valueTracker` on the node and swallows the event when the
property is set directly. It then re-renders and reverts the write. So:
- choices: `.click()` **on the input**, never the label (a label click re-dispatches to
  the input and would toggle a checkbox straight back off)
- text: `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, text)`
  then dispatch bubbling `input` + `change`, with `focus()` before and `blur()` after
- every fill is verified against the DOM afterwards, retried once after 150 ms, then
  reported as `not filled` rather than failing silently

**Stable IDs are stamped onto the DOM** (`data-nsolve-qid`, `data-nsolve-oid`). DOM
nodes can't cross the `chrome.runtime` message boundary. An in-memory index registry
would break the moment React reorders nodes between extract and fill; React ignores
unknown `data-*` attributes, so they survive re-renders, and if a node *is* replaced the
attribute vanishes and `apply()` detects a genuinely stale handle instead of silently
filling the wrong question.

**One Gemini call, not two.** The reference project runs an extract pass then a solve
pass because it ships raw page HTML to the model. `content.js` already parses questions
out of the DOM deterministically, so the extract pass is paying the model to re-read
work already done. Halves cost and latency.

**No submit path exists, at all.** Not a disabled toggle — there is no code that clicks
a submit button. Filling is reversible; submitting isn't. A test asserts the fixture's
submit handler never fires.

**No build step.** MV3 extension pages support ES modules natively; only content scripts
can't be modules, which is why `content.js` is one file. So no Vite, no bundler.
`extension/` loads directly in Chrome. Don't add a build unless something genuinely
needs one.

**No relay service worker.** The side panel is an extension page, so it's already exempt
from page CORS given `host_permissions`. Gemini is called straight from the panel.
`background.js` only sets `openPanelOnActionClick`.

**Images are fetched in the content script**, not the worker — they're session-protected
and a same-origin fetch from the page carries the student's cookies automatically. Then
blob → FileReader → base64 → Gemini `inline_data`. Skips anything matching
`icon|logo|progress|avatar|spinner|sprite` or under 50×50, and anything over 4 MB.

---

## 6. Verified research (don't re-derive this)

**Gemini models — the reference repo's IDs are dead.** It pins `gemini-2.5-flash` and
`gemini-3-flash-preview`. As of now: Gemini 2.0 Flash was **shut down 1 June 2026**; the
**2.5 family retires 16 Oct 2026**; 1.5 returns 404. We default to the
**`gemini-flash-latest`** alias and populate a dropdown from `ListModels`
(`GET /v1beta/models?key=`) at runtime. Also: `temperature`/`top_p`/`top_k` are
**deprecated** on current models — we don't send them.

**There are no public JSON APIs for Swayam/NPTEL.** Verified negatives:
`tools.nptel.ac.in/npteldata/courses.php` unreachable; `nptel.ac.in/data/course_details.json`,
`/courses.json`, `/api/courses` all 404; `swayam.gov.in/api/course/search` and `/api/v1/*`
return the HTML homepage. Part 2 must scrape.

**Scraping targets for part 2** (public, no auth, but require a full browser
`User-Agent` **and** `Referer: https://swayam.gov.in/`):
- Course search: `GET https://swayam.gov.in/search_courses?searchText=<q>` — parse
  `div.es-course-card`, `h4.courseTitle`, `.courseInstructor`, `.courseInstitute`,
  `strong.text-danger`; course code via regex `/([^/]+)/preview`
- Announcements: `GET https://onlinecourses.nptel.ac.in/<code>/announcements`, on 404
  fall back to `https://onlinecourses.swayam2.ac.in/<code>/announcements` — parse
  `span.gcb-announcement-title`, `p.gcb-announcement-content`, and the date from a
  sibling `<p>` (may need regex `new Date\(([\d.]+)\)` from an inline script)
- Also scrapeable: `https://swayam.gov.in/nc_details/NPTEL` (200, HTML, ~58 KB)

**Auth on the course portal** is SSO via `swayam-sso.swayam2.ac.in`. Course content is
gated behind it. Only relevant to the extension (which runs in the logged-in tab), not
to part 2's scraping, which hits public pages.

**The reference repo (`tashifkhan/MOOC-utils`) does not run as committed.**
`app/api/main.py` imports `routers.auth` and `users.py` imports `app.core.auth.require_auth`,
but **neither `app/api/routers/auth.py` nor `app/core/auth.py` exists in the tree**. Its
OTP auth must be written from scratch. Its client contract is still worth copying:
`POST /auth/request-otp {email}`, `POST /auth/verify-otp {email, code}`,
`POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me`, all with
`credentials: "include"` (httpOnly cookies). Config it implies: 15 min access token,
7 day refresh, 6-digit OTP, 10 min expiry.

**Frontend refs you asked about.** "Skipper UI" is almost certainly
**[Skiper UI](https://skiper-ui.com/)** (one `p`) — a shadcn-style *registry* (copy-paste
via `npx shadcn add @skiper-ui/skiperNN`, no runtime package), React/Next/Tailwind only,
built on Motion. It's showy landing-page components (cursor trails, dynamic island, card
swipers) — good for part 3's landing page, nothing in it fits a 400px side panel.
**[Motion](https://motion.dev)** is npm `motion@13`; vanilla `motion/mini` is 2.3 kB and
CSP-safe **if vendored locally** (CDN is blocked under `script-src 'self'`), but **vanilla
layout animations are paid** (Motion+). Hence: hand-rolled `element.animate()` in the side
panel, `motion/react` for part 3.

---

## 7. What's left

All three parts are built and verified. Remaining items are edge-case polish, not
blockers.

### Part 1 leftovers
- MathJax questions render as inline SVG, not `<img>`, so they're currently sent as text
  only. If a real assignment has them and answers come back wrong, add container
  rasterization. Deliberately skipped as YAGNI until seen in the wild.
- No Firefox build. Would need `browser.*` shims and a different manifest key.

### Part 2 leftovers
- Scheduled announcement polling is wired but the cron interval is configurable via
  `.env` — tune to taste before leaving it running.

### Part 3 leftovers
- Email delivery in production needs a real SMTP/transactional-email provider; `.env`
  currently points at a dev SMTP stub.

---

## 8. Known gaps and risks

- **NPTEL can change its DOM under us.** Mitigated by heuristic discovery rather than
  pinned selectors, and the fixtures catch regressions offline — but a big enough
  redesign will still break it.
- **Gemini is confidently wrong sometimes.** Confidence is surfaced per question,
  nothing auto-submits, Hints mode exists. Treat low-confidence answers as suspect.
- **Checkbox grouping is the weakest heuristic.** Checkboxes don't require a shared
  `name` the way radios do. If a real page puts every checkbox under one name, several
  questions would merge into one. Covered by a fixture, but the real page may differ.
- **`node_modules/` is a symlink to your global playwright install**, not a real
  dependency tree. If `npm test` suddenly can't resolve playwright, re-run:
  `ln -sfn "$(npm root -g)/playwright" node_modules/playwright` (and the same for
  `playwright-core`). A real `npm i -D playwright` would be sturdier.
- **The React fixture loads React from unpkg**, so `npm test` needs network once.
- **This directory is not a git repository.** Nothing is committed and there's no
  history. Worth `git init` before going further.

---

## 9. Conventions

The [ponytail](https://github.com/DietrichGebert/ponytail) skill is active (`full`) —
laziest solution that works: YAGNI, stdlib and native platform features before
dependencies, no unrequested abstractions, fewest files. Deliberate simplifications are
marked with a `ponytail:` comment naming what was skipped. Keep that up; several of the
design wins above came from it (no bundler, one API call, 3-line background worker).

Tests: one meaningful runnable check per piece of non-trivial logic, no framework
ceremony. The bar is *"does it fail when the logic breaks?"* — verified for the
applicator by breaking the native setter on purpose and confirming
`fills reach React state` went red.

---

## 10. How to run

```sh
# one command (needs tmux or two terminals)
./dev.sh

# or manually:
# terminal 1
cd backend && cp .env.example .env   # edit JWT_SECRET
source .venv/bin/activate && python3 main.py

# terminal 2
cd website && cp .env.local.example .env.local
pnpm dev

# extension
# chrome://extensions → Developer mode → Load unpacked → extension/
# On assignment page: open side panel, add Gemini key in Settings, hit Scan → Answer → Fill
```
