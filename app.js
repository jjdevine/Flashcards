(function () {
  "use strict";

  // ── Debug Panel ────────────────────────────────────────────────
  const debugLogs = [];
  const MAX_DEBUG_LOGS = 50;

  function addDebugLog(message, isError) {
    debugLogs.push({ message, isError, timestamp: new Date().toLocaleTimeString() });
    if (debugLogs.length > MAX_DEBUG_LOGS) debugLogs.shift();

    const logsEl = $("#debug-logs");
    if (logsEl) {
      const lineEl = document.createElement("div");
      lineEl.className = "debug-log-line " + (isError ? "debug-log-error" : "debug-log-debug");
      const time = debugLogs[debugLogs.length - 1].timestamp;
      lineEl.textContent = "[" + time + "] " + message;
      logsEl.appendChild(lineEl);
      logsEl.scrollTop = logsEl.scrollHeight;
    }
  }

  function showDebugPanel() {
    const panel = $("#debug-panel");
    if (panel) {
      panel.classList.remove("hidden");
      debugLogs.length = 0;
      const logsEl = $("#debug-logs");
      if (logsEl) logsEl.innerHTML = "";
    }
  }

  function hideDebugPanel() {
    const panel = $("#debug-panel");
    if (panel) {
      setTimeout(() => {
        panel.classList.add("hidden");
      }, 500);
    }
  }

  // Intercept console.log and console.error
  const originalLog = console.log;
  const originalError = console.error;
  function formatDebugArg(arg) {
    if (arg instanceof Error) {
      return arg.stack || arg.message || String(arg);
    }
    if (typeof arg === "object" && arg !== null) {
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    }
    return String(arg);
  }
  console.log = function(...args) {
    originalLog.apply(console, args);
    addDebugLog(args.map(formatDebugArg).join(" "), false);
  };
  console.error = function(...args) {
    originalError.apply(console, args);
    addDebugLog(args.map(formatDebugArg).join(" "), true);
  };

  // ── Supabase client ────────────────────────────────────────────
  const supabase = (typeof SUPABASE_URL !== "undefined" && SUPABASE_URL !== "https://YOUR_PROJECT_REF.supabase.co")
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;
  let currentUser = null;   // Supabase user object when signed in
  let syncInFlight = false; // Guard against overlapping syncs
  let appEntered = false;   // Guard against duplicate enterApp() calls

  // ── State ──────────────────────────────────────────────────────
  const STORAGE_KEY = "flashcard_revision";
  const INCORRECT_KEY = "flashcard_incorrect";
  const HIGHLIGHTED_KEY = "flashcard_highlighted";
  const CONDENSED_KEY = "flashcard_condensed";
  const DECK_MODE_NORMAL = "normal";
  const DECK_MODE_HIGHLIGHTED = "highlighted";
  let manifest = null;
  let decks = {};          // id -> { cards: [{front, back, tags, rawLine, deckId, cardIndex}] }
  let progress = {};       // "deckId:cardIndex" -> { box, lastSeen }
  let incorrect = {};      // "deckId:cardIndex" -> { front, back, rawLine, deckFile }
  let highlighted = {};    // "deckId:cardIndex" -> true
  let condensedMode = false;
  let currentDeckId = null;
  let currentDeckMode = DECK_MODE_NORMAL;
  let currentDeckCardIndices = [];
  let currentCard = null;  // card index
  let revealed = false;
  let sessionCards = 0;    // cards viewed in the current deck session
  let sessionEasySet = new Set(); // card indices rated "very easy" this session
  let canSyncHighlightedData = true;

  // ── DOM refs ───────────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // ── Persistence ────────────────────────────────────────────────
  function loadProgress() {
    console.log("[DEBUG] loadProgress: Loading progress from localStorage...");
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      progress = raw ? JSON.parse(raw) : {};
      console.log("[DEBUG] loadProgress: Loaded progress with", Object.keys(progress).length, "cards");
    } catch (e) {
      console.error("[ERROR] loadProgress: Failed to parse progress", e);
      progress = {};
    }
    try {
      const raw = localStorage.getItem(INCORRECT_KEY);
      incorrect = raw ? JSON.parse(raw) : {};
      console.log("[DEBUG] loadProgress: Loaded incorrect cards:", Object.keys(incorrect).length);
    } catch (e) {
      console.error("[ERROR] loadProgress: Failed to parse incorrect", e);
      incorrect = {};
    }
    try {
      const raw = localStorage.getItem(HIGHLIGHTED_KEY);
      highlighted = raw ? JSON.parse(raw) : {};
      console.log("[DEBUG] loadProgress: Loaded highlighted cards:", Object.keys(highlighted).length);
    } catch (e) {
      console.error("[ERROR] loadProgress: Failed to parse highlighted", e);
      highlighted = {};
    }
  }

  function saveProgressLocal() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(progress)); } catch {}
  }

  function saveIncorrectLocal() {
    try { localStorage.setItem(INCORRECT_KEY, JSON.stringify(incorrect)); } catch {}
  }

  function saveHighlightedLocal() {
    try { localStorage.setItem(HIGHLIGHTED_KEY, JSON.stringify(highlighted)); } catch {}
  }

  function saveProgress() {
    saveProgressLocal();
    debouncedSync();
  }

  function saveIncorrect() {
    saveIncorrectLocal();
    debouncedSync();
  }

  function saveHighlighted() {
    saveHighlightedLocal();
    debouncedSync();
  }

  // ── Supabase sync ─────────────────────────────────────────────
  let syncTimer = null;
  function debouncedSync() {
    if (!currentUser) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => pushState(), 1500);
  }

  async function pushState() {
    if (!supabase || !currentUser || syncInFlight) return;
    syncInFlight = true;
    try {
      const row = {
        user_id: currentUser.id,
        progress_data: progress,
        incorrect_data: incorrect,
        updated_at: new Date().toISOString(),
      };
      if (canSyncHighlightedData) {
        row.highlighted_data = highlighted;
      }

      let { error } = await supabase.from("user_state").upsert(row);

      // Backward compatibility for older schemas without highlighted_data.
      if (error && canSyncHighlightedData && /highlighted_data/i.test(error.message || "")) {
        canSyncHighlightedData = false;
        ({ error } = await supabase.from("user_state").upsert({
          user_id: currentUser.id,
          progress_data: progress,
          incorrect_data: incorrect,
          updated_at: new Date().toISOString(),
        }));
      }

      if (error) console.error("Sync push error:", error.message);
    } catch (e) {
      console.error("Sync push exception:", e);
    } finally {
      syncInFlight = false;
    }
  }

  async function pullState() {
    if (!supabase || !currentUser) return;
    try {
      const { data, error } = await supabase
        .from("user_state")
        .select("*")
        .eq("user_id", currentUser.id)
        .maybeSingle();

      if (error) { console.error("Sync pull error:", error.message); return; }
      if (!data) return; // No remote state yet

      mergeProgress(data.progress_data || {});
      mergeIncorrect(data.incorrect_data || {});
      if (data.highlighted_data) {
        mergeHighlighted(data.highlighted_data || {});
      }
      saveProgressLocal();
      saveIncorrectLocal();
      saveHighlightedLocal();
    } catch (e) {
      console.error("Sync pull exception:", e);
    }
  }

  function mergeProgress(remote) {
    // For each card key, keep whichever entry has the later lastSeen
    for (const key of Object.keys(remote)) {
      const local = progress[key];
      const rem = remote[key];
      if (!local) {
        progress[key] = rem;
      } else if ((rem.lastSeen || 0) > (local.lastSeen || 0)) {
        progress[key] = rem;
      }
    }
  }

  function mergeIncorrect(remote) {
    // Union: keep all entries from both sides
    for (const key of Object.keys(remote)) {
      if (!incorrect[key]) {
        incorrect[key] = remote[key];
      }
    }
  }

  function mergeHighlighted(remote) {
    // Union semantics: if highlighted remotely or locally, keep it highlighted.
    for (const key of Object.keys(remote)) {
      if (remote[key]) highlighted[key] = true;
    }
  }

  async function syncNow() {
    if (!currentUser) return;
    await pullState();
    await pushState();
    renderHome();
  }

  // ── CSV Parser ─────────────────────────────────────────────────
  function parseCSVLine(line) {
    const fields = [];
    let current = "";
    let inQuotes = false;
    let i = 0;

    while (i < line.length) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (i + 1 < line.length && line[i + 1] === '"') {
            current += '"';
            i += 2;
          } else {
            inQuotes = false;
            i++;
          }
        } else {
          current += ch;
          i++;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
          i++;
        } else if (ch === ',') {
          fields.push(current);
          current = "";
          i++;
        } else {
          current += ch;
          i++;
        }
      }
    }
    fields.push(current);
    return fields;
  }

  function parseCSV(text) {
    console.log("[DEBUG] parseCSV: Parsing CSV with", text.length, "bytes");
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    console.log("[DEBUG] parseCSV: Found", lines.length, "non-empty lines");
    const cards = [];

    for (const line of lines) {
      const fields = parseCSVLine(line);
      if (fields.length < 2) {
        console.log("[DEBUG] parseCSV: Skipping line with", fields.length, "field(s):", line.substring(0, 50));
        continue;
      }

      let front = fields[0].trim();
      let back = fields[1].trim();
      const tags = fields[2] ? fields[2].trim() : "";

      // Strip Anki-style prefixes (_ or ~)
      front = front.replace(/^[_~]\s*/, "");
      back = back.replace(/^[_~]\s*/, "");

      if (front && back) {
        cards.push({ front, back, tags, rawLine: line });
      }
    }
    console.log("[DEBUG] parseCSV: Successfully parsed", cards.length, "cards");
    return cards;
  }

  // ── Data loading ───────────────────────────────────────────────
  async function loadManifest() {
    console.log("[DEBUG] loadManifest: Fetching manifest.json...");
    try {
      const resp = await fetch("manifest.json?v=" + Date.now());
      if (!resp.ok) {
        throw new Error("HTTP " + resp.status + " " + resp.statusText);
      }
      manifest = await resp.json();
      console.log("[DEBUG] loadManifest: Successfully loaded. Found", manifest.decks.length, "decks:", manifest.decks.map(d => d.name).join(", "));
    } catch (e) {
      console.error("[ERROR] loadManifest: Failed to load manifest", e);
      throw e;
    }
  }

  async function loadDeck(id) {
    console.log("[DEBUG] loadDeck: Loading deck", id);
    if (decks[id]) {
      console.log("[DEBUG] loadDeck: Deck" , id, "already loaded with", decks[id].cards.length, "cards");
      return decks[id];
    }
    const entry = manifest.decks.find((d) => d.id === id);
    if (!entry) {
      throw new Error("Deck " + id + " not found in manifest");
    }
    console.log("[DEBUG] loadDeck: Fetching", entry.file, "(buildTime:", manifest.buildTime + ")");
    try {
      const resp = await fetch(entry.file + "?v=" + manifest.buildTime);
      if (!resp.ok) {
        throw new Error("HTTP " + resp.status + " " + resp.statusText);
      }
      const text = await resp.text();
      console.log("[DEBUG] loadDeck: Received", text.length, "bytes from", entry.file);
      decks[id] = { cards: parseCSV(text) };
      console.log("[DEBUG] loadDeck: Parsed", decks[id].cards.length, "cards from", entry.name);
      return decks[id];
    } catch (e) {
      console.error("[ERROR] loadDeck: Failed to load deck", id, "(", entry.name + ")", e);
      throw e;
    }
  }

  // ── Progress helpers ───────────────────────────────────────────
  function cardKey(deckId, cardIndex) {
    return deckId + ":" + cardIndex;
  }

  function isCardHighlighted(deckId, cardIndex) {
    return !!highlighted[cardKey(deckId, cardIndex)];
  }

  function getDeckCardIndices(deckId, mode) {
    const deck = decks[deckId];
    if (!deck) return [];
    const indices = [];
    deck.cards.forEach((_, i) => {
      if (mode === DECK_MODE_HIGHLIGHTED && !isCardHighlighted(deckId, i)) return;
      indices.push(i);
    });
    return indices;
  }

  function getCardProgress(deckId, cardIndex) {
    return progress[cardKey(deckId, cardIndex)] || { box: 0, lastSeen: 0 };
  }

  function setCardProgress(deckId, cardIndex, data) {
    progress[cardKey(deckId, cardIndex)] = data;
    saveProgress();
  }

  // ── SRS — time decay ──────────────────────────────────────────
  // Minimum time (ms) a card must stay in a box before it can decay down.
  // Box 0 = unseen (never decays). Box 5 = mastered.
  const DECAY_MS = [
    Infinity,   // box 0 – unseen, never
    1  * 24 * 60 * 60 * 1000,   // box 1 – 1 day
    2  * 24 * 60 * 60 * 1000,   // box 2 – 2 days
    5  * 24 * 60 * 60 * 1000,   // box 3 – 5 days
    10 * 24 * 60 * 60 * 1000,   // box 4 – 10 days
    21 * 24 * 60 * 60 * 1000,   // box 5 – 21 days
  ];

  function applyDecay(deckId, cardIndex) {
    const p = getCardProgress(deckId, cardIndex);
    if (p.box <= 0 || !p.lastSeen) return p;

    const elapsed = Date.now() - p.lastSeen;
    const threshold = DECAY_MS[Math.min(p.box, 5)];
    if (elapsed < threshold) return p;

    // How many full intervals have passed? Drop one box per interval.
    const intervals = Math.floor(elapsed / threshold);
    const newBox = Math.max(1, p.box - intervals);
    if (newBox !== p.box) {
      const updated = { box: newBox, lastSeen: p.lastSeen };
      setCardProgress(deckId, cardIndex, updated);
      return updated;
    }
    return p;
  }

  // ── SRS — weighted random card selection ───────────────────────
  // Box 0 = unseen
  // Box 1 = marked hard (highest priority — needs drilling)
  // Box 2 = seen once ok / recovering from hard (still needs work)
  // Box 3–4 = known, fading to background
  // Box 5 = mastered (rarely shown)
  //
  // Hard cards are much more likely than unseen; priority only drops
  // after several ok/easy ratings push the card up the boxes.
  function selectNextCard(deckId, cardIndices) {
    const deck = decks[deckId];
    if (!deck || !deck.cards.length) return null;

    const pool = cardIndices && cardIndices.length
      ? cardIndices.slice()
      : deck.cards.map((_, i) => i);
    if (!pool.length) return null;

    const boxWeights = [4, 50, 5, 3, 2, 1]; // index = box
    const cardWeights = pool.map((i) => {
      if (incorrect[cardKey(deckId, i)]) return 0; // skip incorrect cards
      if (sessionEasySet.has(i)) return 0; // skip "very easy" cards this session
      const p = applyDecay(deckId, i);
      return boxWeights[Math.min(p.box, 5)];
    });

    let total = cardWeights.reduce((a, b) => a + b, 0);

    // If only "very easy" cards remain, allow them back in
    if (total === 0 && sessionEasySet.size > 0) {
      sessionEasySet.clear();
      pool.forEach((i, poolIdx) => {
        if (incorrect[cardKey(deckId, i)]) { cardWeights[poolIdx] = 0; return; }
        const p = applyDecay(deckId, i);
        cardWeights[poolIdx] = boxWeights[Math.min(p.box, 5)];
      });
      total = cardWeights.reduce((a, b) => a + b, 0);
    }

    if (total === 0) return null; // all cards are incorrect
    let r = Math.random() * total;

    for (let i = 0; i < cardWeights.length; i++) {
      r -= cardWeights[i];
      if (r <= 0) return pool[i];
    }
    return pool[pool.length - 1];
  }

  // ── Mark incorrect ─────────────────────────────────────────────
  function markIncorrect() {
    if (currentDeckId === null || currentCard === null) return;
    if (!confirm("Mark this card as incorrect? It will be hidden from this deck.")) return;

    const card = decks[currentDeckId].cards[currentCard];
    const entry = manifest.decks.find((d) => d.id === currentDeckId);
    incorrect[cardKey(currentDeckId, currentCard)] = {
      front: card.front,
      back: card.back,
      rawLine: card.rawLine,
      deckFile: entry.file,
      deckName: entry.name,
    };
    saveIncorrect();
    showNextCard();
  }

  // ── Rating ─────────────────────────────────────────────────────
  function rateCard(rating) {
    if (currentDeckId === null || currentCard === null) return;

    const p = getCardProgress(currentDeckId, currentCard);
    let newBox = p.box || 1;

    switch (rating) {
      case "hard":  newBox = 1; break;
      case "ok":    newBox = Math.min(5, Math.max(1, p.box) + 1); break;
      case "easy":  newBox = Math.min(5, Math.max(1, p.box) + 2); break;
    }

    setCardProgress(currentDeckId, currentCard, { box: newBox, lastSeen: Date.now() });
    if (rating === "easy") sessionEasySet.add(currentCard);
    showNextCard();
  }

  function toggleCurrentCardHighlight() {
    if (currentDeckId === null || currentCard === null) return;
    const key = cardKey(currentDeckId, currentCard);
    if (highlighted[key]) {
      delete highlighted[key];
    } else {
      highlighted[key] = true;
    }
    saveHighlighted();

    if (currentDeckMode === DECK_MODE_HIGHLIGHTED && !highlighted[key]) {
      showNextCard();
      return;
    }

    updateHighlightToggleButton();
  }

  function clearHighlightedDeck() {
    if (!currentDeckId) return;
    clearHighlightedDeckById(currentDeckId);
  }

  function clearHighlightedDeckById(deckId) {
    if (!deckId) return;
    const entry = manifest.decks.find((d) => d.id === deckId);
    if (!entry) return;
    if (!confirm("Empty highlighted deck for " + entry.name + "?")) return;

    const deck = decks[deckId];
    if (!deck) return;

    deck.cards.forEach((_, i) => {
      delete highlighted[cardKey(deckId, i)];
    });
    saveHighlighted();

    if (currentDeckId === deckId && currentDeckMode === DECK_MODE_HIGHLIGHTED) {
      currentDeckId = null;
      currentDeckMode = DECK_MODE_NORMAL;
      currentDeckCardIndices = [];
      currentCard = null;
      renderHome();
      showScreen("home");
      return;
    }

    if (currentDeckId === deckId) {
      updateDeckStats();
      updateHighlightToggleButton();
    }
    renderHome();
  }

  function updateHighlightToggleButton() {
    const btn = $("#toggle-highlight-btn");
    if (!btn || currentDeckId === null || currentCard === null) return;
    const highlightedNow = isCardHighlighted(currentDeckId, currentCard);
    btn.textContent = highlightedNow ? "Unhighlight card" : "Highlight card";
    btn.classList.toggle("active", highlightedNow);
  }

  // ── Condensed mode ─────────────────────────────────────────────
  function applyCondensedMode() {
    const grid = $("#deck-grid");
    const btn = $("#condensed-toggle-btn");
    if (condensedMode) {
      grid.classList.add("condensed");
      btn.textContent = "⊞ Normal";
      btn.classList.add("condensed-active");
    } else {
      grid.classList.remove("condensed");
      btn.textContent = "⊟ Condensed";
      btn.classList.remove("condensed-active");
    }
  }

  // ── Render: Home screen ────────────────────────────────────────
  function renderHome() {
    const grid = $("#deck-grid");
    grid.innerHTML = "";

    for (const entry of manifest.decks) {
      const deck = decks[entry.id];
      const total = deck ? deck.cards.length : 0;
      const seen  = deck ? deck.cards.filter((_, i) => getCardProgress(entry.id, i).box > 0).length : 0;
      const mastered = deck ? deck.cards.filter((_, i) => getCardProgress(entry.id, i).box >= 4).length : 0;
      const pct = total ? Math.round((mastered / total) * 100) : 0;
      const highlightedCount = deck ? deck.cards.filter((_, i) => isCardHighlighted(entry.id, i)).length : 0;

      const el = document.createElement("div");
      el.className = "deck-card";
      el.innerHTML =
        '<div class="deck-card-top">' +
          '<span class="deck-card-title">' + esc(entry.name) + '</span>' +
        '</div>' +
        '<div class="deck-card-meta">' +
          '<span>' + total + ' cards</span>' +
          '<span>' + seen + ' seen</span>' +
          '<span>' + mastered + ' mastered</span>' +
          '<span>' + highlightedCount + ' highlighted</span>' +
        '</div>' +
        '<div class="deck-progress-bar"><div class="deck-progress-fill" style="width:' + pct + '%"></div></div>' +
        '<button class="btn-deck-start" aria-label="Start deck" tabindex="-1">&#9654;</button>';
      el.addEventListener("click", () => openDeck(entry.id, DECK_MODE_NORMAL));
      grid.appendChild(el);

      if (highlightedCount > 0) {
        const highlightedEl = document.createElement("div");
        highlightedEl.className = "deck-card deck-card-highlighted";
        highlightedEl.innerHTML =
          '<div class="deck-card-top">' +
            '<span class="deck-card-title">' + esc(entry.name + " (highlighted)") + '</span>' +
          '</div>' +
          '<div class="deck-card-meta">' +
            '<span>' + highlightedCount + ' highlighted</span>' +
            '<span>Only highlighted cards</span>' +
          '</div>' +
          '<div class="deck-card-actions">' +
            '<button class="btn-home-clear-highlighted">Empty highlighted</button>' +
          '</div>' +
          '<div class="deck-progress-bar"><div class="deck-progress-fill" style="width:100%"></div></div>' +
          '<button class="btn-deck-clear-sm" aria-label="Clear highlighted" title="Clear highlighted">&#10005;</button>' +
          '<button class="btn-deck-start" aria-label="Start highlighted deck" tabindex="-1">&#9654;</button>';
        highlightedEl.querySelector(".btn-home-clear-highlighted").addEventListener("click", (e) => {
          e.stopPropagation();
          clearHighlightedDeckById(entry.id);
        });
        highlightedEl.querySelector(".btn-deck-clear-sm").addEventListener("click", (e) => {
          e.stopPropagation();
          clearHighlightedDeckById(entry.id);
        });
        highlightedEl.addEventListener("click", () => openDeck(entry.id, DECK_MODE_HIGHLIGHTED));
        grid.appendChild(highlightedEl);
      }
    }
  }

  // ── Render: open a deck ────────────────────────────────────────
  async function openDeck(id, mode = DECK_MODE_NORMAL) {
    currentDeckId = id;
    currentDeckMode = mode;
    await loadDeck(id);
    const entry = manifest.decks.find((d) => d.id === id);
    $("#deck-title").textContent = mode === DECK_MODE_HIGHLIGHTED ? entry.name + " (highlighted)" : entry.name;
    sessionCards = 0;
    sessionEasySet = new Set();
    currentDeckCardIndices = getDeckCardIndices(currentDeckId, currentDeckMode);

    $("#clear-highlighted-btn").classList.toggle("hidden", mode !== DECK_MODE_HIGHLIGHTED);
    $("#download-highlighted-btn").classList.toggle("hidden", mode !== DECK_MODE_HIGHLIGHTED);

    showNextCard();
    updateDeckStats();
    showScreen("deck");
  }

  // ── Render: show next card ─────────────────────────────────────
  function showNextCard() {
    currentDeckCardIndices = getDeckCardIndices(currentDeckId, currentDeckMode);
    const idx = selectNextCard(currentDeckId, currentDeckCardIndices);
    if (idx === null) {
      currentCard = null;
      revealed = false;
      $("#card-front-text").textContent = currentDeckMode === DECK_MODE_HIGHLIGHTED
        ? "No highlighted cards available right now."
        : "No cards available right now.";
      $("#card-back-text").textContent = "";
      $("#card-answer-section").classList.add("hidden");
      $("#reveal-btn").classList.add("hidden");
      $("#rating-buttons").classList.add("hidden");
      $("#mark-incorrect-area").classList.add("hidden");
      updateProgressBar();
      updateDeckStats();
      return;
    }

    currentCard = idx;
    revealed = false;
    sessionCards++;

    const card = decks[currentDeckId].cards[idx];
    $("#card-front-text").textContent = card.front;
    $("#card-back-text").textContent = card.back;
    $("#card-answer-section").classList.add("hidden");
    $("#reveal-btn").classList.remove("hidden");
    $("#rating-buttons").classList.add("hidden");
    $("#mark-incorrect-area").classList.add("hidden");
    updateHighlightToggleButton();

    updateProgressBar();
    updateDeckStats();
  }

  function revealCard() {
    if (revealed) return;
    revealed = true;
    $("#card-answer-section").classList.remove("hidden");
    $("#reveal-btn").classList.add("hidden");
    $("#rating-buttons").classList.remove("hidden");
    $("#mark-incorrect-area").classList.remove("hidden");
    updateHighlightToggleButton();
  }

  // ── Progress indicators ────────────────────────────────────────
  function updateProgressBar() {
    const deck = decks[currentDeckId];
    if (!deck) return;
    const indices = currentDeckCardIndices.length
      ? currentDeckCardIndices
      : getDeckCardIndices(currentDeckId, currentDeckMode);
    const total = indices.length;
    const mastered = indices.filter((i) => applyDecay(currentDeckId, i).box >= 4).length;
    const pct = total ? Math.round((mastered / total) * 100) : 0;
    $("#progress-bar").style.width = pct + "%";
    $("#progress-text").textContent = mastered + "/" + total + " mastered";
  }

  function updateDeckStats() {
    const deck = decks[currentDeckId];
    if (!deck) return;

    const indices = currentDeckCardIndices.length
      ? currentDeckCardIndices
      : getDeckCardIndices(currentDeckId, currentDeckMode);

    const boxes = [0, 0, 0, 0, 0, 0];
    indices.forEach((i) => {
      const p = applyDecay(currentDeckId, i);
      boxes[Math.min(p.box, 5)]++;
    });

    const total = indices.length;
    const seen = total - boxes[0];

    $("#deck-progress-summary").textContent = seen + " of " + total + " cards seen";
    $("#deck-stats").innerHTML =
      '<div class="stats-grid">' +
        '<div class="stat"><span class="stat-label">This session</span><span class="stat-value">' + sessionCards + '</span></div>' +
        '<div class="stat"><span class="stat-label">New</span><span class="stat-value">' + boxes[0] + '</span></div>' +
        '<div class="stat"><span class="stat-label">Learning</span><span class="stat-value">' + (boxes[1] + boxes[2]) + '</span></div>' +
        '<div class="stat"><span class="stat-label">Known</span><span class="stat-value">' + (boxes[3] + boxes[4]) + '</span></div>' +
        '<div class="stat"><span class="stat-label">Mastered</span><span class="stat-value">' + boxes[5] + '</span></div>' +
      '</div>';
  }

  // ── Screen switching ───────────────────────────────────────────
  function showScreen(name) {
    $("#auth-screen").classList.toggle("active", name === "auth");
    $("#home-screen").classList.toggle("active", name === "home");
    $("#deck-screen").classList.toggle("active", name === "deck");
    $("#incorrect-screen").classList.toggle("active", name === "incorrect");
  }

  // ── Incorrect cards screen ─────────────────────────────────────
  function renderIncorrectScreen() {
    const keys = Object.keys(incorrect);
    const list = $("#incorrect-list");
    const empty = $("#incorrect-empty");
    const actions = $("#incorrect-actions");
    list.innerHTML = "";

    if (keys.length === 0) {
      empty.classList.remove("hidden");
      actions.classList.add("hidden");
      return;
    }

    empty.classList.add("hidden");
    actions.classList.remove("hidden");

    // Group by deck
    const byDeck = {};
    for (const key of keys) {
      const entry = incorrect[key];
      const name = entry.deckName || "Unknown";
      if (!byDeck[name]) byDeck[name] = [];
      byDeck[name].push({ key, ...entry });
    }

    for (const deckName of Object.keys(byDeck).sort()) {
      const heading = document.createElement("h3");
      heading.className = "incorrect-deck-heading";
      heading.textContent = deckName;
      list.appendChild(heading);

      for (const card of byDeck[deckName]) {
        const el = document.createElement("div");
        el.className = "incorrect-item";
        el.innerHTML =
          '<div class="incorrect-item-text">' +
            '<div class="incorrect-front">' + esc(card.front) + '</div>' +
            '<div class="incorrect-back">' + esc(card.back) + '</div>' +
          '</div>' +
          '<button class="btn-restore" title="Restore card">&#x21A9;</button>';
        el.querySelector(".btn-restore").addEventListener("click", () => {
          delete incorrect[card.key];
          saveIncorrect();
          renderIncorrectScreen();
        });
        list.appendChild(el);
      }
    }
  }

  function downloadIncorrectLines() {
    const keys = Object.keys(incorrect);
    if (!keys.length) return;

    // Group raw lines by file
    const byFile = {};
    for (const key of keys) {
      const entry = incorrect[key];
      const file = entry.deckFile || "unknown.csv";
      if (!byFile[file]) byFile[file] = [];
      byFile[file].push(entry.rawLine);
    }

    let output = "";
    for (const file of Object.keys(byFile).sort()) {
      output += "=== " + file + " ===\n";
      for (const line of byFile[file]) {
        output += line + "\n";
      }
      output += "\n";
    }

    const blob = new Blob([output], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "incorrect-cards.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  function downloadHighlightedLines() {
    const deck = decks[currentDeckId];
    if (!deck) return;
    const highlightedCards = deck.cards.filter((_, i) => isCardHighlighted(currentDeckId, i));
    if (!highlightedCards.length) return;

    const entry = manifest.decks.find((d) => d.id === currentDeckId);
    const deckName = (entry ? entry.name : currentDeckId).replace(/[^a-z0-9_\-]/gi, "_");

    const questions = highlightedCards.map((c) => c.front).join("\n");
    const pairs = highlightedCards.map((c) => c.front + "=" + c.back).join("\n");
    const output = questions + "\n-------\n" + pairs + "\n";

    const blob = new Blob([output], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = deckName + "-highlighted.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Helpers ────────────────────────────────────────────────────
  function esc(str) {
    const el = document.createElement("span");
    el.textContent = str;
    return el.innerHTML;
  }

  // ── Auth UI ─────────────────────────────────────────────────────
  function bindAuthEvents() {
    // Tab switching
    $$(".auth-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        $$(".auth-tab").forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        const isSignup = tab.dataset.tab === "signup";
        $("#auth-submit-btn").textContent = isSignup ? "Sign Up" : "Sign In";
        $("#auth-password").setAttribute("autocomplete", isSignup ? "new-password" : "current-password");
        $("#auth-error").classList.add("hidden");
      });
    });

    // Form submit
    $("#auth-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = $("#auth-email").value.trim();
      const password = $("#auth-password").value;
      const isSignup = $(".auth-tab.active").dataset.tab === "signup";
      const errEl = $("#auth-error");
      const btn = $("#auth-submit-btn");

      errEl.classList.add("hidden");
      btn.disabled = true;
      btn.textContent = isSignup ? "Signing up…" : "Signing in…";

      try {
        let result;
        if (isSignup) {
          result = await supabase.auth.signUp({ email, password });
        } else {
          result = await supabase.auth.signInWithPassword({ email, password });
        }

        if (result.error) {
          errEl.textContent = result.error.message;
          errEl.classList.remove("hidden");
        } else if (isSignup && result.data?.user && !result.data.session) {
          errEl.textContent = "Check your email for a confirmation link.";
          errEl.classList.remove("hidden");
          errEl.style.color = "var(--green)";
        }
        // If sign in succeeds, the onAuthStateChange listener handles the rest
      } catch (err) {
        errEl.textContent = "Network error. Please try again.";
        errEl.classList.remove("hidden");
      } finally {
        btn.disabled = false;
        btn.textContent = isSignup ? "Sign Up" : "Sign In";
      }
    });

    // Skip auth
    $("#skip-auth-btn").addEventListener("click", () => {
      enterApp();
    });
  }

  function showUserBar() {
    if (!currentUser) {
      $("#user-bar").classList.add("hidden");
      return;
    }
    $("#user-email").textContent = currentUser.email;
    $("#user-bar").classList.remove("hidden");
  }

  async function enterApp() {
    console.log("[DEBUG] enterApp: Starting app initialization...");
    if (appEntered) {
      console.log("[DEBUG] enterApp: Already entered, skipping");
      return;
    }
    appEntered = true;
    showDebugPanel();
    console.log("[DEBUG] enterApp: Showing home screen");
    showScreen("home");
    console.log("[DEBUG] enterApp: Loading local progress");
    loadProgress();

    try {
      if (currentUser) {
        console.log("[DEBUG] enterApp: User logged in, pulling remote state...");
        await pullState();
        console.log("[DEBUG] enterApp: Remote state synced");
      } else {
        console.log("[DEBUG] enterApp: Running in offline mode (no user)");
      }

      console.log("[DEBUG] enterApp: Loading manifest...");
      await loadManifest();
      console.log("[DEBUG] enterApp: Loading all decks in parallel...");
      const startTime = performance.now();
      await Promise.all(manifest.decks.map((d) => loadDeck(d.id)));
      const elapsed = (performance.now() - startTime).toFixed(2);
      console.log("[DEBUG] enterApp: All", manifest.decks.length, "decks loaded in", elapsed + "ms");
    } catch (e) {
      console.error("[ERROR] enterApp: Failed to load app data:", e);
      appEntered = false;
      return;
    }

    console.log("[DEBUG] enterApp: Showing user bar");
    showUserBar();
    console.log("[DEBUG] enterApp: Binding events");
    bindEvents();
    condensedMode = localStorage.getItem(CONDENSED_KEY) === "true";
    applyCondensedMode();
    console.log("[DEBUG] enterApp: Rendering home with", Object.keys(decks).length, "decks loaded");
    renderHome();
    hideDebugPanel();
    console.log("[DEBUG] enterApp: App fully initialized");
  }

  // ── Event binding ──────────────────────────────────────────────
  function bindEvents() {
    // Condensed mode toggle
    $("#condensed-toggle-btn").addEventListener("click", () => {
      condensedMode = !condensedMode;
      localStorage.setItem(CONDENSED_KEY, condensedMode);
      applyCondensedMode();
    });

    // Reveal answer
    $("#reveal-btn").addEventListener("click", revealCard);

    // Rating buttons
    $$(".btn-rating").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        rateCard(btn.dataset.rating);
      });
    });

    // Back to home
    $("#back-home-btn").addEventListener("click", () => {
      currentDeckId = null;
      currentDeckMode = DECK_MODE_NORMAL;
      currentDeckCardIndices = [];
      currentCard = null;
      renderHome();
      showScreen("home");
    });

    // Mark incorrect
    $("#mark-incorrect-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      markIncorrect();
    });

    // Toggle highlight on current card
    $("#toggle-highlight-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      toggleCurrentCardHighlight();
    });

    // Empty highlighted deck for current deck
    $("#clear-highlighted-btn").addEventListener("click", () => {
      clearHighlightedDeck();
    });

    // Download highlighted cards
    $("#download-highlighted-btn").addEventListener("click", downloadHighlightedLines);

    // View incorrect cards
    $("#view-incorrect-btn").addEventListener("click", () => {
      renderIncorrectScreen();
      showScreen("incorrect");
    });

    // Back from incorrect screen
    $("#back-home-btn-incorrect").addEventListener("click", () => {
      renderHome();
      showScreen("home");
    });

    // Download incorrect lines
    $("#download-incorrect-btn").addEventListener("click", downloadIncorrectLines);

    // Clear all incorrect marks
    $("#clear-incorrect-btn").addEventListener("click", () => {
      if (confirm("Restore all incorrect cards? They will appear in decks again.")) {
        incorrect = {};
        saveIncorrect();
        renderIncorrectScreen();
      }
    });

    // Reset progress
    $("#reset-progress-btn").addEventListener("click", () => {
      if (confirm("Reset all progress? This cannot be undone.")) {
        progress = {};
        saveProgress();
        decks = {};
        renderHome();
      }
    });

    // Reset current deck
    $("#reset-deck-btn").addEventListener("click", () => {
      if (!currentDeckId) return;
      const entry = manifest.decks.find((d) => d.id === currentDeckId);
      if (!confirm("Reset all progress for " + entry.name + "? This cannot be undone.")) return;
      const deck = decks[currentDeckId];
      deck.cards.forEach((_, i) => {
        delete progress[cardKey(currentDeckId, i)];
      });
      saveProgress();
      currentDeckCardIndices = getDeckCardIndices(currentDeckId, currentDeckMode);
      sessionCards = 0;
      sessionEasySet = new Set();
      showNextCard();
      updateDeckStats();
      updateProgressBar();
    });

    // Keyboard shortcuts
    document.addEventListener("keydown", (e) => {
      // Only handle shortcuts on the deck screen
      if (!$("#deck-screen").classList.contains("active")) return;

      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        if (!revealed) {
          revealCard();
        }
      } else if (revealed) {
        if (e.key === "1") rateCard("hard");
        else if (e.key === "2") rateCard("ok");
        else if (e.key === "3") rateCard("easy");
      }
    });

    // Sync now button
    $("#sync-now-btn").addEventListener("click", async () => {
      $("#sync-now-btn").disabled = true;
      await syncNow();
      $("#sync-now-btn").disabled = false;
    });

    // Logout
    $("#logout-btn").addEventListener("click", async () => {
      if (supabase) await supabase.auth.signOut();
      currentUser = null;
      appEntered = false;
      showUserBar();
      showScreen("auth");
    });
  }

  // ── Init ───────────────────────────────────────────────────────
  async function init() {
    // If Supabase is configured, set up auth listener and show auth screen
    if (supabase) {
      bindAuthEvents();

      // Check for existing session first (handles page refresh)
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user) {
        currentUser = session.user;
        await enterApp();
      }

      // Listen for future auth changes (new sign-in from form, sign-out)
      supabase.auth.onAuthStateChange((event, session) => {
        if (event === "SIGNED_IN" && session?.user) {
          currentUser = session.user;
          enterApp();
        } else if (event === "SIGNED_OUT") {
          currentUser = null;
          appEntered = false;
          showScreen("auth");
        }
      });
      // If no session, auth screen is already showing
    } else {
      // No Supabase configured — run in local-only mode
      await enterApp();
    }
  }

  init();
})();
