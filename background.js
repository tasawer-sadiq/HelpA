const DUCKDUCKGO_API_URL = "https://api.duckduckgo.com/";
const DUCKDUCKGO_SEARCH_URL = "https://html.duckduckgo.com/html/";
const DATAMUSE_API_URL = "https://api.datamuse.com/words";
const DICTIONARY_API_URL = "https://api.dictionaryapi.dev/api/v2/entries/en/";
const WIKIPEDIA_SEARCH_URL = "https://en.wikipedia.org/w/api.php";
const WIKIPEDIA_SUMMARY_URL = "https://en.wikipedia.org/api/rest_v1/page/summary/";
const MYMEMORY_TRANSLATE_URL = "https://api.mymemory.translated.net/get";
// Search priority: DuckDuckGo (instant API) → DuckDuckGo (web search) → Dictionary → Wikipedia

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "helpa:search") {
    handleSearch(message)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Search failed."
        })
      );

    return true;
  }

  if (message?.type === "helpa:getConfigStatus") {
    sendResponse({
      ok: true,
      config: {
        hasApiKey: true,
        provider: "free-hybrid"
      }
    });
    return false;
  }

  if (message?.type === "helpa:openGoogleSearch") {
    chrome.tabs.create({
      url: `https://www.google.com/search?q=${encodeURIComponent(message.query || "")}`
    });
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "helpa:openOptions") {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

async function handleSearch(message) {
  const rawQuery = normalizeWhitespace(message?.query || "");
  const selectedText = normalizeWhitespace(message?.selectedText || "");
  const pageText = normalizeWhitespace(message?.pageText || "");
  const pageTitle = normalizeWhitespace(message?.pageTitle || "");
  const history = Array.isArray(message?.history) ? message.history : [];
  const mode = normalizeWhitespace(message?.mode || "auto").toLowerCase();
  const beginnerMode = Boolean(message?.beginnerMode) || mode === "simple";
  const targetLanguage = normalizeWhitespace(message?.targetLanguage || "ur").toLowerCase();

  const introQuery = rawQuery || selectedText;
  const introResult = getBuiltInIntroAnswer(introQuery);
  if (introResult) {
    return {
      ...introResult,
      query: rawQuery || introQuery,
      hasStrongAnswer: true
    };
  }

  const queryInfo = analyzeQuery({
    rawQuery,
    selectedText,
    pageText,
    pageTitle,
    mode,
    history
  });

  if (!queryInfo.fullQuery && queryInfo.kind !== "summary" && queryInfo.kind !== "translate") {
    throw new Error("Type something first.");
  }

  if (queryInfo.kind === "translate") {
    const translated = await getTranslationAnswer({
      text: queryInfo.topicOrContext,
      targetLanguage
    });

    if (translated) {
      return {
        ...translated,
        query: rawQuery || queryInfo.topicOrContext,
        hasStrongAnswer: true
      };
    }
  }

  const strategies = buildStrategies(queryInfo);
  const settled = await Promise.allSettled(strategies);
  const successes = settled
    .filter((item) => item.status === "fulfilled" && item.value?.answer)
    .map((item) => item.value);

  const ranked = rankAnswers(queryInfo, successes, beginnerMode);
  const best = ranked[0];

  if (!best) {
    return {
      query: queryInfo.fullQuery || rawQuery,
      title: suggestTitleFromQuery(rawQuery || queryInfo.topicOrContext || "HelpA"),
      answer:
        "I could not find a strong short answer for that. Try a clearer phrase, or open the full Google search.",
      mode: "fallback",
      sourceLabel: "Fallback",
      hasStrongAnswer: false
    };
  }

  return {
    ...best,
    query: queryInfo.fullQuery || rawQuery,
    hasStrongAnswer: true
  };
}

function buildStrategies(queryInfo) {
  const strategies = [];

  if (queryInfo.kind === "synonym") {
    // Priority: Datamuse > Dictionary > DuckDuckGo instant
    strategies.push(getDatamuseSynonyms(queryInfo.coreTerm));
    strategies.push(getDictionaryEntry(queryInfo.coreTerm));
    strategies.push(getDuckDuckGoAnswer(queryInfo.fullQuery));
    return strategies;
  }

  if (queryInfo.kind === "definition") {
    // Priority: Dictionary > DuckDuckGo instant > DuckDuckGo web > Wikipedia (last resort)
    strategies.push(getDictionaryEntry(queryInfo.coreTerm));
    strategies.push(getDuckDuckGoAnswer(queryInfo.fullQuery));
    strategies.push(getDuckDuckGoWebSearch(queryInfo.fullQuery));
    strategies.push(getWikipediaAnswer(queryInfo.topicOrContext));
    return strategies;
  }

  if (queryInfo.kind === "comparison") {
    strategies.push(getComparisonAnswer(queryInfo.comparisonTerms));
    strategies.push(getDuckDuckGoAnswer(queryInfo.fullQuery));
    strategies.push(getDuckDuckGoWebSearch(queryInfo.fullQuery));
    return strategies;
  }

  if (queryInfo.kind === "summary") {
    strategies.push(getSummaryAnswer(queryInfo.topicOrContext, queryInfo.pageTitle));
    strategies.push(getDuckDuckGoAnswer(queryInfo.fullQuery || queryInfo.topicOrContext));
    strategies.push(getWikipediaAnswer(queryInfo.topicOrContext));
    return strategies;
  }

  // General: DuckDuckGo instant → DuckDuckGo web search → Dictionary → Wikipedia
  strategies.push(getDuckDuckGoAnswer(queryInfo.fullQuery));
  strategies.push(getDuckDuckGoWebSearch(queryInfo.fullQuery));
  strategies.push(getDictionaryEntry(queryInfo.coreTerm));
  strategies.push(getWikipediaAnswer(queryInfo.topicOrContext));
  return strategies;
}

function analyzeQuery({ rawQuery, selectedText, pageText, pageTitle, mode, history }) {
  const fullQuery = normalizeWhitespace(resolveWithHistory(rawQuery, history));
  const lowered = fullQuery.toLowerCase();
  const contextText = selectedText || pageText;

  if (mode === "synonyms") {
    return {
      kind: "synonym",
      fullQuery: fullQuery || selectedText,
      coreTerm: extractCoreTerm(fullQuery || selectedText),
      topicOrContext: extractCoreTerm(fullQuery || selectedText)
    };
  }

  if (mode === "define" || mode === "simple") {
    return {
      kind: "definition",
      fullQuery: fullQuery || selectedText,
      coreTerm: extractCoreTerm(fullQuery || selectedText),
      topicOrContext: extractCoreTerm(fullQuery || selectedText)
    };
  }

  if (mode === "compare") {
    const explicitTerms = extractComparisonTerms(fullQuery || selectedText);
    return {
      kind: "comparison",
      fullQuery: fullQuery || selectedText,
      coreTerm: (explicitTerms || []).join(" "),
      comparisonTerms: explicitTerms || splitSelectedComparison(selectedText),
      topicOrContext: fullQuery || selectedText
    };
  }

  if (mode === "summarize") {
    return {
      kind: "summary",
      fullQuery: fullQuery || "summarize this page",
      coreTerm: pageTitle || "Page summary",
      topicOrContext: contextText || fullQuery || pageTitle,
      pageTitle
    };
  }

  if (mode === "translate") {
    return {
      kind: "translate",
      fullQuery: fullQuery || selectedText,
      coreTerm: fullQuery || selectedText,
      topicOrContext: selectedText || rawQuery
    };
  }

  if (isSynonymQuery(lowered)) {
    return {
      kind: "synonym",
      fullQuery,
      coreTerm: extractCoreTerm(fullQuery),
      topicOrContext: extractCoreTerm(fullQuery)
    };
  }

  const comparisonTerms = extractComparisonTerms(fullQuery);
  if (comparisonTerms) {
    return {
      kind: "comparison",
      fullQuery,
      coreTerm: comparisonTerms.join(" "),
      comparisonTerms,
      topicOrContext: fullQuery
    };
  }

  if (/^(what is|what are|who is|define|meaning of|explain)\b/i.test(lowered)) {
    return {
      kind: "definition",
      fullQuery,
      coreTerm: extractCoreTerm(fullQuery),
      topicOrContext: extractCoreTerm(fullQuery)
    };
  }

  if (/^(summarize|summary of)\b/i.test(lowered)) {
    return {
      kind: "summary",
      fullQuery,
      coreTerm: pageTitle || "Summary",
      topicOrContext: contextText || fullQuery.replace(/^(summarize|summary of)\s*/i, ""),
      pageTitle
    };
  }

  return {
    kind: "general",
    fullQuery,
    coreTerm: extractCoreTerm(fullQuery || selectedText || pageTitle),
    topicOrContext: extractCoreTerm(fullQuery || selectedText || pageTitle),
    pageTitle
  };
}

async function getDuckDuckGoAnswer(query) {
  const cleanQuery = normalizeWhitespace(query);

  if (!cleanQuery) {
    return null;
  }

  const url =
    `${DUCKDUCKGO_API_URL}?q=${encodeURIComponent(cleanQuery)}` +
    "&format=json&no_html=1&no_redirect=1&skip_disambig=0";

  try {
    const response = await fetch(url);

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    const answer = firstNonEmpty([
      data?.Answer,
      data?.AbstractText,
      data?.Definition,
      extractFirstRelatedTopic(data?.RelatedTopics)
    ]);

    if (!answer) {
      return null;
    }

    // Reject if the answer is clearly off-topic (doesn't mention key query tokens)
    const queryTokens = getMeaningfulTokens(cleanQuery);
    const answerLower = answer.toLowerCase();
    const titleLower = (data?.Heading || "").toLowerCase();
    const combinedHaystack = titleLower + " " + answerLower;
    if (queryTokens.length >= 2) {
      const matched = queryTokens.filter((t) => combinedHaystack.includes(t)).length;
      if (matched < Math.min(2, queryTokens.length)) {
        return null;
      }
    }

    return {
      title: normalizeWhitespace(data?.Heading || suggestTitleFromQuery(cleanQuery)),
      answer: cleanAnswerText(makeShortAnswer(answer)),
      mode: "search",
      sourceLabel: "DuckDuckGo",
      score: 85
    };
  } catch (_err) {
    return null;
  }
}

// Fallback: use DuckDuckGo HTML search and parse the first snippet
async function getDuckDuckGoWebSearch(query) {
  const cleanQuery = normalizeWhitespace(query);

  if (!cleanQuery) {
    return null;
  }

  try {
    const url = `${DUCKDUCKGO_SEARCH_URL}?q=${encodeURIComponent(cleanQuery)}&kl=us-en`;
    const response = await fetch(url, {
      headers: {
        "Accept": "text/html",
        "User-Agent": "Mozilla/5.0"
      }
    });

    if (!response.ok) {
      return null;
    }

    const html = await response.text();

    // Extract first result snippet from DuckDuckGo HTML response
    const snippetMatch = html.match(
      /<a[^>]+class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/a>/i
    ) || html.match(
      /<div[^>]+class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/div>/i
    );

    const titleMatch = html.match(
      /<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]*>([\s\S]*?)<\/a>/i
    );

    if (!snippetMatch?.[1]) {
      return null;
    }

    // Strip HTML tags from snippet
    const rawSnippet = snippetMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const rawTitle = titleMatch
      ? titleMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
      : suggestTitleFromQuery(cleanQuery);

    if (!rawSnippet || rawSnippet.length < 20) {
      return null;
    }

    // Relevance check: at least one key token must appear
    const queryTokens = getMeaningfulTokens(cleanQuery);
    const snippetLower = rawSnippet.toLowerCase();
    if (queryTokens.length >= 2) {
      const matched = queryTokens.filter((t) => snippetLower.includes(t)).length;
      if (matched < 1) {
        return null;
      }
    }

    return {
      title: normalizeWhitespace(rawTitle || suggestTitleFromQuery(cleanQuery)),
      answer: cleanAnswerText(makeShortAnswer(rawSnippet)),
      mode: "search",
      sourceLabel: "DuckDuckGo",
      score: 75
    };
  } catch (_err) {
    return null;
  }
}

