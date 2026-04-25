(() => {
  if (window.top !== window || document.getElementById("helpa-root")) {
    return;
  }

  const MAX_HISTORY = 5;
  let selectedContext = "";
  const sessionHistory = [];

  const root = document.createElement("div");
  root.id = "helpa-root";
  root.innerHTML = `
    <button class="helpa-fab" type="button" aria-label="Open HelpA">
      <span class="helpa-fab__label">H</span>
    </button>
    <button class="helpa-selection-chip" type="button" hidden>Ask HelpA</button>
    <section class="helpa-panel" aria-hidden="true">
      <div class="helpa-panel__scroll">
        <header class="helpa-panel__header">
          <div>
            <p class="helpa-eyebrow">HelpA</p>
            <h2 class="helpa-title">Quick AI answer</h2>
          </div>
          <button class="helpa-close" type="button" aria-label="Close HelpA">&times;</button>
        </header>

        <label class="helpa-label" for="helpa-query">Ask about a word, line, or idea</label>
        <textarea
          id="helpa-query"
          class="helpa-input"
          rows="3"
          placeholder="Example: what is api"
        ></textarea>
        <p class="helpa-context" hidden></p>

        <div class="helpa-actions">
          <button class="helpa-search" type="button">Search</button>
          <button class="helpa-fill" type="button">Use selected text</button>
        </div>

        <div class="helpa-status" role="status" aria-live="polite"></div>
        <article class="helpa-result">
          <p class="helpa-result__empty">Your short answer will show here.</p>
        </article>
      </div>
    </section>
  `;

  document.documentElement.appendChild(root);

  const fab = root.querySelector(".helpa-fab");
  const panel = root.querySelector(".helpa-panel");
  const selectionChip = root.querySelector(".helpa-selection-chip");
  const closeButton = root.querySelector(".helpa-close");
  const searchButton = root.querySelector(".helpa-search");
  const fillButton = root.querySelector(".helpa-fill");
  const queryInput = root.querySelector(".helpa-input");
  const statusBox = root.querySelector(".helpa-status");
  const resultBox = root.querySelector(".helpa-result");
  const contextBox = root.querySelector(".helpa-context");

  chrome.runtime.sendMessage({ type: "helpa:getConfigStatus" }, () => {
    setStatus("Ready. Tip: press Alt+H to open HelpA.", "neutral");
  });

  fab.addEventListener("click", togglePanel);
  closeButton.addEventListener("click", closePanel);
  selectionChip.addEventListener("click", () => {
    openPanel();
    captureSelection(true);
  });
  fillButton.addEventListener("click", () => {
    captureSelection(true);
  });
  searchButton.addEventListener("click", () => runSearch());

  queryInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      runSearch();
    }
  });

  document.addEventListener("selectionchange", () => {
    updateSelectionState();
  });

  document.addEventListener("keydown", (event) => {
    if (event.altKey && event.key.toLowerCase() === "h") {
      if (isTypingTarget(event.target)) {
        return;
      }
      event.preventDefault();
      togglePanel();
    }
  });

  function togglePanel() {
    if (panel.classList.contains("is-open")) {
      closePanel();
      return;
    }

    openPanel();
  }

  function openPanel() {
    panel.classList.add("is-open");
    panel.setAttribute("aria-hidden", "false");
    captureSelection(false);
    queryInput.focus();
  }

  function closePanel() {
    panel.classList.remove("is-open");
    panel.setAttribute("aria-hidden", "true");
  }

  function updateSelectionState() {
    const text = getPageSelectionText();

    if (!text) {
      selectionChip.hidden = true;
      if (panel.classList.contains("is-open")) {
        selectedContext = "";
        renderContext();
      }
      return;
    }

    selectedContext = text.slice(0, 900);
    renderContext();
    positionSelectionChip();
  }

  function captureSelection(forceReplaceQuery) {
    const text = getPageSelectionText() || selectedContext;

    if (!text) {
      if (forceReplaceQuery) {
        setStatus("Select text on the page first.", "error");
      }

      selectedContext = "";
      renderContext();
      return;
    }

    selectedContext = text.slice(0, 900);

    if (forceReplaceQuery && !queryInput.value.trim()) {
      queryInput.value = truncate(selectedContext, 220);
    }

    renderContext();
  }

  function getPageSelectionText() {
    const selection = window.getSelection();

    if (!selection || selection.rangeCount === 0) {
      return "";
    }

    const text = selection.toString().trim();
    if (!text) {
      return "";
    }

    const range = selection.getRangeAt(0);
    const container = range.commonAncestorContainer;
    const element =
      container instanceof Element ? container : container?.parentElement || null;

    if (element?.closest("#helpa-root")) {
      return "";
    }

    return text;
  }

  function renderContext() {
    if (!selectedContext) {
      contextBox.hidden = true;
      contextBox.textContent = "";
      return;
    }

    contextBox.hidden = false;
    contextBox.textContent = `Using selected text for context: "${truncate(selectedContext, 120)}"`;
  }

  function setStatus(message, tone = "neutral") {
    statusBox.textContent = message;
    statusBox.dataset.tone = tone;
  }

  function renderResult(payload) {
    const actionButtons = [
      `<button class="helpa-google" type="button" data-action="google">Open full Google search</button>`
    ];

    if (payload.presentation === "comparison") {
      resultBox.innerHTML = `
        <div class="helpa-result__card">
          <div class="helpa-result__topline">
            <p class="helpa-result__title">${escapeHtml(payload.title || payload.query)}</p>
            ${
              payload.sourceLabel
                ? `<span class="helpa-result__badge">${escapeHtml(payload.sourceLabel)}</span>`
                : ""
            }
          </div>
          <p class="helpa-result__text">${escapeHtml(payload.answer)}</p>
          <div class="helpa-compare">
            ${(payload.comparisonItems || [])
              .map(
                (item) => `
                  <section class="helpa-compare__card">
                    <h3 class="helpa-compare__label">${escapeHtml(item.label)}</h3>
                    <p class="helpa-compare__text">${escapeHtml(item.text)}</p>
                  </section>
                `
              )
              .join("")}
          </div>
          <div class="helpa-result__actions">${actionButtons.join("")}</div>
        </div>
      `;
    } else {
      resultBox.innerHTML = `
        <div class="helpa-result__card">
          <div class="helpa-result__topline">
            <p class="helpa-result__title">${escapeHtml(payload.title || payload.query)}</p>
            ${
              payload.sourceLabel
                ? `<span class="helpa-result__badge">${escapeHtml(payload.sourceLabel)}</span>`
                : ""
            }
          </div>
          <p class="helpa-result__text">${escapeHtml(payload.answer)}</p>
          <div class="helpa-result__actions">${actionButtons.join("")}</div>
        </div>
      `;
    }

    resultBox.querySelector('[data-action="google"]')?.addEventListener("click", () => {
      chrome.runtime.sendMessage({
        type: "helpa:openGoogleSearch",
        query: payload.query || queryInput.value.trim()
      });
    });
  }

  function renderError(message) {
    resultBox.innerHTML = `
      <div class="helpa-result__card helpa-result__card--error">
        <p class="helpa-result__text">${escapeHtml(message)}</p>
      </div>
    `;
  }

  function runSearch() {
    const query = queryInput.value.trim();

    if (!query) {
      setStatus("Type something first.", "error");
      return;
    }

    setStatus("Looking for a short answer...", "loading");
    resultBox.innerHTML = `
      <div class="helpa-loading">
        <span></span>
        <span></span>
        <span></span>
      </div>
    `;

    chrome.runtime.sendMessage(
      {
        type: "helpa:search",
        query,
        selectedText: selectedContext,
        pageText: getPageExcerpt(),
        pageTitle: document.title,
        pageUrl: window.location.href,
        mode: "auto",
        beginnerMode: false,
        targetLanguage: "ur",
        history: sessionHistory.map((item) => ({
          query: item.query,
          title: item.result.title
        }))
      },
      (response) => {
        if (chrome.runtime.lastError) {
          setStatus("HelpA could not reach its answer service.", "error");
          renderError(chrome.runtime.lastError.message);
          return;
        }

        if (!response?.ok) {
          setStatus("Search failed.", "error");
          renderError(response?.error || "Something went wrong.");
          return;
        }

        const result = response.result;
        setStatus(
          result.hasStrongAnswer ? "Short answer ready." : "No strong instant answer found.",
          result.hasStrongAnswer ? "success" : "neutral"
        );
        renderResult(result);
        pushHistory({
          query,
          result
        });
      }
    );
  }

  function pushHistory(entry) {
    sessionHistory.unshift(entry);
    if (sessionHistory.length > MAX_HISTORY) {
      sessionHistory.length = MAX_HISTORY;
    }
  }

  function positionSelectionChip() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || !selection.toString().trim()) {
      selectionChip.hidden = true;
      return;
    }

    const rect = selection.getRangeAt(0).getBoundingClientRect();
    if (!rect.width && !rect.height) {
      selectionChip.hidden = true;
      return;
    }

    selectionChip.hidden = false;
    selectionChip.style.left = `${Math.max(12, rect.left)}px`;
    selectionChip.style.top = `${Math.max(12, rect.bottom + 8)}px`;
  }

  function getPageExcerpt() {
    const container =
      document.querySelector("article") ||
      document.querySelector("main") ||
      document.body;

    const text = normalizeWhitespace(container?.innerText || "");
    return truncate(text, 1400);
  }

  function isTypingTarget(target) {
    return target instanceof HTMLElement &&
      (target.closest("input, textarea, [contenteditable='true']") !== null);
  }

  function truncate(value, maxLength) {
    if (value.length <= maxLength) {
      return value;
    }

    return `${value.slice(0, maxLength - 3).trim()}...`;
  }

  function normalizeWhitespace(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }
})();
