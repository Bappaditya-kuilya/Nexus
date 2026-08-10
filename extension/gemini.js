/* Gemini client. Called from the sidepanel, which is an extension page and so is
 * exempt from page CORS given the host permission.
 *
 * ponytail: one API call, not two. The reference project needed an "extract" pass
 * because it shipped raw page HTML to the model; content.js already parses the
 * questions out of the DOM, so we only ask the model to answer them.
 */

const API = "https://generativelanguage.googleapis.com/v1beta";

export const DEFAULT_MODEL = "gemini-flash-latest";

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
For every question, work out the answer but explain the approach in "reasoning" — the concept to apply and how to get there,
so the student can reason it out themselves. Still fill in "oids"/"text" and a calibrated confidence, since the student may
choose to reveal them. Echo back option ids exactly as given.`,
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

async function call(url, init, retries = 1) {
  const res = await fetch(url, init);
  if (res.ok) return res.json();

  const body = await res.json().catch(() => null);
  // 429/5xx are the two that are actually worth a second shot.
  if (retries > 0 && (res.status === 429 || res.status >= 500)) {
    await new Promise((r) => setTimeout(r, 1500));
    return call(url, init, retries - 1);
  }
  throw new Error(friendlyError(res.status, body));
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

function buildParts(questions) {
  const compact = questions.map(({ qid, type, prompt, options }) => ({ qid, type, prompt, options }));
  const parts = [
    {
      text:
        `Assignment questions as JSON:\n\n${JSON.stringify(compact, null, 2)}\n\n` +
        `Answer all ${questions.length} question(s). Return one entry per qid.`,
    },
  ];

  // Images ride along as inline data, tagged so the model can tie them to a question.
  for (const q of questions) {
    for (const img of q.images || []) {
      parts.push({ text: `Image belonging to ${q.qid}:` });
      parts.push({ inline_data: { mime_type: img.mime, data: img.data } });
    }
  }
  return parts;
}

export async function solve({ apiKey, model = DEFAULT_MODEL, questions, mode = "solve" }) {
  if (!apiKey) throw new Error("No Gemini API key set. Add one under Settings.");
  if (!questions?.length) throw new Error("No questions to answer.");

  // ponytail: no temperature — it's deprecated on current models and the response
  // schema already pins the shape.
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
  return (parsed.answers || []).filter((a) => known.has(a.qid));
}