async function getDictionaryEntry(term) {
  const cleanTerm = normalizeWhitespace(term);

  if (!cleanTerm || cleanTerm.includes(" ")) {
    return null;
  }

  const response = await fetch(`${DICTIONARY_API_URL}${encodeURIComponent(cleanTerm)}`);

  if (!response.ok) {
    return null;
  }

  const data = await response.json();
  const entry = Array.isArray(data) ? data[0] : null;
  const meaning = entry?.meanings?.[0];
  const definition = meaning?.definitions?.[0];

  if (!definition?.definition) {
    return null;
  }

  const part = normalizeWhitespace(meaning.partOfSpeech || "");
  const title = part ? `${toTitleCase(cleanTerm)} (${part})` : toTitleCase(cleanTerm);
  let answer = definition.definition;

  if (definition.example) {
    answer = `${answer} Example: ${definition.example}`;
  }

  return {
    title,
    answer: cleanAnswerText(makeShortAnswer(answer)),
    mode: "dictionary",
    sourceLabel: "Dictionary",
    score: 80
  };
}

async function getDatamuseSynonyms(term) {
  const cleanTerm = normalizeWhitespace(term);

  if (!cleanTerm) {
    return null;
  }

  const response = await fetch(
    `${DATAMUSE_API_URL}?rel_syn=${encodeURIComponent(cleanTerm)}&max=6`
  );

  if (!response.ok) {
    return null;
  }

  const data = await response.json();
  const words = Array.isArray(data)
    ? data
        .map((item) => normalizeWhitespace(item?.word || ""))
        .filter(Boolean)
        .slice(0, 5)
    : [];

  if (!words.length) {
    return null;
  }

  return {
    title: `${toTitleCase(cleanTerm)} Synonyms`,
    answer: `Top related words for ${cleanTerm} include ${joinNaturalList(words)}. These terms carry a similar meaning in common usage.`,
    mode: "synonyms",
    sourceLabel: "Datamuse",
    score: 95
  };
}

