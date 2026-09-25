/* Global chat(). Mocks globalThis.fetch — no real network.
 *
 * Run: node --test test/chat.test.mjs
 *
 * Written against the assumed chat() signature (feature still in flight in
 * extension/gemini.js — expected-red until it exports chat):
 *   chat({ apiKey, model, questions, mode, history, groqKey?, groqModel? })
 *   → { reply, provider }  (provider: "Gemini" | contains "Groq")
 * Note: call() retries 429 once after 1.5s, so Gemini-429 tests take ~1.5s.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chat } from "../extension/gemini.js";

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

const GEMINI_REPLY = "Two plus two equals four.";
const GROQ_REPLY = "Fallback reply from Groq.";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// Gemini generateContent shape: candidates[0].content.parts[].text.
const geminiText = (text) =>
  json({ candidates: [{ content: { parts: [{ text }] } }] });

// Groq is OpenAI-compatible: choices[0].message.content is the plain reply.
const groqText = (text) => json({ choices: [{ message: { content: text } }] });

const gemini429 = () => json({ error: { message: "quota exceeded" } }, 429);

const originalFetch = globalThis.fetch;
let calls = []; // { url, body } — body is the raw init.body string

function route({ gemini, groq }) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, body: init?.body });
    if (u.includes(GEMINI)) return gemini(u, init);
    if (u.includes(GROQ)) return groq(u, init);
    throw new Error(`unexpected fetch: ${u}`);
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const geminiCalls = () => calls.filter((c) => c.url.includes(GEMINI));
const groqCalls = () => calls.filter((c) => c.url.includes(GROQ));
const geminiBody = () => JSON.parse(geminiCalls()[0].body);

const base = {
  apiKey: "test-key",
  model: "gemini-flash-latest",
  questions,
  mode: "solve",
  history: [{ role: "user", content: "Hi" }],
};

test("Gemini success → text reply + provider Gemini", async () => {
  route({
    gemini: () => geminiText(GEMINI_REPLY),
    groq: () => {
      throw new Error("Groq must not be called on Gemini success");
    },
  });

  const res = await chat(base);

  assert.equal(res.provider, "Gemini", `got ${JSON.stringify(res)}`);
  assert.equal(
    res.reply,
    GEMINI_REPLY,
    `expected { reply, provider }; got keys [${Object.keys(res).join(", ")}] = ${JSON.stringify(res)}`
  );
  assert.equal(groqCalls().length, 0, "Groq was called despite Gemini succeeding");
});

test("Gemini 429 + groqKey set → falls back to Groq", async () => {
  route({ gemini: gemini429, groq: () => groqText(GROQ_REPLY) });

  const res = await chat({
    ...base,
    groqKey: "gsk_test",
    groqModel: "llama-3.3-70b-versatile",
  });

  assert.match(res.provider, /Groq/, `expected Groq in provider, got ${JSON.stringify(res)}`);
  assert.equal(groqCalls().length, 1, "should call Groq exactly once");
});

test("hints mode → tutoring system prompt, not solve option-id prompt", async () => {
  route({
    gemini: () => geminiText(GEMINI_REPLY),
    groq: () => {
      throw new Error("Groq must not be called on Gemini success");
    },
  });

  await chat({ ...base, mode: "hints" });

  const sys = JSON.stringify(geminiBody().systemInstruction);
  assert.match(sys, /tutoring|approach/i, `hints system prompt missing tutoring tone: ${sys}`);
  assert.doesNotMatch(
    sys,
    /option ids you believe are correct/i,
    "hints mode reused the solve prompt"
  );
});

test("history passed through → request body includes prior user turns", async () => {
  const history = [
    { role: "user", content: "HISTORY_USER_MARKER what is a mutex?" },
    { role: "assistant", content: "HISTORY_MODEL_MARKER a lock around shared state." },
    { role: "user", content: "current follow-up" },
  ];
  route({
    gemini: () => geminiText(GEMINI_REPLY),
    groq: () => {
      throw new Error("Groq must not be called on Gemini success");
    },
  });

  await chat({ ...base, history });

  const raw = geminiCalls()[0].body;
  assert.match(raw, /HISTORY_USER_MARKER/, "prior user turn missing from request body");
  assert.match(raw, /HISTORY_MODEL_MARKER/, "prior model turn missing from request body");
});

test("focus mode with an image question → image rides on the final user turn", async () => {
  const focused = [
    {
      ...questions[0],
      prompt: "[Question image]",
      images: [{ mime: "image/png", data: "aGVsbG8=" }],
    },
  ];
  route({
    gemini: () => geminiText(GEMINI_REPLY),
    groq: () => {
      throw new Error("Groq must not be called on Gemini success");
    },
  });

  await chat({ ...base, questions: focused });

  const contents = geminiBody().contents;
  const last = contents[contents.length - 1];
  assert.equal(last.role, "user");
  assert.ok(
    last.parts.some((p) => p.inline_data?.mime_type === "image/png"),
    `image missing from final turn: ${JSON.stringify(last.parts)}`
  );
});

test("multi-question context → no images re-sent (text summary only)", async () => {
  const both = [
    { ...questions[0], images: [{ mime: "image/png", data: "aGVsbG8=" }] },
    { ...questions[0], qid: "q2", images: [{ mime: "image/png", data: "aGVsbG8=" }] },
  ];
  route({
    gemini: () => geminiText(GEMINI_REPLY),
    groq: () => {
      throw new Error("Groq must not be called on Gemini success");
    },
  });

  await chat({ ...base, questions: both });

  const raw = geminiCalls()[0].body;
  assert.doesNotMatch(raw, /inline_data/, "whole-list chat must stay text-only");
});
