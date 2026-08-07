/* The one check that matters: does a fill actually reach the framework?
 *
 * Run: npm test   (or: node --test test/)
 *
 * The React fixture uses controlled inputs, so we assert against React STATE,
 * not the DOM. A fill that only mutates the DOM looks fine for a frame and then
 * gets reverted on the next render — asserting on `input.checked` would pass
 * while the student's answer silently vanishes.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTENT = path.join(root, "extension/content.js");
const fixture = (name) => "file://" + path.join(root, "fixtures", name);

let browser;
before(async () => (browser = await chromium.launch()));
after(async () => browser?.close());

async function load(name) {
  const page = await browser.newPage();
  await page.goto(fixture(name));
  await page.addScriptTag({ path: CONTENT });
  return page;
}

const extract = (page) => page.evaluate(() => window.__nptelAssistant.EXTRACT());
const apply = (page, answers) =>
  page.evaluate((a) => window.__nptelAssistant.APPLY({ answers: a }), answers);

/** Pick option indices for a choice question, or literal text for a blank. */
const answer = (q, pick) =>
  q.type === "fill_blank"
    ? { qid: q.qid, type: q.type, oids: [], text: pick }
    : { qid: q.qid, type: q.type, oids: pick.map((i) => q.options[i].oid), text: "" };

// --------------------------------------------------------------------- React