async function getWikipediaAnswer(topic) {
  const cleanTopic = normalizeWhitespace(topic);

  if (!cleanTopic) {
    return null;
  }

  const direct = await fetchWikipediaSummary(cleanTopic);
  if (direct?.answer) {
    return direct;
  }

  const searchUrl =
    `${WIKIPEDIA_SEARCH_URL}?origin=*&action=query&list=search&utf8=1&format=json&srsearch=` +
    encodeURIComponent(cleanTopic);
  const response = await fetch(searchUrl);

  if (!response.ok) {
    return null;
  }

  const data = await response.json();
  const candidateTitles = Array.isArray(data?.query?.search)
    ? data.query.search
        .map((item) => normalizeWhitespace(item?.title || ""))
        .filter(Boolean)
        .slice(0, 3)
    : [];

  if (!candidateTitles.length) {
    return null;
  }

  for (const title of candidateTitles) {
    const candidate = await fetchWikipediaSummary(title, cleanTopic);
    if (candidate?.answer) {
      return candidate;
    }
  }

  return null;
}

async function fetchWikipediaSummary(topic, originalTopic = topic) {
  try {
    const response = await fetch(
      `${WIKIPEDIA_SUMMARY_URL}${encodeURIComponent(topic.replace(/\s+/g, "_"))}`
    );

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    const extract = normalizeWhitespace(data?.extract || "");

    if (!extract) {
      return null;
    }

    const title = normalizeWhitespace(data?.title || topic);

    // Strict relevance check — Wikipedia often returns off-topic pages
    if (isWeakWikipediaMatch(originalTopic, title, extract)) {
      return null;
    }

    return {
      title,
      answer: cleanAnswerText(makeShortAnswer(extract)),
      mode: "wiki",
      // Wikipedia scored lower — DuckDuckGo wins when both have answers
      sourceLabel: "Wikipedia",
      score: 45
    };
  } catch (_err) {
    return null;
  }
}

