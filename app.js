/* global pdfjsLib */

const STORAGE = {
  PROVIDER: "shugyo-provider",
  API_KEY: "shugyo-api-key",
  MODEL: "shugyo-model",
  API_URL: "shugyo-api-url",
};

const PROVIDERS = {
  google: {
    defaultModel: "gemini-2.0-flash",
    keyPlaceholder: "AIza...",
    hint: 'Google AI Studio（<a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com</a>）で無料のAPIキーを取得できます。キーはお使いのPCのブラウザにのみ保存されます。',
  },
  openai: {
    defaultModel: "gpt-4o-mini",
    keyPlaceholder: "sk-...",
    hint: "OpenAIのAPIキーを入力してください。キーはお使いのPCのブラウザにのみ保存されます。",
  },
};

const DEFAULT_API_URL = "https://api.openai.com/v1/chat/completions";
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const CHUNK_SIZE = 600;
const CHUNK_OVERLAP = 80;
const TOP_K = 5;
const PDF_PARSE_TIMEOUT_MS = 90000;

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const state = {
  docText: "",
  chunks: [],
  fileName: "",
  pageCount: 0,
  isProcessing: false,
};

const els = {
  uploadZone: $("#uploadZone"),
  fileInput: $("#fileInput"),
  docInfo: $("#docInfo"),
  docName: $("#docName"),
  docMeta: $("#docMeta"),
  btnClearDoc: $("#btnClearDoc"),
  chatMessages: $("#chatMessages"),
  chatForm: $("#chatForm"),
  questionInput: $("#questionInput"),
  btnSend: $("#btnSend"),
  provider: $("#provider"),
  apiKey: $("#apiKey"),
  model: $("#model"),
  apiUrl: $("#apiUrl"),
  apiUrlField: $("#apiUrlField"),
  settingsHint: $("#settingsHint"),
  btnSaveSettings: $("#btnSaveSettings"),
  sampleQuestions: $("#sampleQuestions"),
};

// ===== 設定 =====
function getProviderConfig(provider) {
  return PROVIDERS[provider] || PROVIDERS.google;
}

function applyProviderUI(provider) {
  const config = getProviderConfig(provider);
  els.apiKey.placeholder = config.keyPlaceholder;
  els.settingsHint.innerHTML = config.hint;
  els.apiUrlField.classList.toggle("hidden", provider !== "openai");
}

function loadSettings() {
  const provider = localStorage.getItem(STORAGE.PROVIDER) || "google";
  els.provider.value = provider;
  els.apiKey.value = localStorage.getItem(STORAGE.API_KEY) || "";
  els.model.value = localStorage.getItem(STORAGE.MODEL) || getProviderConfig(provider).defaultModel;
  els.apiUrl.value = localStorage.getItem(STORAGE.API_URL) || "";
  applyProviderUI(provider);
}

function saveSettings() {
  const provider = els.provider.value;
  const defaultModel = getProviderConfig(provider).defaultModel;
  localStorage.setItem(STORAGE.PROVIDER, provider);
  localStorage.setItem(STORAGE.API_KEY, els.apiKey.value.trim());
  localStorage.setItem(STORAGE.MODEL, els.model.value.trim() || defaultModel);
  localStorage.setItem(STORAGE.API_URL, els.apiUrl.value.trim());
  showToast("設定を保存しました");
}

function getApiConfig() {
  const provider = els.provider.value || localStorage.getItem(STORAGE.PROVIDER) || "google";
  const providerConfig = getProviderConfig(provider);
  return {
    provider,
    apiKey: els.apiKey.value.trim() || localStorage.getItem(STORAGE.API_KEY) || "",
    model: els.model.value.trim() || localStorage.getItem(STORAGE.MODEL) || providerConfig.defaultModel,
    apiUrl: els.apiUrl.value.trim() || localStorage.getItem(STORAGE.API_URL) || DEFAULT_API_URL,
  };
}

