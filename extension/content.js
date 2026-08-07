/* Content script: finds questions on an assignment page and fills answers in.
 *
 * Injected on demand by the sidepanel (not declared in the manifest), so the
 * same code path works on the live site and on the local test fixtures.
 *
 * ponytail: one file, no bundler — MV3 content scripts can't be ES modules.
 *
 * The page is a Next.js/React app. Two consequences drive everything here:
 *   1. Questions don't exist at injection time -> waitForSettle().
 *   2. Setting .checked/.value directly doesn't reach React state -> fill().
 */
if (!window.__nptelAssistant) {
  window.__nptelAssistant = {}; // filled in at the bottom; also the re-injection guard

  const QID = "data-nsolve-qid"; // on the question container
  const OID = "data-nsolve-oid"; // on each option's <input>
  const OPT = "data-nsolve-opt"; // on each option's <label>, so prompt text can exclude it

  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

  const isVisible = (el) =>
    el.offsetParent !== null || el.getBoundingClientRect().height > 0;

  /** Lowest common ancestor of a set of nodes. */
  function lca(nodes) {
    let a = nodes[0];
    for (const b of nodes.slice(1)) while (a && !a.contains(b)) a = a.parentElement;
    return a || document.body;
  }

  function labelOf(input) {
    return (
      input.closest("label") ||
      (input.id && document.querySelector(`label[for="${CSS.escape(input.id)}"]`)) ||
      input.parentElement
    );
  }

  // ---------------------------------------------------------------- hydration

  /**
   * Resolve once the question DOM exists AND has stopped changing.
   * A plain load event fires long before React has rendered the questions.
   */
  function waitForSettle({ quietMs = 400, timeoutMs = 10000 } = {}) {
    const anyControls = () =>
      document.querySelector("input[type=radio], input[type=checkbox], textarea, input[type=text]");

    return new Promise((resolve) => {
      let quiet, done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(quiet);
        clearTimeout(hard);
        obs.disconnect();
        resolve(!!anyControls());
      };
      const bump = () => {
        clearTimeout(quiet);
        quiet = setTimeout(() => anyControls() && finish(), quietMs);
      };
      const obs = new MutationObserver(bump);
      obs.observe(document.body, { childList: true, subtree: true });
      const hard = setTimeout(finish, timeoutMs);
      bump();
    });
  }

  // --------------------------------------------------------------- discovery

  let containerSeq = 0;
  const containerIds = new WeakMap();

  /** Grouping key for a control with no name attribute: its nearest cluster ancestor. */
  function containerKey(el, sel) {
    let node = el.closest("fieldset,[role=radiogroup],[role=group]");
    if (!node) {
      node = el.parentElement;
      while (node && node !== document.body && node.querySelectorAll(sel).length < 2)
        node = node.parentElement;
    }
    node = node || el.parentElement;
    if (!containerIds.has(node)) containerIds.set(node, `c${++containerSeq}`);
    return containerIds.get(node);
  }

  /** Group radios/checkboxes into questions. Radios group by `name` — that's what makes them a group. */
  function groupControls(sel) {
    const groups = new Map();
    for (const el of [...document.querySelectorAll(sel)].filter(isVisible)) {
      const key = el.name ? `n:${el.name}` : containerKey(el, sel);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(el);
    }
    return [...groups.values()];
  }

  /** Container text minus the option labels — i.e. the question itself. */
  function promptOf(container, labels) {
    const parts = [];
    const walk = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (n.parentElement?.closest("script,style")) continue;
      if (labels.some((l) => l.contains(n))) continue;
      const t = n.nodeValue.trim();
      if (t) parts.push(t);
    }
    return clean(parts.join(" "));
  }

  const CONTROLS = "input[type=radio],input[type=checkbox]";

  /**
   * The question text usually isn't inside the options' common ancestor — on the live
   * Swayam portal the options sit in their own wrapper and the text is a sibling above
   * it. So climb until the container holds real text, stopping before we swallow a
   * neighbouring question's controls.
   */
  function questionContainer(inputs, labels) {
    let node = lca(inputs);
    let widest = node;
    while (node && node !== document.body) {
      // Absorbing another question's inputs means we've gone one level too far.
      if ([...node.querySelectorAll(CONTROLS)].some((c) => !inputs.includes(c))) break;
      widest = node;
      if (promptOf(node, labels).length > 10) return node;
      node = node.parentElement;
    }
    return widest;
  }

  /**
   * Fallback for the layout where every question shares one flat parent, so climbing
   * stops immediately: the prompt is then the nearest preceding sibling with text.
   * Siblings holding controls are skipped — those belong to the question above.
   */
  function precedingText(node) {
    for (let el = node; el && el !== document.body; el = el.parentElement) {
      for (let sib = el.previousElementSibling; sib; sib = sib.previousElementSibling) {
        if (sib.querySelector(CONTROLS)) break;
        const t = clean(sib.innerText || sib.textContent);
        if (t.length > 10) return t;
      }
    }
    return "";
  }

  function buildChoiceQuestion(inputs, type) {
    const labels = inputs.map(labelOf).filter(Boolean);
    inputs.forEach((el, i) => el.setAttribute(OID, `${type[0]}${i}`));
    labels.forEach((l) => l.setAttribute(OPT, ""));

    const container = questionContainer(inputs, labels);
    const prompt = promptOf(container, labels);

    return {
      type,
      container,
      inputs,
      prompt: prompt.length > 10 ? prompt : precedingText(container) || prompt,
      options: inputs.map((el, i) => ({
        oid: el.getAttribute(OID),
        text: clean(labels[i]?.innerText || labels[i]?.textContent || el.value),
      })),
    };
  }

  /** Nearest ancestor carrying enough text to read as a question prompt. */
  function blankContainer(el) {
    let node = el.parentElement;
    while (node && node !== document.body) {
      if (clean(node.innerText).length > 15) return node;
      node = node.parentElement;
    }
    return el.parentElement || document.body;
  }

  function discover() {
    const questions = [];

    // Tier 1 — control-type grouping. This is what fires on the current React portal.
    for (const g of groupControls("input[type=radio]"))
      questions.push(buildChoiceQuestion(g, "single_choice"));
    for (const g of groupControls("input[type=checkbox]"))
      questions.push(buildChoiceQuestion(g, "multi_choice"));

    // Tier 2 — free-text controls not already inside a choice question.
    const claimed = questions.map((q) => q.container);
    const blanks = [
      ...document.querySelectorAll("input[type=text],input:not([type]),textarea"),
    ].filter((el) => isVisible(el) && !claimed.some((c) => c.contains(el)));

    for (const el of blanks) {
      el.setAttribute(OID, "t0");
      const container = blankContainer(el);
      questions.push({
        type: "fill_blank",
        container,
        inputs: [el],
        prompt: promptOf(container, []),
        options: [],
      });
    }

    // Page order, so question numbers match what the student sees.
    questions.sort((a, b) =>
      a.container.compareDocumentPosition(b.container) & Node.DOCUMENT_POSITION_FOLLOWING
        ? -1
        : 1
    );

    questions.forEach((q, i) => {
      q.qid = `q${i + 1}`;
      q.container.setAttribute(QID, q.qid);
      q.inputs.forEach((el) => {
        el.setAttribute(QID, q.qid);
        el.setAttribute(OID, `${q.qid}:${el.getAttribute(OID)}`);
      });
      q.options.forEach((o) => (o.oid = `${q.qid}:${o.oid}`));
    });

    return questions;
  }

  // ------------------------------------------------------------------ images

  const toBase64 = (blob) =>
    new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(",")[1]);
      r.onerror = rej;
      r.readAsDataURL(blob);
    });

  /**
   * Fetched here rather than in the worker: the images are session-protected and
   * a same-origin fetch from the page carries the student's cookies automatically.
   */
  async function imagesIn(container) {
    const out = [];
    for (const img of container.querySelectorAll("img")) {
      if (/icon|logo|progress|avatar|spinner|sprite/i.test(img.src)) continue;
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      if (w && h && w < 50 && h < 50) continue;
      try {
        const blob = await (await fetch(img.src)).blob();
        if (blob.size > 4e6 || !blob.type.startsWith("image/")) continue;
        out.push({ mime: blob.type, data: await toBase64(blob) });
      } catch {
        /* cross-origin or expired session — skip, the text may still be enough */
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- applying

  /**
   * React tracks the last value it wrote on the node (_valueTracker) and swallows
   * events when the property is set directly. Going through the prototype's native
   * setter defeats that, which is the whole reason a plain `el.value = x` fails here.
   */
  function setValue(el, text) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
    Object.getOwnPropertyDescriptor(proto.prototype, "value").set.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

  /** Fill one question. Returns true only if the DOM actually reflects the answer afterwards. */
  async function fillOne(ans) {
    const inputs = [...document.querySelectorAll(`[${QID}="${ans.qid}"][${OID}]`)];
    if (!inputs.length) return false;

    if (ans.type === "fill_blank") {
      const el = inputs[0];
      el.focus();
      setValue(el, ans.text ?? "");
      el.blur(); // some validators only commit on blur
      await tick();
      return el.value === (ans.text ?? "");
    }

    const wanted = new Set(ans.oids || []);
    for (const el of inputs) {
      const should = wanted.has(el.getAttribute(OID));
      // Click the input, never the label: a label click re-dispatches to the input
      // and would toggle a checkbox straight back off.
      if (el.checked !== should) el.click();
      await tick(30);
    }
    await tick();
    return inputs.every((el) => el.checked === wanted.has(el.getAttribute(OID)));
  }

  async function apply(answers) {
    if (!document.querySelector(`[${OID}]`)) discover(); // re-render since extract wiped the stamps
    const results = [];
    for (const ans of answers) {
      let ok = await fillOne(ans);
      if (!ok) {
        await tick(150);
        ok = await fillOne(ans); // one retry: React may have been mid-render
      }
      results.push({ qid: ans.qid, ok });
      await tick(100); // lets the sidepanel animate progress
    }
    return results;
  }

  // ponytail: no submit path at all. Filling is reversible, submitting isn't.

  // ------------------------------------------------------------------ router

  async function extract() {
    await waitForSettle();
    const questions = discover();
    const payload = [];
    for (const q of questions) {
      payload.push({
        qid: q.qid,
        type: q.type,
        prompt: q.prompt,
        options: q.options,
        images: await imagesIn(q.container),
      });
    }
    return { url: location.href, title: document.title, questions: payload };
  }

  const handlers = {
    PING: async () => ({ url: location.href }),
    EXTRACT: extract,
    APPLY: (msg) => apply(msg.answers),
  };

  // Also the surface test/autofill.test.mjs drives, which is why it's exported
  // rather than kept in the closure.
  Object.assign(window.__nptelAssistant, handlers, { discover });

  // Absent when a test loads this file into a plain page.
  if (globalThis.chrome?.runtime?.id) {
    chrome.runtime.onMessage.addListener((msg, _sender, send) => {
      const h = handlers[msg?.type];
      if (!h) return;
      Promise.resolve(h(msg)).then(
        (data) => send({ ok: true, data }),
        (err) => send({ ok: false, error: String(err?.message || err) })
      );
      return true; // async response
    });
  }
}
