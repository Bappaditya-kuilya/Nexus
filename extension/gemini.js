/* Gemini client. Called from the sidepanel, which is an extension page and so is
 * exempt from page CORS given the host permission.
 *
 * ponytail: one API call, not two. The reference project needed an "extract" pass
 * because it shipped raw page HTML to the model; content.js already parses the
 * questions out of the DOM, so we only ask the model to answer them.
 */

const API = "https://generativelanguage.googleapis.com/v1beta";
const GROQ = "https://api.groq.com/openai/v1";

export const DEFAULT_MODEL = "gemini-3.1-flash-lite";
export const DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile";

// Gemini's responseSchema is an OpenAPI subset. Keep it flat.
const SCHEMA = {
  type: "object",
  properties: {
    answers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          qid: { type: "string" },
          oids: {
            type: "array",
            items: { type: "string" },
            description: "Chosen option ids. One for single_choice, one or more for multi_choice, empty for fill_blank.",
          },
          text: { type: "string", description: "Answer for fill_blank. Empty otherwise." },
          confidence: { type: "number", description: "0 to 1." },
          reasoning: { type: "string", description: "Two sentences at most." },
        },
        required: ["qid", "oids", "text", "confidence", "reasoning"],
      },
    },
  },
  required: ["answers"],
};

const SYSTEM = {
  solve: `You are answering questions from an online course assignment.
For every question return the option ids you believe are correct, plus a short reason and a calibrated confidence.
Echo back option ids exactly as given — never invent one. For multi_choice return every correct id, not just the best one.
For fill_blank put the answer in "text" and leave "oids" empty. Keep the answer terse: a number, word, or short phrase.
If you are genuinely unsure, still answer, but set confidence low and say why.`,

  hints: `You are tutoring a student on an online course assignment.
For every question, explain the approach in "reasoning" — the concept to apply and how to get there,
so the student can reason it out themselves. Leave "oids" empty and "text" empty: never pick an option
or give the final answer. Still give a calibrated confidence.`,
};

function friendlyError(status, body) {
  const msg = body?.error?.message || `HTTP ${status}`;
  if (status === 400 && /api.?key|invalid/i.test(msg))
    return "Gemini rejected that API key. Check it under Settings.";
  if (status === 403) return "This key can't reach the Gemini API. Enable it in Google AI Studio.";
  if (status === 404) return `Model not found. Pick another in Settings. (${msg})`;
  if (status === 429) return "Gemini rate-limited this key. Wait a few seconds and try again.";
  if (status >= 500) return "Gemini is overloaded right now. Try again in a moment.";
  return msg;
}

function groqFriendlyError(status, body) {
  const msg = body?.error?.message || `HTTP ${status}`;
  if (status === 401 || status === 403)
    return `Groq rejected that API key. Check it under Settings. (${msg})`;
  if (status === 404) return `Groq model not found. (${msg})`;
  if (status === 429) return "Groq rate-limited this key. Wait a few seconds and try again.";
  if (status >= 500) return "Groq is overloaded right now. Try again in a moment.";
  return msg;
}

async function call(url, init, retries = 1, friendly = friendlyError) {
  const res = await fetch(url, init);
  if (res.ok) return res.json();

  const body = await res.json().catch(() => null);
  // 429/5xx are the two that are actually worth a second shot.
  if (retries > 0 && (res.status === 429 || res.status >= 500)) {
    await new Promise((r) => setTimeout(r, 1500));
    return call(url, init, retries - 1, friendly);
  }
  throw new Error(friendly(res.status, body));
}

/** Models the key can actually use, newest-looking first. */
export async function listModels(apiKey) {
  const data = await call(`${API}/models?key=${encodeURIComponent(apiKey)}&pageSize=200`, {});
  return (data.models || [])
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
    .map((m) => m.name.replace(/^models\//, ""))
    .filter((n) => n.includes("gemini"))
    .sort();
}

/** The question JSON as plain text — shared by Gemini parts and the Groq text-only path. */
function userText(questions) {
  const compact = questions.map(({ qid, type, prompt, options }) => ({ qid, type, prompt, options }));
  return (
    `Assignment questions as JSON:\n\n${JSON.stringify(compact, null, 2)}\n\n` +
    `Answer all ${questions.length} question(s). Return one entry per qid.`
  );
}

function buildParts(questions) {
  const parts = [{ text: userText(questions) }];

  // Images ride along as inline data, tagged so the model can tie them to a question.
  for (const q of questions) {
    for (const img of q.images || []) {
      parts.push({ text: `Image belonging to ${q.qid}:` });
      parts.push({ inline_data: { mime_type: img.mime, data: img.data } });
    }
  }
  return parts;
}

/** Question context for the side chat: one question gets full detail,
 *  a page-wide list stays compact so "Q3" in the message maps to the card numbers. */
function questionsText(questions) {
  if (!questions.length) return "No question context yet.";
  if (questions.length === 1) {
    const q = questions[0];
    const detail = { qid: q.qid, type: q.type, prompt: q.prompt, options: q.options };
    return `Question in focus:\n${JSON.stringify(detail, null, 2)}`;
  }
  return (
    "Assignment questions:\n" +
    questions.map((q, i) => `Q${i + 1} [${q.qid}]: ${q.prompt}`).join("\n")
  );
}

/** Fallback: OpenAI-compatible chat, text-only (image questions lose images on fallback). */
async function groqSolve({ groqKey, groqModel, questions, mode }) {
  const data = await call(
    `${GROQ}/chat/completions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${groqKey}` },
      body: JSON.stringify({
        model: groqModel || DEFAULT_GROQ_MODEL,
        messages: [
          { role: "system", content: SYSTEM[mode] || SYSTEM.solve },
          { role: "user", content: userText(questions) },
        ],
        response_format: { type: "json_object" },
      }),
    },
    1,
    groqFriendlyError
  );

  const text = data.choices?.[0]?.message?.content || "";
  if (!text) throw new Error("Groq returned an empty response.");

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Groq returned malformed JSON.");
  }

  const known = new Set(questions.map((q) => q.qid));
  return (parsed.answers || []).filter((a) => known.has(a.qid));
}

