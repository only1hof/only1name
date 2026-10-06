(() => {
  "use strict";
  const STORAGE_KEY = "only1name-progress-v1";
  const SETTINGS_KEY = "only1name-settings-v1";
  const $ = (id) => document.getElementById(id);
  const screens = { home: $("home-screen"), game: $("game-screen"), empty: $("empty-screen") };

  let contestants = [];
  let order = [];
  let currentIndex = 0;
  let guessed = new Set();
  let revealed = new Set();
  let seconds = 10;
  let timerRemaining = 10;
  let timerInterval = null;
  let timerRunning = false;
  let soundEnabled = true;
  let audioContext = null;
  let countdownRunning = false;

  const safeRead = (key, fallback) => {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  };
  const save = () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      order, currentIndex, guessed: [...guessed], revealed: [...revealed]
    }));
    updateHomeStats();
  };
  const current = () => contestants[order[currentIndex]];
  const showScreen = (name) => {
    Object.entries(screens).forEach(([key, node]) => node.classList.toggle("hidden", key !== name));
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  function updateHomeStats() {
    $("home-guessed").textContent = guessed.size;
    $("home-total").textContent = contestants.length;
    const pct = contestants.length ? Math.round(guessed.size / contestants.length * 100) : 0;
    $("home-progress").textContent = pct + "%";
    $("home-progress-bar").style.width = pct + "%";
    $("game-guessed").textContent = guessed.size;
    $("game-remaining").textContent = Math.max(0, contestants.length - guessed.size);
    $("footer-count").textContent = `${contestants.length} CONTESTANTS`;
    const hasProgress = order.length > 0 && currentIndex >= 0;
    $("resume-button").classList.toggle("hidden", !hasProgress || contestants.length === 0);
    $("start-button").textContent = hasProgress ? "START NEW RUN" : "START GAME";
  }
  function buildOrder() {
    order = contestants.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    currentIndex = 0;
    revealed = new Set();
    stopTimer();
    resetTimer();
    save();
  }
  function beginGame(resume) {
    if (!contestants.length) { showScreen("empty"); return; }
    if (!resume || order.length !== contestants.length) buildOrder();
    renderContestant();
    showScreen("game");
  }
  function renderContestant() {
    if (!contestants.length || !order.length) return;
    stopTimer();
    resetTimer();
    const person = current();
    const image = $("contestant-photo");
    image.classList.remove("loaded");
    image.onload = () => {
      image.classList.add("loaded");
      $("photo-fallback").classList.add("hidden");
    };
    image.onerror = () => {
      image.classList.remove("loaded");
      $("photo-fallback").classList.remove("hidden");
    };
    image.src = person.photo || "";
    image.alt = "Photo of mystery contestant";
    if (image.complete && image.naturalWidth > 0) image.onload();
    $("photo-fallback").classList.toggle("hidden", image.complete && image.naturalWidth > 0);
    $("reveal-name").textContent = person.name || "Name not provided";
    $("reveal-twitch").textContent = person.twitch ? "@" + person.twitch.replace(/^@/, "") : "";
    $("reveal-overlay").classList.toggle("hidden", !revealed.has(person.id));
    $("guessed-badge").classList.toggle("hidden", !guessed.has(person.id));
    $("round-number").textContent = String(currentIndex + 1).padStart(2, "0");
    $("round-total").textContent = " / " + contestants.length;
    $("game-progress-bar").style.width = ((currentIndex + 1) / contestants.length * 100) + "%";
    $("previous-button").disabled = currentIndex === 0;
    $("next-button").textContent = currentIndex === contestants.length - 1 ? "FINISH RUN ✓" : "NEXT PERSON →";
    $("timer-mode").textContent = seconds === 5 ? "HARDCORE MODE" : seconds === 15 ? "EASY MODE" : "NORMAL MODE";
    $("photo-caption-text").textContent = guessed.has(person.id) ? "Already guessed · review anytime" : "A member of Hof's community";
    $("guessed-button").textContent = guessed.has(person.id) ? "✓ GUESSED — UNDO" : "✓ MARK AS GUESSED";
    updateHomeStats();
    save();
  }
  function revealAnswer() {
    const person = current();
    if (!person) return;
    revealed.add(person.id);
    $("reveal-overlay").classList.remove("hidden");
    save();
  }
  function markGuessed() {
    const person = current();
    if (!person) return;
    if (guessed.has(person.id)) guessed.delete(person.id);
    else { guessed.add(person.id); revealed.add(person.id); }
    $("guessed-badge").classList.toggle("hidden", !guessed.has(person.id));
    $("guessed-button").textContent = guessed.has(person.id) ? "✓ GUESSED — UNDO" : "✓ MARK AS GUESSED";
    $("photo-caption-text").textContent = guessed.has(person.id) ? "Already guessed · review anytime" : "A member of Hof's community";
    updateHomeStats();
    save();
  }
  function nextPerson() {
    if (currentIndex < contestants.length - 1) {
      currentIndex++;
      renderContestant();
    } else {
      stopTimer();
      renderReview();
      $("review-panel").classList.remove("hidden");
      $("review-panel").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }
  function previousPerson() {
    if (currentIndex > 0) { currentIndex--; renderContestant(); }
  }
  function resetTimer() {
    stopTimer();
    timerRemaining = seconds;
    updateTimerDisplay();
    $("timer-start").textContent = "▶ START TIMER";
    $("timer-start").disabled = false;
    $("countdown-overlay").classList.add("hidden");
    countdownRunning = false;
  }
  function stopTimer() {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = null;
    timerRunning = false;
  }
  function updateTimerDisplay() {
    $("timer-display").innerHTML = `${timerRemaining}<span>s</span>`;
    $("timer-display").classList.toggle("urgent", timerRemaining <= 3);
    $("timer-bar").style.width = (timerRemaining / seconds * 100) + "%";
    $("timer-bar").style.background = timerRemaining <= 3
      ? "linear-gradient(90deg,#ff657a,#ff9c7a)"
      : "linear-gradient(90deg,var(--purple),var(--pink))";
  }
  function beep(freq = 660, duration = .11, volume = .045) {
    if (!soundEnabled) return;
    try {
      audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
      if (audioContext.state === "suspended") audioContext.resume();
      const osc = audioContext.createOscillator();
      const gain = audioContext.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(volume, audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(.001, audioContext.currentTime + duration);
      osc.connect(gain); gain.connect(audioContext.destination);
      osc.start(); osc.stop(audioContext.currentTime + duration);
    } catch (_) {}
  }
  function startTimer() {
    if (timerRunning || countdownRunning) return;
    if (timerRemaining <= 0) resetTimer();
    timerRunning = true;
    $("timer-start").textContent = "Ⅱ PAUSE TIMER";
    $("timer-start").disabled = false;
    beep(540, .08);
    timerInterval = setInterval(() => {
      if (!timerRunning) return;
      timerRemaining--;
      updateTimerDisplay();
      if (timerRemaining > 0 && timerRemaining <= 3) beep(timerRemaining === 1 ? 880 : 700, .12, .06);
      if (timerRemaining <= 0) {
        stopTimer();
        $("timer-start").textContent = "TIME'S UP";
        $("timer-start").disabled = true;
        runFinalCountdown();
      }
    }, 1000);
  }
  function runFinalCountdown() {
    countdownRunning = true;
    let n = 3;
    $("countdown-number").textContent = n;
    $("countdown-overlay").classList.remove("hidden");
    beep(740, .22, .08);
    const count = () => {
      n--;
      if (n > 0) {
        $("countdown-number").textContent = n;
        $("countdown-number").style.animation = "none";
        void $("countdown-number").offsetWidth;
        $("countdown-number").style.animation = "";
        beep(n === 1 ? 980 : 820, .22, .08);
        setTimeout(count, 800);
      } else {
        $("countdown-overlay").classList.add("hidden");
        countdownRunning = false;
        revealAnswer();
        $("timer-start").textContent = "↻ TRY AGAIN";
        $("timer-start").disabled = false;
        beep(420, .28, .07);
      }
    };
    setTimeout(count, 800);
  }
  function renderReview() {
    const list = $("review-list");
    list.replaceChildren();
    const items = contestants.filter(p => guessed.has(p.id));
    if (!items.length) {
      const empty = document.createElement("p");
      empty.className = "fine-print";
      empty.textContent = "No guessed people yet. Mark a contestant as guessed to track them here.";
      list.append(empty);
      return;
    }
    items.forEach(person => {
      const card = document.createElement("button");
      card.className = "review-person";
      const img = document.createElement("img");
      img.src = person.photo || "";
      img.alt = "";
      img.onerror = () => { img.style.visibility = "hidden"; };
      const name = document.createElement("strong");
      name.textContent = person.name || "Unknown";
      const label = document.createElement("span");
      label.textContent = "✓ GUESSED";
      card.append(img, name, label);
      card.addEventListener("click", () => {
        const originalIndex = order.findIndex(i => contestants[i].id === person.id);
        if (originalIndex >= 0) {
          currentIndex = originalIndex;
          revealed.add(person.id);
          renderContestant();
          $("review-panel").classList.add("hidden");
          window.scrollTo({ top: 0, behavior: "smooth" });
        }
      });
      list.append(card);
    });
  }
  function loadSettings() {
    const settings = safeRead(SETTINGS_KEY, {});
    seconds = [5, 10, 15].includes(settings.seconds) ? settings.seconds : 10;
    soundEnabled = settings.soundEnabled !== false;
    document.querySelectorAll(".difficulty").forEach(btn => {
      btn.classList.toggle("selected", Number(btn.dataset.seconds) === seconds);
    });
    $("sound-toggle").textContent = soundEnabled ? "🔊" : "🔇";
    resetTimer();
  }
  function saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ seconds, soundEnabled }));
  }
  async function loadContestants() {
    try {
      const response = await fetch("contestants.json", { cache: "no-store" });
      if (!response.ok) throw new Error("Could not load contestants.json");
      const data = await response.json();
      contestants = Array.isArray(data) ? data.filter(p => p && p.id && p.name) : [];
    } catch (error) {
      console.error(error);
      contestants = [];
    }
    const progress = safeRead(STORAGE_KEY, {});
    const validIds = new Set(contestants.map(p => p.id));
    guessed = new Set((progress.guessed || []).filter(id => validIds.has(id)));
    revealed = new Set((progress.revealed || []).filter(id => validIds.has(id)));
    order = Array.isArray(progress.order) ? progress.order.filter(i => Number.isInteger(i) && i >= 0 && i < contestants.length) : [];
    if (order.length !== contestants.length || new Set(order).size !== contestants.length) order = [];
    currentIndex = Math.min(Math.max(0, Number(progress.currentIndex) || 0), Math.max(0, order.length - 1));
    updateHomeStats();
    showScreen("home");
  }

  document.querySelectorAll(".difficulty").forEach(btn => btn.addEventListener("click", () => {
    seconds = Number(btn.dataset.seconds);
    document.querySelectorAll(".difficulty").forEach(b => b.classList.toggle("selected", b === btn));
    saveSettings();
  }));
  $("start-button").addEventListener("click", () => beginGame(false));
  $("resume-button").addEventListener("click", () => beginGame(true));
  $("home-button").addEventListener("click", () => { stopTimer(); $("review-panel").classList.add("hidden"); updateHomeStats(); showScreen("home"); });
  $("empty-home-button").addEventListener("click", () => showScreen("home"));
  $("previous-button").addEventListener("click", previousPerson);
  $("next-button").addEventListener("click", nextPerson);
  $("reveal-button").addEventListener("click", revealAnswer);
  $("guessed-button").addEventListener("click", markGuessed);
  $("timer-start").addEventListener("click", () => {
    if (timerRemaining <= 0) resetTimer();
    if (timerRunning) {
      stopTimer();
      $("timer-start").textContent = "▶ RESUME TIMER";
    } else startTimer();
  });
  $("timer-reset").addEventListener("click", resetTimer);
  $("sound-toggle").addEventListener("click", () => {
    soundEnabled = !soundEnabled;
    $("sound-toggle").textContent = soundEnabled ? "🔊" : "🔇";
    saveSettings();
    if (soundEnabled) beep();
  });
  $("review-button").addEventListener("click", () => { renderReview(); $("review-panel").classList.remove("hidden"); $("review-panel").scrollIntoView({ behavior: "smooth", block: "start" }); });
  $("close-review").addEventListener("click", () => $("review-panel").classList.add("hidden"));
  document.addEventListener("keydown", event => {
    if (screens.game.classList.contains("hidden")) return;
    if (event.target.matches("input,textarea,select")) return;
    if (event.code === "ArrowRight") nextPerson();
    if (event.code === "ArrowLeft") previousPerson();
    if (event.code === "Space") { event.preventDefault(); revealAnswer(); }
    if (event.key.toLowerCase() === "g") markGuessed();
    if (event.key.toLowerCase() === "t") {
      if (timerRemaining <= 0) resetTimer();
      if (timerRunning) { stopTimer(); $("timer-start").textContent = "▶ RESUME TIMER"; }
      else startTimer();
    }
  });
  loadSettings();
  loadContestants();
})();