// ===== PDF =====
function withTimeout(promise, timeoutMs, timeoutMessage) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function extractTextFromPdf(file, onProgress) {
  const buffer = await file.arrayBuffer();
  let pdf;
  try {
    pdf = await withTimeout(
      pdfjsLib.getDocument({ data: buffer }).promise,
      PDF_PARSE_TIMEOUT_MS,
      "PDFの読み込みがタイムアウトしました。容量の小さいPDFでお試しください。"
    );
  } catch (err) {
    // CDNや拡張機能でworkerがブロックされる環境向けフォールバック
    const message = String(err?.message || "");
    const shouldFallback =
      message.includes("worker") ||
      message.includes("fetch") ||
      message.includes("network") ||
      message.includes("Unexpected server response") ||
      message.includes("timed out");
    if (!shouldFallback) {
      throw err;
    }
    appendBotMessage("PDFワーカーの読み込みに失敗したため、互換モードで再試行します。");
    pdf = await withTimeout(
      pdfjsLib.getDocument({ data: buffer, disableWorker: true }).promise,
      PDF_PARSE_TIMEOUT_MS,
      "PDFの読み込みがタイムアウトしました。別のブラウザまたは軽量なPDFでお試しください。"
    );
  }
  const pages = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await withTimeout(
      pdf.getPage(i),
      15000,
      `PDF ${i}ページ目の読み込みに時間がかかっています。`
    );
    const content = await withTimeout(
      page.getTextContent(),
      15000,
      `PDF ${i}ページ目の文字抽出に時間がかかっています。`
    );
    const text = content.items.map((item) => item.str).join(" ");
    pages.push(text);
    if (typeof onProgress === "function") {
      onProgress(i, pdf.numPages);
    }
  }

  return {
    text: pages.join("\n\n"),
    pageCount: pdf.numPages,
  };
}

function normalizeText(text) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function chunkText(text) {
  const chunks = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + CHUNK_SIZE, text.length);

    if (end < text.length) {
      const slice = text.slice(start, end);
      const breakAt = Math.max(slice.lastIndexOf("\n"), slice.lastIndexOf("。"));
      if (breakAt > CHUNK_SIZE * 0.4) {
        end = start + breakAt + 1;
      }
    }

    const chunk = text.slice(start, end).trim();
    if (chunk.length > 30) {
      chunks.push({ index: chunks.length + 1, text: chunk });
    }

    start = end - CHUNK_OVERLAP;
    if (start >= text.length - 30) break;
  }

  return chunks;
}

async function handlePdfUpload(file) {
  if (!file || file.type !== "application/pdf") {
    alert("PDFファイルを選択してください。");
    return;
  }

  setProcessing(true);
  try {
    appendBotMessage("PDFを解析中です。ページ数が多い場合は1〜2分かかることがあります。");
    const { text, pageCount } = await extractTextFromPdf(file, (current, total) => {
      els.docInfo.classList.remove("hidden");
      els.docName.textContent = file.name;
      els.docMeta.textContent = `読み込み中: ${current}/${total} ページ`;
    });
    const normalized = normalizeText(text);

    if (normalized.length < 50) {
      alert("PDFからテキストを読み取れませんでした。スキャン画像のみのPDFの場合は、OCR済み（文字検索できる）PDFをお試しください。");
      clearDocument();
      return;
    }

    state.docText = normalized;
    state.chunks = chunkText(normalized);
    state.fileName = file.name;
    state.pageCount = pageCount;

    els.uploadZone.classList.add("loaded");
    els.docInfo.classList.remove("hidden");
    els.docName.textContent = state.fileName;
    els.docMeta.textContent = `${state.pageCount}ページ · ${state.chunks.length}セクションに分割済み`;

    enableChat(true);
    clearWelcomeIfNeeded();
    appendBotMessage(`「${state.fileName}」を読み込みました。就業規則について質問してください。`);
  } catch (err) {
    console.error(err);
    alert(`PDFの読み込みに失敗しました。\n${err.message}`);
    clearDocument();
  } finally {
    setProcessing(false);
  }
}

