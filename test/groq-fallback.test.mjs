/* Gemini→Groq fallback. Mocks globalThis.fetch — no real network.
 *
 * Run: node --test test/groq-fallback.test.mjs
 *
 * Written against the locked solve() signature:
 *   solve({ apiKey, model, questions, mode, groqKey?, groqModel? })
 *   → { answers, provider }  (provider: "Gemini" | "Groq (Gemini down)")
 * Note: call() retries 429 once after 1.5s, so Gemini-429 tests take ~1.5s.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { solve } from "../extension/gemini.js";

const GEMINI = "generativelanguage.googleapis.com";
const GROQ = "groq.com";

const questions = [
  {
    qid: "q1",
    type: "single_choice",
    prompt: "2+2?",
    options: [
      { oid: "a", text: "4" },
      { oid: "b", text: "5" },
    ],
  },
];

const groqAnswers = [
  { qid: "q1", oids: ["a"], text: "", confidence: 0.9, reasoning: "arithmetic" },
];

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const geminiOk = (answers) =>
  json({
    candidates: [{ content: { parts: [{ text: JSON.stringify({ answers }) }] } }],
  });

// Groq is OpenAI-compatible: choices[0].message.content holds the schema JSON.
const groqOk = (answers) =>
  json({ choices: [{ message: { content: JSON.stringify({ answers }) } }] });

const gemini429 = () => json({ error: { message: "quota exceeded" } }, 429);

const originalFetch = globalThis.fetch;
let calls = [];

function route({ gemini, groq }) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    calls.push(u);
    if (u.includes(GEMINI)) return gemini(u, init);
    if (u.includes(GROQ)) return groq(u, init);
    throw new Error(`unexpected fetch: ${u}`);
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const groqCalls = () => calls.filter((u) => u.includes(GROQ)).length;
const base = { apiKey: "test-key", questions };

test("Gemini 429 then Groq success → returns Groq answers", async () => {
  route({ gemini: gemini429, groq: () => groqOk(groqAnswers) });

  const { answers, provider } = await solve({
    ...base,
    groqKey: "gsk_test",
    groqModel: "llama-3.3-70b-versatile",
  });

  assert.deepEqual(answers, groqAnswers);
  assert.equal(provider, "Groq (Gemini down)");
  assert.equal(groqCalls(), 1, "should call Groq exactly once");
});

test("Gemini error + no groqKey → throws Gemini message, no Groq call", async () => {
  route({
    gemini: gemini429,
    groq: () => {
      throw new Error("Groq must not be called without groqKey");
    },
  });

  await assert.rejects(solve(base), /Gemini/);
  assert.equal(groqCalls(), 0);
});

test("both fail → error names Gemini and Groq", async () => {
  route({
    gemini: gemini429,
    groq: () => json({ error: { message: "invalid api key" } }, 401),
  });

  await assert.rejects(solve({ ...base, groqKey: "gsk_bad" }), (err) => {
    assert.match(err.message, /Gemini/, `missing Gemini in: ${err.message}`);
    assert.match(err.message, /Groq/, `missing Groq in: ${err.message}`);
    return true;
  });
});

test("Gemini success → Groq fetch not called", async () => {
  route({
    gemini: () =>
      geminiOk([
        { qid: "q1", oids: ["b"], text: "", confidence: 0.8, reasoning: "math" },
      ]),
    groq: () => {
      throw new Error("Groq must not be called on Gemini success");
    },
  });

  const { answers, provider } = await solve({ ...base, groqKey: "gsk_test" });

  assert.equal(provider, "Gemini");
  assert.equal(answers.length, 1);
  assert.deepEqual(answers[0].oids, ["b"]);
  assert.equal(groqCalls(), 0, "Groq was called despite Gemini succeeding");
});
