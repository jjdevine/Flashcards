(function () {
  "use strict";

  // ── State ──────────────────────────────────────────────────────
  const STORAGE_KEY = "flashcard_revision";
  let manifest = null;
  let decks = {};          // id -> { cards: [{front, back, tags}] }
  let progress = {};       // "deckId:cardIndex" -> { box, lastSeen }
  let currentDeckId = null;
  let currentCard = null;  // card index
  let revealed = false;

  // ── DOM refs ───────────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // ── Persistence ────────────────────────────────────────────────
  function loadProgress() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      progress = raw ? JSON.parse(raw) : {};
    } catch { progress = {}; }
  }

  function saveProgress() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(progress)); } catch {}
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
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    const cards = [];

    for (const line of lines) {
      const fields = parseCSVLine(line);
      if (fields.length < 2) continue;

      let front = fields[0].trim();
      let back = fields[1].trim();
      const tags = fields[2] ? fields[2].trim() : "";

      // Strip Anki-style prefixes (_ or ~)
      front = front.replace(/^[_~]\s*/, "");
      back = back.replace(/^[_~]\s*/, "");

      if (front && back) {
        cards.push({ front, back, tags });
      }
    }
    return cards;
  }

  // ── Data loading ───────────────────────────────────────────────
  async function loadManifest() {
    const resp = await fetch("manifest.json?v=" + Date.now());
    manifest = await resp.json();
  }

  async function loadDeck(id) {
    if (decks[id]) return decks[id];
    const entry = manifest.decks.find((d) => d.id === id);
    const resp = await fetch(entry.file + "?v=" + manifest.buildTime);
    const text = await resp.text();
    decks[id] = { cards: parseCSV(text) };
    return decks[id];
  }

  // ── Progress helpers ───────────────────────────────────────────
  function cardKey(deckId, cardIndex) {
    return deckId + ":" + cardIndex;
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
  function selectNextCard(deckId) {
    const deck = decks[deckId];
    if (!deck || !deck.cards.length) return null;

    const boxWeights = [4, 50, 5, 3, 2, 1]; // index = box
    const cardWeights = deck.cards.map((_, i) => {
      const p = applyDecay(deckId, i);
      return boxWeights[Math.min(p.box, 5)];
    });

    const total = cardWeights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;

    for (let i = 0; i < cardWeights.length; i++) {
      r -= cardWeights[i];
      if (r <= 0) return i;
    }
    return cardWeights.length - 1;
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
    showNextCard();
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
        '</div>' +
        '<div class="deck-progress-bar"><div class="deck-progress-fill" style="width:' + pct + '%"></div></div>';
      el.addEventListener("click", () => openDeck(entry.id));
      grid.appendChild(el);
    }
  }

  // ── Render: open a deck ────────────────────────────────────────
  async function openDeck(id) {
    currentDeckId = id;
    await loadDeck(id);
    const entry = manifest.decks.find((d) => d.id === id);
    $("#deck-title").textContent = entry.name;

    showNextCard();
    updateDeckStats();
    showScreen("deck");
  }

  // ── Render: show next card ─────────────────────────────────────
  function showNextCard() {
    const idx = selectNextCard(currentDeckId);
    if (idx === null) return;

    currentCard = idx;
    revealed = false;

    const card = decks[currentDeckId].cards[idx];
    $("#card-front-text").textContent = card.front;
    $("#card-back-text").textContent = card.back;
    $("#card-answer-section").classList.add("hidden");
    $("#card-hint").classList.remove("hidden");
    $("#rating-buttons").classList.add("hidden");

    updateProgressBar();
    updateDeckStats();
  }

  function revealCard() {
    if (revealed) return;
    revealed = true;
    $("#card-answer-section").classList.remove("hidden");
    $("#card-hint").classList.add("hidden");
    $("#rating-buttons").classList.remove("hidden");
  }

  // ── Progress indicators ────────────────────────────────────────
  function updateProgressBar() {
    const deck = decks[currentDeckId];
    if (!deck) return;
    const total = deck.cards.length;
    const mastered = deck.cards.filter((_, i) => applyDecay(currentDeckId, i).box >= 4).length;
    const pct = total ? Math.round((mastered / total) * 100) : 0;
    $("#progress-bar").style.width = pct + "%";
    $("#progress-text").textContent = mastered + "/" + total + " mastered";
  }

  function updateDeckStats() {
    const deck = decks[currentDeckId];
    if (!deck) return;

    const boxes = [0, 0, 0, 0, 0, 0];
    deck.cards.forEach((_, i) => {
      const p = applyDecay(currentDeckId, i);
      boxes[Math.min(p.box, 5)]++;
    });

    const total = deck.cards.length;
    const seen = total - boxes[0];

    $("#deck-progress-summary").textContent = seen + " of " + total + " cards seen";
    $("#deck-stats").innerHTML =
      '<div class="stats-grid">' +
        '<div class="stat"><span class="stat-label">New</span><span class="stat-value">' + boxes[0] + '</span></div>' +
        '<div class="stat"><span class="stat-label">Learning</span><span class="stat-value">' + (boxes[1] + boxes[2]) + '</span></div>' +
        '<div class="stat"><span class="stat-label">Known</span><span class="stat-value">' + (boxes[3] + boxes[4]) + '</span></div>' +
        '<div class="stat"><span class="stat-label">Mastered</span><span class="stat-value">' + boxes[5] + '</span></div>' +
      '</div>';
  }

  // ── Screen switching ───────────────────────────────────────────
  function showScreen(name) {
    $("#home-screen").classList.toggle("active", name === "home");
    $("#deck-screen").classList.toggle("active", name === "deck");
  }

  // ── Helpers ────────────────────────────────────────────────────
  function esc(str) {
    const el = document.createElement("span");
    el.textContent = str;
    return el.innerHTML;
  }

  // ── Event binding ──────────────────────────────────────────────
  function bindEvents() {
    // Reveal answer
    $("#flashcard").addEventListener("click", revealCard);

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
      currentCard = null;
      renderHome();
      showScreen("home");
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
  }

  // ── Init ───────────────────────────────────────────────────────
  async function init() {
    loadProgress();
    await loadManifest();

    // Pre-load all decks so the home screen can show card counts
    await Promise.all(manifest.decks.map((d) => loadDeck(d.id)));

    bindEvents();
    renderHome();
  }

  init();
})();
