import { solve, listModels, DEFAULT_MODEL } from "./gemini.js";

const $ = (id) => document.getElementById(id);

/** Build DOM instead of setting innerHTML — question text comes off an untrusted page. */
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids.flat()) if (k != null && k !== false) n.append(k);
  return n;
};

const state = {
  questions: [],
  answers: new Map(), // qid -> answer
  results: new Map(), // qid -> bool
  mode: "solve",
};

const store = {
  get: (defaults) => chrome.storage.local.get(defaults),
  set: (obj) => chrome.storage.local.set(obj),
};

// ------------------------------------------------------------------ page I/O

async function send(type, payload = {}) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab.");
  // Injected on demand; content.js no-ops if it's already there.
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
  const res = await chrome.tabs.sendMessage(tab.id, { type, ...payload });
  if (!res?.ok) throw new Error(res?.error || "The page didn't respond.");
  return res.data;
}

function status(msg, isError = false) {
  const n = $("status");
  n.textContent = msg;
  n.classList.toggle("err", isError);
}

async function guard(btn, label, fn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try {
    await fn();
  } catch (err) {
    status(err.message, true);
  } finally {
    btn.textContent = original;
    syncButtons();
  }
}

// ----------------------------------------------------------------- rendering

/** ponytail: native WAAPI stagger — Motion would be a dependency for this one effect. */
function stagger(nodes) {
  nodes.forEach((n, i) =>
    n.animate(
      [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }],
      { duration: 200, delay: i * 30, easing: "cubic-bezier(.2,.7,.3,1)", fill: "backwards" }
    )
  );
}

const KIND = { single_choice: "one answer", multi_choice: "select all", fill_blank: "fill in" };

/** Confidence as an SVG ring with animated stroke. */
function confidenceRing(value) {
  const pct = Math.round((value ?? 0) * 100);
  const r = 12, c = 2 * Math.PI * r;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 30 30");

  const bg = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  bg.setAttribute("cx", "15"); bg.setAttribute("cy", "15"); bg.setAttribute("r", String(r));
  bg.classList.add("ring-bg");

  const fill = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  fill.setAttribute("cx", "15"); fill.setAttribute("cy", "15"); fill.setAttribute("r", String(r));
  fill.classList.add("ring-fill");
  fill.setAttribute("stroke-dasharray", String(c));
  fill.setAttribute("stroke-dashoffset", String(c * (1 - pct / 100)));

  svg.append(bg, fill);

  const cls = pct < 50 ? "low" : pct < 75 ? "mid" : "";
  const ring = el("div", { className: "conf-ring" + (cls ? " " + cls : "") }, svg);

  return [ring, el("span", { className: "pct", textContent: `${pct}%` })];
}

function card(q, index) {
  const ans = state.answers.get(q.qid);
  const picked = new Set(ans?.oids || []);
  const result = state.results.get(q.qid);

  const node = el(
    "article",
    { className: "card" + (result === true ? " filled" : result === false ? " failed" : "") },
    el(
      "div",
      { className: "head" },
      el("span", { className: "num", textContent: `Q${index + 1}` }),
      el("span", { className: "kind", textContent: KIND[q.type] || q.type })
    ),
    el("p", { className: "prompt", textContent: q.prompt || "(no question text found)" }),

    q.type === "fill_blank"
      ? ans && el("div", { className: "blank", textContent: ans.text || "—" })
      : q.options.map((o) =>
          el(
            "div",
            { className: "opt" + (picked.has(o.oid) ? " pick" : "") },
            el("span", { className: "mark", textContent: picked.has(o.oid) ? "▸" : "" }),
            el("span", { textContent: o.text })
          )
        )
  );

  if (ans) {
    const meta = el("div", { className: "meta" }, ...confidenceRing(ans.confidence));

    if (result !== undefined)
      meta.append(
        el("span", {
          className: "badge " + (result ? "ok" : "no"),
          textContent: result ? "filled" : "not filled",
        })
      );

    if (state.mode === "solve") {
      const btn = el("button", { textContent: "Fill this" });
      btn.onclick = () => guard(btn, "…", () => fill([q.qid]));
      meta.append(btn);
    }
    node.append(meta);

    if (ans.reasoning)
      node.append(
        el(
          "details",
          { open: state.mode === "hints" },
          el("summary", { textContent: state.mode === "hints" ? "How to approach it" : "Why" }),
          el("p", { textContent: ans.reasoning })
        )
      );
  }

  return node;
}

function render() {
  const list = $("list");
  list.textContent = "";

  if (!state.questions.length) {
    list.append(
      el("p", {
        className: "empty",
        textContent: "Open an assignment page, then hit Scan page.",
      })
    );
    return;
  }

  const cards = state.questions.map(card);
  cards.forEach((c) => list.append(c));
  stagger(cards);
}