async function getComparisonAnswer(terms) {
  const validTerms = Array.isArray(terms) ? terms.filter(Boolean).slice(0, 2) : [];

  if (validTerms.length < 2) {
    return null;
  }

  const [left, right] = validTerms;
  const [leftEntry, rightEntry] = await Promise.all([
    getBestSingleTopicAnswer(left),
    getBestSingleTopicAnswer(right)
  ]);

  if (!leftEntry && !rightEntry) {
    return null;
  }

  return {
    title: `${toTitleCase(left)} vs ${toTitleCase(right)}`,
    answer: `The main difference is that ${left} and ${right} serve different roles and are used in different situations.`,
    presentation: "comparison",
    comparisonItems: [
      {
        label: toTitleCase(left),
        text: leftEntry?.answer || `${toTitleCase(left)} is a concept or protocol used in computing.`
      },
      {
        label: toTitleCase(right),
        text: rightEntry?.answer || `${toTitleCase(right)} is a concept or protocol used in computing.`
      }
    ],
    mode: "comparison",
    sourceLabel: "Comparison",
    score: 90
  };
}

async function getBestSingleTopicAnswer(topic) {
  const [dictionary, duck, wiki] = await Promise.all([
    getDictionaryEntry(topic),
    getDuckDuckGoAnswer(topic),
    getWikipediaAnswer(topic)
  ]);

  return [dictionary, duck, wiki].filter(Boolean).sort((a, b) => (b.score || 0) - (a.score || 0))[0] || null;
}

