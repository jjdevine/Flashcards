(function () {
  "use strict";

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
  let manifest = null;
  let decks = {};          // id -> { cards: [{front, back, tags, rawLine, deckId, cardIndex}] }
  let progress = {};       // "deckId:cardIndex" -> { box, lastSeen }
  let incorrect = {};      // "deckId:cardIndex" -> { front, back, rawLine, deckFile }
  let currentDeckId = null;
  let currentCard = null;  // card index
  let revealed = false;
  let sessionCards = 0;    // cards viewed in the current deck session
  let sessionEasySet = new Set(); // card indices rated "very easy" this session

  // ── DOM refs ───────────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // ── Persistence ────────────────────────────────────────────────
  function loadProgress() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      progress = raw ? JSON.parse(raw) : {};
    } catch { progress = {}; }
    try {
      const raw = localStorage.getItem(INCORRECT_KEY);
      incorrect = raw ? JSON.parse(raw) : {};
    } catch { incorrect = {}; }
  }

  function saveProgressLocal() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(progress)); } catch {}
  }

  function saveIncorrectLocal() {
    try { localStorage.setItem(INCORRECT_KEY, JSON.stringify(incorrect)); } catch {}
  }

  function saveProgress() {
    saveProgressLocal();
    debouncedSync();
  }

  function saveIncorrect() {
    saveIncorrectLocal();
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
      const { error } = await supabase.from("user_state").upsert({
        user_id: currentUser.id,
        progress_data: progress,
        incorrect_data: incorrect,
        updated_at: new Date().toISOString(),
      });
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
        .select("progress_data, incorrect_data")
        .eq("user_id", currentUser.id)
        .maybeSingle();

      if (error) { console.error("Sync pull error:", error.message); return; }
      if (!data) return; // No remote state yet

      mergeProgress(data.progress_data || {});
      mergeIncorrect(data.incorrect_data || {});
      saveProgressLocal();
      saveIncorrectLocal();
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
        cards.push({ front, back, tags, rawLine: line });
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
      if (incorrect[cardKey(deckId, i)]) return 0; // skip incorrect cards
      if (sessionEasySet.has(i)) return 0; // skip "very easy" cards this session
      const p = applyDecay(deckId, i);
      return boxWeights[Math.min(p.box, 5)];
    });

    let total = cardWeights.reduce((a, b) => a + b, 0);

    // If only "very easy" cards remain, allow them back in
    if (total === 0 && sessionEasySet.size > 0) {
      sessionEasySet.clear();
      deck.cards.forEach((_, i) => {
        if (incorrect[cardKey(deckId, i)]) { cardWeights[i] = 0; return; }
        const p = applyDecay(deckId, i);
        cardWeights[i] = boxWeights[Math.min(p.box, 5)];
      });
      total = cardWeights.reduce((a, b) => a + b, 0);
    }

    if (total === 0) return null; // all cards are incorrect
    let r = Math.random() * total;

    for (let i = 0; i < cardWeights.length; i++) {
      r -= cardWeights[i];
      if (r <= 0) return i;
    }
    return cardWeights.length - 1;
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
    sessionCards = 0;
    sessionEasySet = new Set();

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
    sessionCards++;

    const card = decks[currentDeckId].cards[idx];
    $("#card-front-text").textContent = card.front;
    $("#card-back-text").textContent = card.back;
    $("#card-answer-section").classList.add("hidden");
    $("#card-hint").classList.remove("hidden");
    $("#rating-buttons").classList.add("hidden");
    $("#mark-incorrect-area").classList.add("hidden");

    updateProgressBar();
    updateDeckStats();
  }

  function revealCard() {
    if (revealed) return;
    revealed = true;
    $("#card-answer-section").classList.remove("hidden");
    $("#card-hint").classList.add("hidden");
    $("#rating-buttons").classList.remove("hidden");
    $("#mark-incorrect-area").classList.remove("hidden");
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
    if (appEntered) return;
    appEntered = true;
    showScreen("home");
    loadProgress();

    if (currentUser) {
      await pullState();
    }

    await loadManifest();
    await Promise.all(manifest.decks.map((d) => loadDeck(d.id)));

    showUserBar();
    bindEvents();
    renderHome();
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

    // Mark incorrect
    $("#mark-incorrect-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      markIncorrect();
    });

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

      supabase.auth.onAuthStateChange(async (event, session) => {
        if (session?.user) {
          currentUser = session.user;
          // Only auto-enter on initial load or sign-in
          if (event === "SIGNED_IN" || event === "INITIAL_SESSION") {
            await enterApp();
          }
        }
      });

      // Check for existing session
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user) {
        currentUser = session.user;
        await enterApp();
      }
      // If no session, auth screen is already showing
    } else {
      // No Supabase configured — run in local-only mode
      await enterApp();
    }
  }

  init();
})();