function syncButtons() {
  $("solve").disabled = false; // scans first if you haven't
  $("fill").disabled = !state.answers.size || state.mode !== "solve";
  $("fill").hidden = state.mode !== "solve";
}

// ------------------------------------------------------------------- actions

async function scan() {
  status("Waiting for the page to finish rendering…");
  const { questions, title } = await send("EXTRACT");
  state.questions = questions;
  state.answers.clear();
  state.results.clear();
  render();
  syncButtons();
  if (!questions.length) return status("No questions found on this page.");

  const blank = questions.filter((q) => !q.prompt || q.prompt.length < 10).length;
  status(
    `Found ${questions.length} question${questions.length > 1 ? "s" : ""}. Now hit Answer.` +
      (blank ? ` \u26A0 ${blank} had no readable question text.` : "")
  );
}

// The field is the source of truth, not storage: reading storage here used to race the
// keystroke that saved it, so pasting a key and hitting Answer failed with "no key set".
const apiKey = () => $("key").value.trim();

async function answer() {
  if (!state.questions.length) await scan();
  const model = $("model").value || DEFAULT_MODEL;

  const blank = state.questions.filter((q) => !q.prompt || q.prompt.length < 10).length;
  if (blank === state.questions.length)
    throw new Error("No question text was found, so there's nothing to answer. See §3.1 of HANDOVER.md.");

  status(`Asking ${model}…`);
  const answers = await solve({
    apiKey: apiKey(),
    model,
    questions: state.questions,
    mode: state.mode,
  });

  state.answers = new Map(answers.map((a) => [a.qid, a]));
  state.results.clear();
  render();
  syncButtons();

  const missing = state.questions.length - state.answers.size;
  status(
    `Answered ${state.answers.size} of ${state.questions.length}.` +
      (missing > 0 ? ` ${missing} came back blank.` : "")
  );
}

async function fill(qids) {
  const payload = (qids || state.questions.map((q) => q.qid))
    .map((qid) => state.answers.get(qid))
    .filter(Boolean)
    .map((a) => ({
      qid: a.qid,
      type: state.questions.find((q) => q.qid === a.qid).type,
      oids: a.oids,
      text: a.text,
    }));

  if (!payload.length) return status("Nothing to fill yet — hit Answer first.");

  status(`Filling ${payload.length} answer${payload.length > 1 ? "s" : ""}…`);
  for (const r of await send("APPLY", { answers: payload })) state.results.set(r.qid, r.ok);

  render();
  const failed = [...state.results.values()].filter((ok) => !ok).length;
  status(
    failed
      ? `Filled ${state.results.size - failed}, but ${failed} wouldn't take. Set those by hand.`
      : `Filled ${state.results.size}. Nothing was submitted — review, then submit yourself.`
  );
}

async function loadModels() {
  const { model } = await store.get({ model: DEFAULT_MODEL });
  const select = $("model");
  const names = apiKey() ? await listModels(apiKey()) : [];
  const options = names.length ? names : [model || DEFAULT_MODEL];

  select.textContent = "";
  for (const n of options) select.append(el("option", { value: n, textContent: n }));
  select.value = options.includes(model) ? model : options[0];
  await store.set({ model: select.value });
}

// ---------------------------------------------------------------------- init

(async function init() {
  const saved = await store.get({ geminiKey: "", model: DEFAULT_MODEL, mode: "solve" });
  $("key").value = saved.geminiKey;
  state.mode = saved.mode;

  for (const b of document.querySelectorAll(".seg button")) {
    b.classList.toggle("on", b.dataset.mode === state.mode);
    b.setAttribute("aria-checked", String(b.dataset.mode === state.mode));
    b.onclick = async () => {
      state.mode = b.dataset.mode;
      await store.set({ mode: state.mode });
      for (const o of document.querySelectorAll(".seg button")) {
        o.classList.toggle("on", o === b);
        o.setAttribute("aria-checked", String(o === b));
      }
      render();
      syncButtons();
    };
  }

  $("toggle-settings").onclick = () => ($("settings").hidden = !$("settings").hidden);

  // Saved on every keystroke so a pasted key survives closing the panel immediately.
  $("key").oninput = () => store.set({ geminiKey: apiKey() });
  $("key").onchange = () => loadModels().catch((e) => status(e.message, true));
  $("model").onchange = () => store.set({ model: $("model").value });
  $("refresh-models").onclick = (e) =>
    guard(e.target, "…", () => loadModels().then(() => status("Model list updated.")));

  $("scan").onclick = (e) => guard(e.target, "Scanning…", scan);
  $("solve").onclick = (e) => guard(e.target, "Thinking…", answer);
  $("fill").onclick = (e) => guard(e.target, "Filling…", () => fill());

  if (!saved.geminiKey) $("settings").hidden = false;
  await loadModels().catch(() => {});
  render();
  syncButtons();
})();