test("react fixture: discovers every question with its type and options", async () => {
  const page = await load("react-portal.html");
  const { questions } = await extract(page);

  assert.equal(questions.length, 4, "should find 4 questions");
  assert.deepEqual(
    questions.map((q) => q.type),
    ["single_choice", "multi_choice", "fill_blank", "single_choice"]
  );

  assert.match(questions[0].prompt, /binary search/i);
  assert.equal(questions[0].options.length, 4);
  assert.match(questions[0].options[1].text, /O\(log n\)/);

  // The prompt must not swallow the option text.
  assert.ok(!/O\(log n\)/.test(questions[0].prompt), "prompt leaked option text");

  assert.equal(questions[1].options.length, 4);
  assert.equal(questions[3].images.length, 1, "should capture the inline chart");
  assert.match(questions[3].images[0].mime, /^image\//);

  await page.close();
});

test("react fixture: fills reach React state, not just the DOM", async () => {
  const page = await load("react-portal.html");
  const { questions } = await extract(page);

  const answers = [
    answer(questions[0], [1]), // O(log n)
    answer(questions[1], [0, 2]), // merge sort + insertion sort
    answer(questions[2], "10"),
    answer(questions[3], [1]), // saturates then degrades
  ];

  const results = await apply(page, answers);
  assert.ok(results.every((r) => r.ok), `applicator reported failures: ${JSON.stringify(results)}`);

  // Let React flush, then read its state — the source of truth.
  await page.waitForTimeout(300);
  const state = await page.evaluate(() => {
    const raw = document.getElementById("state").textContent;
    return JSON.parse(raw.slice(raw.indexOf("{")));
  });

  assert.equal(state.q1, "b", "single choice did not reach React state");
  assert.deepEqual([...state.q2].sort(), ["a", "c"], "multi choice did not reach React state");
  assert.equal(state.q3, "10", "text input did not reach React state (value tracker)");
  assert.equal(state.q4, "b", "image question did not reach React state");

  await page.close();
});

test("react fixture: unchecks boxes that should not be selected", async () => {
  const page = await load("react-portal.html");
  const { questions } = await extract(page);

  await apply(page, [answer(questions[1], [0, 1, 2, 3])]);
  await apply(page, [answer(questions[1], [1])]); // narrow it down
  await page.waitForTimeout(300);

  const state = await page.evaluate(() => {
    const raw = document.getElementById("state").textContent;
    return JSON.parse(raw.slice(raw.indexOf("{")));
  });
  assert.deepEqual(state.q2, ["b"], "stale checkboxes were left selected");

  await page.close();
});

// -------------------------------------------------------- live Swayam layout

test("swayam layout: finds question text that lives outside the options container", async () => {
  // Regression for the live-site bug where every question read "(no question text found)".
  const page = await load("swayam-layout.html");
  const { questions } = await extract(page);

  assert.equal(questions.length, 5);
  for (const q of questions)
    assert.ok(q.prompt.length > 10, `Q${q.qid} has no prompt: ${JSON.stringify(q.prompt)}`);

  // Layout A — options nested below the text.
  assert.match(questions[0].prompt, /Arjuna's despondency/);
  assert.match(questions[1].prompt, /Self-awareness/);

  // Layout B — flat parent, text is a preceding sibling.
  assert.match(questions[2].prompt, /guna is associated with clarity/);
  assert.match(questions[3].prompt, /Patanjali/);
  assert.match(questions[4].prompt, /sthitaprajna/);

  // Each prompt must be its own — not bled from the question above.
  assert.ok(!/Patanjali/.test(questions[2].prompt), "Q3 absorbed Q4's text");
  assert.ok(!/guna/.test(questions[3].prompt), "Q4 absorbed Q3's text");

  // And prompts still must not swallow their own options.
  assert.ok(!/Sattva/.test(questions[2].prompt), "prompt leaked option text");

  assert.equal(questions[4].type, "multi_choice");
  await page.close();
});

test("swayam layout: fills apply to the right question", async () => {
  const page = await load("swayam-layout.html");
  const { questions } = await extract(page);

  const results = await apply(page, [
    answer(questions[0], [2]),
    answer(questions[2], [0]), // Sattva
    answer(questions[4], [0, 2]),
  ]);
  assert.ok(results.every((r) => r.ok), JSON.stringify(results));

  const dom = await page.evaluate(() => ({
    qa: document.querySelector('input[name="qa"]:checked')?.value,
    qb: document.querySelector('input[name="qb"]:checked')?.value ?? null,
    qc: document.querySelector('input[name="qc"]:checked')?.value,
    qe: [...document.querySelectorAll('input[name="qe"]:checked')].map((i) => i.value),
  }));
  assert.equal(dom.qa, "2");
  assert.equal(dom.qb, null, "filled a question that wasn't asked for");
  assert.equal(dom.qc, "0");
  assert.deepEqual(dom.qe, ["0", "2"]);

  await page.close();
});

// -------------------------------------------------------------------- legacy

test("legacy Course Builder fixture works through the same code path", async () => {
  const page = await load("legacy-gcb.html");
  const { questions } = await extract(page);

  assert.equal(questions.length, 3);
  assert.deepEqual(
    questions.map((q) => q.type),
    ["single_choice", "multi_choice", "fill_blank"]
  );
  assert.match(questions[0].prompt, /OSI model/i);

  const results = await apply(page, [
    answer(questions[0], [1]), // network layer
    answer(questions[1], [0, 1]), // TCP + UDP
    answer(questions[2], "443"),
  ]);
  assert.ok(results.every((r) => r.ok), JSON.stringify(results));

  const dom = await page.evaluate(() => ({
    q1: document.querySelector('input[name="Q1"]:checked')?.value,
    q2: [...document.querySelectorAll('input[name="Q2"]:checked')].map((i) => i.value),
    q3: document.querySelector('input[name="Q3"]').value,
  }));
  assert.equal(dom.q1, "1");
  assert.deepEqual(dom.q2, ["0", "1"]);
  assert.equal(dom.q3, "443");

  await page.close();
});

// --------------------------------------------------------------------- smoke

test("Chrome loads the unpacked extension without errors", async () => {
  // Catches what the DOM tests can't: a bad manifest, a CSP violation, or an
  // ES-module import that fails inside the sidepanel.
  const { default: os } = await import("node:os");
  const { default: fs } = await import("node:fs");

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "nsolve-"));
  const ext = path.join(root, "extension");
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });

  try {
    const sw =
      ctx.serviceWorkers()[0] ||
      (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
    assert.ok(sw, "background service worker never registered — manifest is bad");

    const errors = [];
    const page = await ctx.newPage();
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(e.message));

    const panel = `chrome-extension://${new URL(sw.url()).host}/sidepanel.html`;
    await page.goto(panel);
    await page.waitForTimeout(1000);

    assert.equal(await page.title(), "Assignment Assistant");
    assert.deepEqual(
      await page.$$eval("#actions button", (b) => b.map((x) => x.textContent)),
      ["Scan page", "Answer", "Fill page"]
    );
    assert.deepEqual(errors, [], "sidepanel logged errors");

    // The key must survive reopening the panel — it used to be written on blur only,
    // which raced the click that read it back.
    await page.fill("#key", "AIzaSyTEST-not-a-real-key");
    await page.waitForTimeout(400);
    await page.close();

    const reopened = await ctx.newPage();
    await reopened.goto(panel);
    await reopened.waitForTimeout(600);
    assert.equal(
      await reopened.inputValue("#key"),
      "AIzaSyTEST-not-a-real-key",
      "API key did not persist across reopening the panel"
    );
  } finally {
    await ctx.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test("nothing in the extension ever clicks submit", async () => {
  const page = await load("legacy-gcb.html");
  let dialogs = 0;
  page.on("dialog", (d) => (dialogs++, d.dismiss()));

  const { questions } = await extract(page);
  await apply(page, [answer(questions[0], [1])]);
  await page.waitForTimeout(200);

  assert.equal(dialogs, 0, "the fixture's submit handler fired — something clicked submit");
  await page.close();
});