async function getSummaryAnswer(text, pageTitle) {
  const cleanText = normalizeWhitespace(text);

  if (!cleanText) {
    return null;
  }

  const sentences = cleanText.match(/[^.!?]+[.!?]?/g) || [];
  const summary = sentences
    .slice(0, 3)
    .map((item) => normalizeWhitespace(item))
    .filter(Boolean)
    .join(" ");

  if (!summary) {
    return null;
  }

  return {
    title: pageTitle ? `${pageTitle} Summary` : "Quick Summary",
    answer: makeShortAnswer(summary),
    mode: "summary",
    sourceLabel: "Page context",
    score: 88
  };
}

async function getTranslationAnswer({ text, targetLanguage }) {
  const cleanText = normalizeWhitespace(text);
  const target = normalizeWhitespace(targetLanguage || "ur");

  if (!cleanText) {
    return null;
  }

  const response = await fetch(
    `${MYMEMORY_TRANSLATE_URL}?q=${encodeURIComponent(cleanText)}&langpair=en|${encodeURIComponent(target)}`
  );

  if (!response.ok) {
    return null;
  }

  const data = await response.json();
  const translatedText = normalizeWhitespace(data?.responseData?.translatedText || "");

  if (!translatedText) {
    return null;
  }

  return {
    title: `Translation to ${languageName(target)}`,
    answer: translatedText,
    mode: "translate",
    sourceLabel: "Translate",
    score: 92
  };
}

function rankAnswers(queryInfo, answers, beginnerMode) {
  return answers
    .map((item) => {
      const totalScore = (item.score || 0) + getIntentBonus(queryInfo, item);
      const adapted = beginnerMode ? applyBeginnerTone(item) : item;
      return {
        ...adapted,
        totalScore
      };
    })
    .sort((left, right) => right.totalScore - left.totalScore);
}

