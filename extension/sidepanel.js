import { solve, chat, listModels, DEFAULT_MODEL, DEFAULT_GROQ_MODEL } from "./gemini.js";

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
  selectedQid: null, // card picked for chat context
  chat: [], // session-only {role, content} — dies with the panel
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

/** Confidence as a soft progress bar with coral fill on warm neutral track. */
function confidenceBar(value) {
  const pct = Math.round((value ?? 0) * 100);

  const track = el("div", { className: "conf-track" });
  const fill = el("div", { className: "conf-fill", style: `width: ${pct}%` });
  track.append(fill);

  const bar = el("div", { className: "conf-bar" }, track);
  return [bar, el("span", { className: "pct", textContent: `${pct}%` })];
}

function card(q, index) {
  const ans = state.answers.get(q.qid);
  const picked = new Set(state.mode === "solve" ? ans?.oids || [] : []);
  const result = state.results.get(q.qid);

  const node = el(
    "article",
    {
      className:
        "card" +
        (state.selectedQid === q.qid ? " selected" : "") +
        (result === true ? " filled" : result === false ? " failed" : ""),
    },
    el(
      "div",
      { className: "head" },
      el("span", { className: "num", textContent: `Q${index + 1}` }),
      el("span", { className: "kind", textContent: KIND[q.type] || q.type })
    ),
    el("p", { className: "prompt", textContent: q.prompt || "(no question text found)" }),

    q.type === "fill_blank"
      ? ans && state.mode === "solve" && el("div", { className: "blank", textContent: ans.text || "—" })
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
    const meta = el("div", { className: "meta" }, ...confidenceBar(ans.confidence));

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

  // Click selects the card for chat context; toggles off on a second click.
  node.onclick = (e) => {
    if (e.target.closest("button, summary")) return;
    const on = state.selectedQid !== q.qid;
    state.selectedQid = on ? q.qid : null;
    for (const n of document.querySelectorAll(".card.selected")) n.classList.remove("selected");
    if (on) node.classList.add("selected");
  };

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

/** Chat replies render here only — never on the page. */
function renderChat() {
  const area = $("chat");
  area.textContent = "";
  for (const m of state.chat)
    area.append(
      el(
        "div",
        { className: "msg " + (m.role === "user" ? "me" : "ai") },
        el("span", { className: "who", textContent: m.role === "user" ? "You" : "Nexus" }),
        el("p", { textContent: m.content })
      )
    );
  area.scrollTop = area.scrollHeight;
}

// ------------------------------------------------------------------- actions

async function scan() {
  status("Waiting for the page to finish rendering…");
  const { questions } = await send("EXTRACT");
  state.questions = questions;
  state.answers.clear();
  state.results.clear();
  state.selectedQid = null;
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
const groqKey = () => $("groq-key").value.trim();
const groqModel = () => $("groq-model").value.trim() || DEFAULT_GROQ_MODEL;

async function answer() {
  if (!state.questions.length) await scan();
  const model = $("model").value || DEFAULT_MODEL;

  const blank = state.questions.filter((q) => !q.prompt || q.prompt.length < 10).length;
  if (blank === state.questions.length)
    throw new Error("No question text was found, so there's nothing to answer. See §3.1 of HANDOVER.md.");

  status(`Asking ${model}…`);
  const { answers, provider } = await solve({
    apiKey: apiKey(),
    model,
    groqKey: groqKey(),
    groqModel: groqModel(),
    questions: state.questions,
    mode: state.mode,
  });
  // ponytail: hints never carries an answer, even if the model ignores the prompt
  const stripped =
    state.mode === "hints" ? answers.map((a) => ({ ...a, oids: [], text: "" })) : answers;

  state.answers = new Map(stripped.map((a) => [a.qid, a]));
  state.results.clear();
  render();
  syncButtons();

  const missing = state.questions.length - state.answers.size;
  status(
    `Answered ${state.answers.size} of ${state.questions.length} via ${provider}.` +
      (missing > 0 ? ` ${missing} came back blank.` : "")
  );
}

async function fill(qids) {
  if (state.mode !== "solve") return status("Hints mode never fills — switch to Solve to fill.");  const payload = (qids || state.questions.map((q) => q.qid))
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

async function chatSend() {
  const text = $("chat-input").value.trim();
  if (!text) return;

  // Selected card → that question in full; otherwise the whole list as context.
  const context = state.selectedQid
    ? state.questions.filter((q) => q.qid === state.selectedQid)
    : state.questions;
  // ~10 turns = 20 messages, newest last; ends with this user message.
  const hist = [...state.chat, { role: "user", content: text }].slice(-20);

  status("Asking…");
  const { reply, provider } = await chat({
    apiKey: apiKey(),
    model: $("model").value || DEFAULT_MODEL,
    groqKey: groqKey(),
    groqModel: groqModel(),
    history: hist,
    questions: context,
    mode: state.mode,
  });

  state.chat = [...hist, { role: "assistant", content: reply }];
  $("chat-input").value = "";
  renderChat();
  status(`Reply via ${provider}.`);
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
  const saved = await store.get({
    geminiKey: "",
    model: DEFAULT_MODEL,
    mode: "solve",
    groqKey: "",
    groqModel: "",
  });
  const d = window.__NEXUS_DEFAULTS || {};
  if (!saved.geminiKey && d.geminiKey) {
    saved.geminiKey = d.geminiKey;
    await store.set({ geminiKey: d.geminiKey });
  }
  if (!saved.groqKey && d.groqKey) {
    saved.groqKey = d.groqKey;
    await store.set({ groqKey: d.groqKey });
  }
  $("key").value = saved.geminiKey;
  $("groq-key").value = saved.groqKey;
  $("groq-model").value = saved.groqModel;
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
  $("groq-key").oninput = () => store.set({ groqKey: groqKey() });
  $("groq-model").oninput = () => store.set({ groqModel: $("groq-model").value });
  $("model").onchange = () => store.set({ model: $("model").value });
  $("refresh-models").onclick = (e) =>
    guard(e.target, "…", () => loadModels().then(() => status("Model list updated.")));

  $("scan").onclick = (e) => guard(e.target, "Scanning…", scan);
  $("solve").onclick = (e) => guard(e.target, "Thinking…", answer);
  $("fill").onclick = (e) => guard(e.target, "Filling…", () => fill());
  $("chat-send").onclick = (e) => guard(e.target, "…", chatSend);
  $("chat-input").onkeydown = (e) => {
    if (e.key === "Enter") $("chat-send").click();
  };

  if (!saved.geminiKey) $("settings").hidden = false;
  await loadModels().catch(() => {});
  render();
  syncButtons();
})();
