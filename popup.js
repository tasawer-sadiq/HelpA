const queryInput = document.getElementById("popup-query");
const searchButton = document.getElementById("popup-search");
const googleButton = document.getElementById("popup-google");
const settingsButton = document.getElementById("popup-settings");
const statusBox = document.getElementById("popup-status");
const resultBox = document.getElementById("popup-result");
const modeButtons = Array.from(document.querySelectorAll(".popup__mode"));
const beginnerCheckbox = document.getElementById("popup-beginner");
const languageWrap = document.getElementById("popup-language-wrap");
const languageSelect = document.getElementById("popup-language");

let currentMode = "auto";

searchButton.addEventListener("click", search);
googleButton.addEventListener("click", () => {
  const query = queryInput.value.trim();

  if (!query) {
    statusBox.textContent = "Type something first.";
    return;
  }

  chrome.runtime.sendMessage({
    type: "helpa:openGoogleSearch",
    query
  });
});

settingsButton.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "helpa:openOptions" });
});

queryInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    search();
  }
});

modeButtons.forEach((button) => {
  button.addEventListener("click", () => setMode(button.dataset.mode));
});

function setMode(mode) {
  currentMode = mode || "auto";
  modeButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.mode === currentMode);
  });
  languageWrap.hidden = currentMode !== "translate";
}

function search() {
  const query = queryInput.value.trim();

  if (!query && currentMode !== "translate" && currentMode !== "summarize") {
    statusBox.textContent = "Type something first.";
    return;
  }

  statusBox.textContent = "Looking for a short answer...";
  resultBox.innerHTML = `<p class="popup__placeholder">Looking for a short answer...</p>`;

  chrome.runtime.sendMessage(
    {
      type: "helpa:search",
      query,
      pageTitle: "",
      pageUrl: "",
      mode: currentMode,
      beginnerMode: beginnerCheckbox.checked,
      targetLanguage: languageSelect.value
    },
    (response) => {
      if (chrome.runtime.lastError) {
        statusBox.textContent = "Search failed.";
        renderError(chrome.runtime.lastError.message);
        return;
      }

      if (!response?.ok) {
        statusBox.textContent = "Search failed.";
        renderError(response?.error || "Something went wrong.");
        return;
      }

      const result = response.result;
      statusBox.textContent = result.hasStrongAnswer
        ? "Short answer ready."
        : "No strong instant answer found.";

      renderResult(result);
    }
  );
}

function getBadgeClass(sourceLabel) {
  const label = (sourceLabel || "").toLowerCase();
  if (label.includes("duckduckgo")) return "popup__badge popup__badge--duckduckgo";
  if (label.includes("wikipedia"))  return "popup__badge popup__badge--wikipedia";
  if (label.includes("dictionary")) return "popup__badge popup__badge--dictionary";
  if (label.includes("datamuse"))   return "popup__badge popup__badge--datamuse";
  return "popup__badge";
}

function renderResult(result) {
  const actionButtons = [
    `<button class="popup__google" type="button" data-action="google">Open full Google search</button>`
  ];

  const badgeHtml = result.sourceLabel
    ? `<span class="${getBadgeClass(result.sourceLabel)}">${escapeHtml(result.sourceLabel)}</span>`
    : "";

  if (result.presentation === "comparison") {
    resultBox.innerHTML = `
      <article class="popup__card ${result.mode === "fallback" ? "popup__card--error" : ""}">
        <div class="popup__topline">
          <p class="popup__card-title">${escapeHtml(result.title || result.query)}</p>
          ${badgeHtml}
        </div>
        <p class="popup__card-text">${escapeHtml(result.answer)}</p>
        <div class="popup__compare">
          ${(result.comparisonItems || [])
            .map(
              (item) => `
                <section class="popup__compare-card">
                  <h3 class="popup__compare-label">${escapeHtml(item.label)}</h3>
                  <p class="popup__compare-text">${escapeHtml(item.text)}</p>
                </section>
              `
            )
            .join("")}
        </div>
        <div class="popup__card-actions">${actionButtons.join("")}</div>
      </article>
    `;
  } else {
    resultBox.innerHTML = `
      <article class="popup__card ${result.mode === "fallback" ? "popup__card--error" : ""}">
        <div class="popup__topline">
          <p class="popup__card-title">${escapeHtml(result.title || result.query)}</p>
          ${badgeHtml}
        </div>
        <p class="popup__card-text">${escapeHtml(result.answer)}</p>
        <div class="popup__card-actions">${actionButtons.join("")}</div>
      </article>
    `;
  }

  resultBox.querySelector('[data-action="google"]')?.addEventListener("click", () => {
    chrome.runtime.sendMessage({
      type: "helpa:openGoogleSearch",
      query: result.query
    });
  });
}

function renderError(message) {
  resultBox.innerHTML = `
    <article class="popup__card popup__card--error">
      <p class="popup__card-text">${escapeHtml(message)}</p>
    </article>
  `;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