function getIntentBonus(queryInfo, item) {
  if (queryInfo.kind === "synonym" && item.mode === "synonyms") {
    return 40;
  }

  if (queryInfo.kind === "definition" && item.mode === "dictionary") {
    return 35;
  }

  if (queryInfo.kind === "comparison" && item.mode === "comparison") {
    return 45;
  }

  if (queryInfo.kind === "summary" && item.mode === "summary") {
    return 35;
  }

  if (queryInfo.kind === "translate" && item.mode === "translate") {
    return 45;
  }

  return 0;
}

function applyBeginnerTone(item) {
  if (!item?.answer) {
    return item;
  }

  if (item.presentation === "comparison") {
    return {
      ...item,
      answer: `In simple words, ${item.answer}`,
      comparisonItems: (item.comparisonItems || []).map((entry) => ({
        ...entry,
        text: simplifyText(entry.text)
      })),
      sourceLabel: `${item.sourceLabel} + simple`
    };
  }

  return {
    ...item,
    answer: simplifyText(item.answer),
    sourceLabel: `${item.sourceLabel} + simple`
  };
}

function getBuiltInIntroAnswer(query) {
  const normalized = normalizeWhitespace(query).toLowerCase();
  const introPatterns = [
    "who are you",
    "what are you",
    "introduce yourself",
    "what is helpa",
    "tell me about yourself"
  ];

  if (!introPatterns.includes(normalized)) {
    return null;
  }

  return {
    title: "About HelpA",
    answer:
      "I am HelpA, your mini browser assistant. I can define words, explain concepts, compare ideas, summarize pages, translate short text, and answer questions right inside the page.",
    mode: "built_in",
    sourceLabel: "HelpA intro"
  };
}

function resolveWithHistory(query, history) {
  const cleanQuery = normalizeWhitespace(query);
  const last = history.at(-1);

  if (!last?.query) {
    return cleanQuery;
  }

  if (/^(what about|and|also|compare it|explain that)\b/i.test(cleanQuery)) {
    return `${cleanQuery} (previous topic: ${last.query})`;
  }

  return cleanQuery;
}

function extractCoreTerm(query) {
  return normalizeWhitespace(
    String(query || "")
      .replace(/\b(what is|what are|who is|define|meaning of|explain|simple|simply|synonym|synonyms|translate|difference between)\b/gi, "")
      .replace(/\b(to urdu|to english|to hindi|to arabic|to spanish)\b/gi, "")
      .replace(/\b(and)\b/gi, " ")
  );
}

function extractComparisonTerms(query) {
  const clean = normalizeWhitespace(query);
  const betweenMatch = clean.match(/difference between\s+(.+?)\s+and\s+(.+)/i);
  if (betweenMatch?.[1] && betweenMatch?.[2]) {
    return [normalizeWhitespace(betweenMatch[1]), normalizeWhitespace(betweenMatch[2])];
  }

  const vsMatch = clean.match(/(.+?)\s+(?:vs|versus)\s+(.+)/i);
  if (vsMatch?.[1] && vsMatch?.[2]) {
    return [normalizeWhitespace(vsMatch[1]), normalizeWhitespace(vsMatch[2])];
  }

  return null;
}

function splitSelectedComparison(selectedText) {
  const clean = normalizeWhitespace(selectedText);
  const match = clean.match(/(.+?)\s+(?:vs|versus|and)\s+(.+)/i);
  return match?.[1] && match?.[2]
    ? [normalizeWhitespace(match[1]), normalizeWhitespace(match[2])]
    : [];
}

function extractFirstRelatedTopic(relatedTopics) {
  if (!Array.isArray(relatedTopics)) {
    return "";
  }

  for (const topic of relatedTopics) {
    const text = normalizeWhitespace(topic?.Text || "");
    if (text) {
      return text;
    }

    const nested = extractFirstRelatedTopic(topic?.Topics);
    if (nested) {
      return nested;
    }
  }

  return "";
}