export async function solve({
  apiKey,
  model = DEFAULT_MODEL,
  questions,
  mode = "solve",
  groqKey = "",
  groqModel = DEFAULT_GROQ_MODEL,
}) {
  if (!apiKey && !groqKey) throw new Error("No Gemini API key set. Add one under Settings.");
  if (!questions?.length) throw new Error("No questions to answer.");

  // ponytail: no temperature — it's deprecated on current models and the response
  // schema already pins the shape.
  try {
    if (!apiKey) throw new Error("No Gemini API key set.");

    const body = {
      systemInstruction: { parts: [{ text: SYSTEM[mode] || SYSTEM.solve }] },
      contents: [{ role: "user", parts: buildParts(questions) }],
      generationConfig: { responseMimeType: "application/json", responseSchema: SCHEMA },
    };

    const data = await call(
      `${API}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );

    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
    if (!text) {
      const why = data.candidates?.[0]?.finishReason;
      throw new Error(why ? `Gemini returned nothing (${why}).` : "Gemini returned an empty response.");
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("Gemini returned malformed JSON.");
    }

    // Drop anything referring to a question we didn't send.
    const known = new Set(questions.map((q) => q.qid));
    return {
      answers: (parsed.answers || []).filter((a) => known.has(a.qid)),
      provider: "Gemini",
    };
  } catch (geminiErr) {
    if (!groqKey) throw geminiErr;
    if (questions.some((q) => q.prompt === "[Question image]")) {
      throw new Error(
        `Gemini: ${geminiErr.message.replace(/\.$/, "")}. Groq can't read image-only questions (text-only fallback). Check the Gemini key under Settings.`,
        { cause: geminiErr }
      );
    }
    try {
      const answers = await groqSolve({ groqKey, groqModel, questions, mode });
      return { answers, provider: "Groq (Gemini down)" };
    } catch (groqErr) {
      throw new Error(
        `Gemini: ${geminiErr.message.replace(/\.$/, "")}. Groq: ${groqErr.message.replace(
          /\.$/,
          ""
        )}. Check keys under Settings.`,
        { cause: groqErr }
      );
    }
  }
}

/** Fallback for chat: OpenAI-compatible, plain text. */
async function groqChat({ sys, history, groqKey, groqModel }) {
  const data = await call(
    `${GROQ}/chat/completions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${groqKey}` },
      body: JSON.stringify({
        model: groqModel || DEFAULT_GROQ_MODEL,
        messages: [{ role: "system", content: sys }, ...history],
      }),
    },
    1,
    groqFriendlyError
  );
  const reply = data.choices?.[0]?.message?.content || "";
  if (!reply) throw new Error("Groq returned an empty response.");
  return reply;
}

/** Free-form side chat: plain text reply, not SCHEMA answers.
 *  Reuses SYSTEM[mode] for tone (hints = approach only). Last history entry must be the user's message. */
export async function chat({
  apiKey,
  model = DEFAULT_MODEL,
  groqKey = "",
  groqModel = DEFAULT_GROQ_MODEL,
  history = [],
  questions = [],
  mode = "solve",
}) {
  if (!apiKey && !groqKey) throw new Error("No Gemini API key set. Add one under Settings.");
  if (!history.length || history[history.length - 1].role !== "user")
    throw new Error("Chat history must end with the user's message.");

  const sys =
    (SYSTEM[mode] || SYSTEM.solve) +
    "\nThis is a free-form side chat about the assignment, not a schema request: " +
    "reply as plain conversational text, never JSON.\n" +
    questionsText(questions);

  try {
    if (!apiKey) throw new Error("No Gemini API key set.");

    const data = await call(
      `${API}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: sys }] },
          contents: history.map((m, i) => {
            const parts = [{ text: m.content }];
            // Focus mode only: re-sending every page image every turn would balloon tokens.
            if (i === history.length - 1 && questions.length === 1)
              for (const img of questions[0].images || []) {
                parts.push({ text: "Image belonging to this question:" });
                parts.push({ inline_data: { mime_type: img.mime, data: img.data } });
              }
            return { role: m.role === "assistant" ? "model" : "user", parts };
          }),
        }),
      }
    );

    const reply = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
    if (!reply) {
      const why = data.candidates?.[0]?.finishReason;
      throw new Error(why ? `Gemini returned nothing (${why}).` : "Gemini returned an empty response.");
    }
    return { reply, provider: "Gemini" };
  } catch (geminiErr) {
    if (!groqKey) throw geminiErr;
    try {
      const reply = await groqChat({ sys, history, groqKey, groqModel });
      return { reply, provider: "Groq (Gemini down)" };
    } catch (groqErr) {
      throw new Error(
        `Gemini: ${geminiErr.message.replace(/\.$/, "")}. Groq: ${groqErr.message.replace(
          /\.$/,
          ""
        )}. Check keys under Settings.`,
        { cause: groqErr }
      );
    }
  }
}