function clearDocument() {
  state.docText = "";
  state.chunks = [];
  state.fileName = "";
  state.pageCount = 0;
  els.fileInput.value = "";
  els.uploadZone.classList.remove("loaded");
  els.docInfo.classList.add("hidden");
  enableChat(false);
}

// ===== 検索（RAG） =====
const STOP_WORDS = new Set([
  "は", "が", "を", "に", "の", "で", "と", "も", "か", "な", "て", "た", "です", "ます",
  "ある", "いる", "する", "ない", "この", "その", "どの", "何", "教えて", "ください", "知りたい",
]);

function tokenizeJapanese(text) {
  const tokens = new Set();

  const words = text.match(/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]{2,}|[a-zA-Z0-9]{2,}/g) || [];
  for (const w of words) {
    if (!STOP_WORDS.has(w)) tokens.add(w.toLowerCase());
  }

  for (let i = 0; i < text.length - 1; i++) {
    const bi = text.slice(i, i + 2);
    if (/[\u4E00-\u9FFF]{2}/.test(bi)) tokens.add(bi);
  }

  return [...tokens];
}

function retrieveRelevantChunks(question, k = TOP_K) {
  const tokens = tokenizeJapanese(question);
  const qLower = question.toLowerCase();

  const scored = state.chunks.map((chunk) => {
    const cLower = chunk.text.toLowerCase();
    let score = 0;

    for (const token of tokens) {
      if (cLower.includes(token)) score += token.length >= 3 ? 3 : 1;
    }

    if (cLower.includes(qLower.slice(0, Math.min(qLower.length, 12)))) score += 5;

    return { ...chunk, score };
  });

  return scored
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

// ===== AI =====
const SYSTEM_PROMPT = `あなたは会社の就業規則に詳しい人事アシスタントです。
以下のルールを厳守してください：

1. 回答は必ず「提供された就業規則の抜粋」の内容に基づいてください
2. 抜粋に記載がない場合は「就業規則に該当する記載が見つかりませんでした。人事部にお問い合わせください」と答えてください
3. 推測や一般的な法律知識だけで答えないでください
4. わかりやすい日本語で、箇条書きを適宜使って簡潔に答えてください
5. 重要な数値（日数、時間、期限など）は抜粋どおり正確に伝えてください`;

function buildUserPrompt(question, contextChunks) {
  const context = contextChunks
    .map((c, i) => `【抜粋${i + 1}】\n${c.text}`)
    .join("\n\n");
  return `就業規則の抜粋:\n\n${context}\n\n---\n\n質問: ${question}`;
}

async function askGemini(apiKey, model, userPrompt) {
  const url = `${GEMINI_API_BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      generationConfig: { temperature: 0.2 },
    }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error?.message || `Gemini APIエラー (${response.status})`);
  }

  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("")?.trim();
  if (!text) {
    throw new Error("Geminiから回答を取得できませんでした。");
  }
  return text;
}

async function askOpenAI(apiKey, model, apiUrl, userPrompt) {
  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
    }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error?.message || `OpenAI APIエラー (${response.status})`);
  }

  return data.choices[0].message.content.trim();
}

async function askAI(question, contextChunks) {
  const { provider, apiKey, model, apiUrl } = getApiConfig();

  if (!apiKey) {
    const serviceName = provider === "google" ? "Google AI Studio" : "OpenAI";
    throw new Error(`APIキーが設定されていません。左パネルの「API設定」から${serviceName}のAPIキーを入力してください。`);
  }

  const userPrompt = buildUserPrompt(question, contextChunks);

  if (provider === "google") {
    return askGemini(apiKey, model, userPrompt);
  }
  return askOpenAI(apiKey, model, apiUrl, userPrompt);
}

// ===== チャット UI =====
function enableChat(enabled) {
  els.questionInput.disabled = !enabled;
  els.btnSend.disabled = !enabled;
  $$(".chip").forEach((btn) => (btn.disabled = !enabled));
}

function clearWelcomeIfNeeded() {
  const welcome = els.chatMessages.querySelector(".welcome");
  if (welcome) welcome.remove();
}

function appendUserMessage(text) {
  clearWelcomeIfNeeded();
  const el = document.createElement("div");
  el.className = "message user";
  el.innerHTML = `<div class="message-bubble">${escapeHtml(text)}</div>`;
  els.chatMessages.appendChild(el);
  scrollToBottom();
}

function appendBotMessage(text, sources = []) {
  const el = document.createElement("div");
  el.className = "message bot";

  let sourcesHtml = "";
  if (sources.length > 0) {
    const items = sources
      .map((s) => `<div class="source-item">【${s.index}】${escapeHtml(truncate(s.text, 120))}</div>`)
      .join("");
    sourcesHtml = `
      <details class="message-sources">
        <summary>参照した規則の抜粋（${sources.length}件）</summary>
        <div class="source-list">${items}</div>
      </details>`;
  }

  el.innerHTML = `
    <div class="message-bubble">${escapeHtml(text)}</div>
    ${sourcesHtml}`;
  els.chatMessages.appendChild(el);
  scrollToBottom();
  return el;
}

function appendLoading() {
  const el = document.createElement("div");
  el.className = "message bot loading";
  el.id = "loadingMsg";
  el.innerHTML = `<div class="message-bubble"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>`;
  els.chatMessages.appendChild(el);
  scrollToBottom();
}

function removeLoading() {
  $("#loadingMsg")?.remove();
}

function scrollToBottom() {
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function truncate(str, len) {
  return str.length <= len ? str : str.slice(0, len) + "…";
}

function showToast(msg) {
  appendBotMessage(msg);
}

async function handleQuestion(question) {
  const q = question.trim();
  if (!q || state.isProcessing) return;
  if (!state.chunks.length) {
    alert("先に就業規則のPDFをアップロードしてください。");
    return;
  }

  state.isProcessing = true;
  els.btnSend.disabled = true;
  appendUserMessage(q);
  appendLoading();

  try {
    const relevant = retrieveRelevantChunks(q);
    const chunks = relevant.length > 0 ? relevant : state.chunks.slice(0, 3);

    const answer = await askAI(q, chunks);
    removeLoading();
    appendBotMessage(answer, chunks);
  } catch (err) {
    removeLoading();
    appendBotMessage(`⚠️ ${err.message}`);
  } finally {
    state.isProcessing = false;
    els.btnSend.disabled = false;
    els.questionInput.focus();
  }
}

function setProcessing(busy) {
  state.isProcessing = busy;
  els.uploadZone.style.opacity = busy ? "0.5" : "1";
  els.uploadZone.style.pointerEvents = busy ? "none" : "auto";
}

// ===== イベント =====
els.uploadZone.addEventListener("click", () => els.fileInput.click());

els.fileInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) handlePdfUpload(file);
});

els.uploadZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  els.uploadZone.classList.add("dragover");
});
els.uploadZone.addEventListener("dragleave", () => els.uploadZone.classList.remove("dragover"));
els.uploadZone.addEventListener("drop", (e) => {
  e.preventDefault();
  els.uploadZone.classList.remove("dragover");
  const file = e.dataTransfer.files[0];
  if (file) handlePdfUpload(file);
});

els.btnClearDoc.addEventListener("click", () => {
  if (confirm("PDFを差し替えますか？チャット履歴は残ります。")) {
    clearDocument();
  }
});

els.chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const q = els.questionInput.value;
  els.questionInput.value = "";
  els.questionInput.style.height = "auto";
  handleQuestion(q);
});

els.questionInput.addEventListener("input", () => {
  els.questionInput.style.height = "auto";
  els.questionInput.style.height = Math.min(els.questionInput.scrollHeight, 120) + "px";
});

els.questionInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    els.chatForm.requestSubmit();
  }
});

els.sampleQuestions.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (chip && !chip.disabled) handleQuestion(chip.dataset.q);
});

els.btnSaveSettings.addEventListener("click", saveSettings);

els.provider.addEventListener("change", () => {
  const provider = els.provider.value;
  applyProviderUI(provider);
  els.model.value = getProviderConfig(provider).defaultModel;
});

loadSettings();