function simplifyText(text) {
  const clean = normalizeWhitespace(text);
  if (!clean) {
    return "";
  }

  const simplified = clean
    .replace(/\butilize\b/gi, "use")
    .replace(/\bobtain\b/gi, "get")
    .replace(/\bapproximately\b/gi, "about")
    .replace(/\btherefore\b/gi, "so")
    .replace(/\bhowever\b/gi, "but");

  return simplified.startsWith("In simple words")
    ? simplified
    : `In simple words, ${lowercaseFirst(simplified)}`;
}

function isSynonymQuery(query) {
  return /\bsynonym|synonyms\b/i.test(query);
}

function languageName(code) {
  const map = {
    ur: "Urdu",
    en: "English",
    hi: "Hindi",
    ar: "Arabic",
    es: "Spanish"
  };

  return map[code] || code.toUpperCase();
}

function suggestTitleFromQuery(query) {
  const clean = normalizeWhitespace(query);
  const noPrefix = clean.replace(
    /^(what is|what are|who is|define|meaning of|difference between|translate|summarize)\s+/i,
    ""
  );
  return toTitleCase(noPrefix || clean);
}

function lowercaseFirst(text) {
  const clean = normalizeWhitespace(text);
  return clean ? clean.charAt(0).toLowerCase() + clean.slice(1) : "";
}

function cleanAnswerText(text) {
  return normalizeWhitespace(
    String(text || "")
      .replace(/^wikipedia\s*/i, "")
      .replace(/^duckduckgo\s*/i, "")
  );
}

function isWeakWikipediaMatch(topic, title, extract) {
  const topicTokens = getMeaningfulTokens(topic);

  if (!topicTokens.length) {
    return false;
  }

  const haystack = `${title} ${extract}`.toLowerCase();
  const titleLower = title.toLowerCase();
  const matched = topicTokens.filter((token) => haystack.includes(token)).length;

  // Stricter match: for multi-token queries, require more matches
  // AND at least one key token must appear in the title itself
  const requiredHaystackMatches = topicTokens.length <= 1 ? 1
    : topicTokens.length <= 3 ? topicTokens.length
    : Math.ceil(topicTokens.length * 0.7);

  if (matched < requiredHaystackMatches) {
    return true; // weak match — reject
  }

  // For queries with 2+ tokens, at least one must be in the Wikipedia page title
  if (topicTokens.length >= 2) {
    const titleHasAnyToken = topicTokens.some((token) => titleLower.includes(token));
    if (!titleHasAnyToken) {
      return true; // title is completely unrelated — reject
    }
  }

  return false;
}

function getMeaningfulTokens(text) {
  const stopWords = new Set([
    "what",
    "who",
    "when",
    "where",
    "why",
    "how",
    "is",
    "are",
    "was",
    "were",
    "the",
    "a",
    "an",
    "of",
    "in",
    "on",
    "for",
    "to",
    "and",
    "or",
    "with",
    "meaning",
    "define",
    "explain",
    "language"
  ]);

  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s+#]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => {
      if (!token || stopWords.has(token)) {
        return false;
      }

      if (token.length >= 3) {
        return true;
      }

      return token.includes("+") || token.includes("#");
    });
}

function makeShortAnswer(text) {
  const clean = normalizeWhitespace(text);

  if (clean.length <= 280) {
    return clean;
  }

  const sentences = clean.match(/[^.!?]+[.!?]+/g);
  if (sentences?.length) {
    let shortText = "";

    for (const sentence of sentences) {
      if ((shortText + sentence).length > 280) {
        break;
      }
      shortText += sentence;
    }

    if (shortText) {
      return shortText.trim();
    }
  }

  return `${clean.slice(0, 277).trim()}...`;
}

function joinNaturalList(items) {
  if (!items.length) {
    return "";
  }

  if (items.length === 1) {
    return items[0];
  }

  if (items.length === 2) {
    return `${items[0]} and ${items[1]}`;
  }

  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function firstNonEmpty(values) {
  for (const value of values) {
    const clean = normalizeWhitespace(value);
    if (clean) {
      return clean;
    }
  }

  return "";
}

function toTitleCase(value) {
  return String(value || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
