(() => {
  "use strict";

  const STORAGE_KEY = "only1name-progress-v4";
  const SETTINGS_KEY = "only1name-settings-v3";

  const GROUP_SIZE = 4;
  const ROUND_SECONDS = 7;

  const $ = (id) => document.getElementById(id);


  const screens = {
    home: $("home-screen"),
    game: $("game-screen")
  };


  let contestants = [];
  let levels = [];

  let currentLevel = 0;
  let currentIndex = 0;


  /*
   * Only completed levels are remembered.
   *
   * There is intentionally NO per-person guessed state.
   */
  let completedLevels = new Set();


  let timerRemaining = ROUND_SECONDS;

  let timerInterval = null;
  let countdownInterval = null;

  let sequenceId = 0;

  let countdownRunning = false;

  let soundEnabled = true;
  let audioContext = null;


  // ============================================================
  // LOCAL STORAGE
  // ============================================================

  function safeRead(key, fallback) {
    try {
      return (
        JSON.parse(
          localStorage.getItem(key)
        ) ?? fallback
      );
    } catch {
      return fallback;
    }
  }


  function saveProgress() {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        completedLevels: [
          ...completedLevels
        ]
      })
    );
  }


  function loadProgress() {
    const progress =
      safeRead(
        STORAGE_KEY,
        {}
      );


    completedLevels =
      new Set(
        Array.isArray(
          progress.completedLevels
        )
          ? progress.completedLevels.filter(
              (levelIndex) =>
                Number.isInteger(levelIndex) &&
                levelIndex >= 0 &&
                levelIndex < levels.length
            )
          : []
      );
  }


  function resetProgress() {
    stopAllTiming();

    completedLevels.clear();

    localStorage.removeItem(
      STORAGE_KEY
    );

    currentLevel = 0;
    currentIndex = 0;

    renderLevels();

    showScreen("home");
  }


  // ============================================================
  // LEVELS
  // ============================================================

  function rebuildLevels() {
    levels = [];

    /*
     * contestants.json order is always used.
     * There is no shuffle.
     */
    for (
      let i = 0;
      i < contestants.length;
      i += GROUP_SIZE
    ) {
      levels.push(
        contestants.slice(
          i,
          i + GROUP_SIZE
        )
      );
    }
  }


  function getCurrentLevel() {
    return (
      levels[currentLevel] || []
    );
  }


  function getCurrentContestant() {
    const level =
      getCurrentLevel();

    return (
      level[currentIndex] || null
    );
  }


  function isLevelComplete(
    levelIndex
  ) {
    return completedLevels.has(
      levelIndex
    );
  }


  function renderLevels() {
    const levelsGrid =
      $("levels-grid");


    levelsGrid.innerHTML = "";


    levels.forEach(
      (level, index) => {

        const completed =
          isLevelComplete(index);


        const card =
          document.createElement(
            "button"
          );


        card.type = "button";


        card.className =
          `level-card ${
            completed
              ? "completed"
              : ""
          }`;


        card.innerHTML = `
          <span class="level-number">
            ${index + 1}
          </span>

          ${
            completed
              ? `
                <span class="level-check">
                  ✓
                </span>
              `
              : ""
          }
        `;


        card.addEventListener(
          "click",
          () => {
            startLevel(index);
          }
        );


        levelsGrid.appendChild(card);
      }
    );


    updateHomeProgress();
  }


  function updateHomeProgress() {
    const total =
      levels.length;


    const completed =
      completedLevels.size;


    $("home-progress-text")
      .textContent =
      `${completed} / ${total} LEVELS COMPLETE`;


    const percentage =
      total > 0
        ? (completed / total) * 100
        : 0;


    $("home-progress-bar")
      .style.width =
      percentage + "%";
  }


  // ============================================================
  // SCREENS
  // ============================================================

  function showScreen(name) {
    Object.entries(screens)
      .forEach(
        ([key, element]) => {
          element.classList.toggle(
            "hidden",
            key !== name
          );
        }
      );


    window.scrollTo({
      top: 0,
      behavior: "auto"
    });
  }


  // ============================================================
  // START LEVEL
  // ============================================================

  function startLevel(
    levelIndex
  ) {
    if (!levels[levelIndex]) {
      return;
    }


    stopAllTiming();


    currentLevel =
      levelIndex;


    /*
     * A level always starts from
     * its first picture.
     *
     * We do NOT resume a previous
     * contestant position.
     */
    currentIndex = 0;


    showScreen("game");


    renderContestant(true);


    startLevelCountdown();
  }


  // ============================================================
  // CONTESTANT RENDERING
  // ============================================================

  function renderContestant(
    hidePicture = false
  ) {
    const person =
      getCurrentContestant();


    if (!person) {
      showScreen("home");
      return;
    }


    stopRoundTimerOnly();


    const image =
      $("contestant-photo");


    const fallback =
      $("photo-fallback");


    if (hidePicture) {
      hidePictureElement();
    } else {
      image.classList.remove(
        "countdown-hidden"
      );
    }


    fallback.classList.add(
      "hidden"
    );


    image.onload = () => {

      image.classList.add(
        "loaded"
      );


      if (!countdownRunning) {
        showPictureElement();
      }
    };


    image.onerror = () => {

      image.classList.remove(
        "loaded"
      );


      if (!countdownRunning) {
        fallback.classList.remove(
          "hidden"
        );
      }
    };


    image.src =
      person.photo || "";


    if (
      image.complete &&
      image.naturalWidth > 0
    ) {

      image.classList.add(
        "loaded"
      );


      if (!hidePicture) {
        showPictureElement();
      }
    }


    /*
     * Reset the answer every time
     * a picture is opened.
     *
     * The person can therefore be
     * guessed again.
     */
    $("reveal-name")
      .textContent =
      person.name || "Unknown";


    $("reveal-overlay")
      .classList.add(
        "hidden"
      );


    /*
     * Level / round information.
     */
    $("level-number")
      .textContent =
      String(
        currentLevel + 1
      ).padStart(2, "0");


    $("status-level")
      .textContent =
      String(
        currentLevel + 1
      ).padStart(2, "0");


    $("round-number")
      .textContent =
      String(
        currentIndex + 1
      );


    $("round-total")
      .textContent =
      String(
        getCurrentLevel().length
      );


    $("level-total")
      .textContent =
      String(
        getCurrentLevel().length
      );


    /*
     * Previous is disabled only
     * on the first picture.
     */
    $("previous-button")
      .disabled =
      currentIndex === 0;


    /*
     * The last picture is the only
     * place where Finish Level appears.
     */
    $("next-button")
      .textContent =
      currentIndex ===
      getCurrentLevel().length - 1
        ? "FINISH LEVEL →"
        : "NEXT →";


    resetTimerDisplay();
  }


  function hidePictureElement() {
    const image =
      $("contestant-photo");


    const fallback =
      $("photo-fallback");


    image.classList.add(
      "countdown-hidden"
    );


    fallback.classList.add(
      "hidden"
    );
  }


  function showPictureElement() {
    const image =
      $("contestant-photo");


    const fallback =
      $("photo-fallback");


    image.classList.remove(
      "countdown-hidden"
    );


    if (
      image.classList.contains(
        "loaded"
      )
    ) {

      fallback.classList.add(
        "hidden"
      );

    } else {

      fallback.classList.remove(
        "hidden"
      );
    }
  }


  // ============================================================
  // ANSWER
  // ============================================================

  function revealAnswer() {
    const person =
      getCurrentContestant();


    if (!person) {
      return;
    }


    /*
     * Picture remains visible.
     */
    showPictureElement();


    $("reveal-name")
      .textContent =
      person.name || "Unknown";


    $("reveal-overlay")
      .classList.remove(
        "hidden"
      );
  }


  // ============================================================
  // NAVIGATION
  // ============================================================

  function nextPerson() {
    const level =
      getCurrentLevel();


    if (!level.length) {
      return;
    }


    /*
     * If this is the last picture,
     * NEXT becomes FINISH LEVEL.
     */
    if (
      currentIndex ===
      level.length - 1
    ) {

      finishLevel();

      return;
    }


    /*
     * Move directly to the next picture.
     *
     * There is no guessed state to remember.
     */
    stopAllTiming();


    currentIndex++;


    renderContestant(false);


    /*
     * Every time a picture is opened,
     * its 10-second timer starts fresh.
     */
    startRoundTimer();
  }


  function previousPerson() {
    if (currentIndex <= 0) {
      return;
    }


    stopAllTiming();


    currentIndex--;


    renderContestant(false);


    /*
     * Previous also starts a completely
     * fresh timer for that picture.
     */
    startRoundTimer();
  }


  function finishLevel() {
    /*
     * The level is remembered ONLY here.
     *
     * Timer completion does not finish
     * a level.
     */
    stopAllTiming();


    /*
     * Reveal the final person's name
     * before leaving the level.
     */
    revealAnswer();


    completedLevels.add(
      currentLevel
    );


    saveProgress();


    renderLevels();


    showScreen("home");
  }


  // ============================================================
  // TIMER
  // ============================================================

  function stopAllTiming() {
    sequenceId++;


    stopRoundTimerOnly();


    if (countdownInterval) {
      clearInterval(
        countdownInterval
      );
    }


    countdownInterval = null;


    countdownRunning = false;


    $("countdown-overlay")
      .classList.add(
        "hidden"
      );


    $("countdown-overlay")
      .classList.remove(
        "ending-countdown"
      );
  }


  function stopRoundTimerOnly() {
    if (timerInterval) {
      clearInterval(
        timerInterval
      );
    }


    timerInterval = null;
  }


  function resetTimerDisplay() {
    timerRemaining =
      ROUND_SECONDS;


    updateTimerDisplay();
  }


  function updateTimerDisplay() {
    $("timer-display")
      .textContent =
      timerRemaining;


    const percentage =
      (
        timerRemaining /
        ROUND_SECONDS
      ) * 100;


    $("timer-bar")
      .style.width =
      Math.max(
        0,
        percentage
      ) + "%";


    $("timer-display")
      .classList.toggle(
        "urgent",
        timerRemaining <= 3
      );


    $("timer-bar")
      .classList.toggle(
        "urgent",
        timerRemaining <= 3
      );
  }


  // ============================================================
  // LEVEL START COUNTDOWN
  // ============================================================

  function startLevelCountdown() {
    stopAllTiming();


    countdownRunning = true;


    hidePictureElement();


    $("reveal-overlay")
      .classList.add(
        "hidden"
      );


    runCountdown(() => {

      countdownRunning = false;


      showPictureElement();


      startRoundTimer();

    });
  }


  // ============================================================
  // COUNTDOWN
  // ============================================================

  function runCountdown(
    onComplete
  ) {
    const token =
      ++sequenceId;


    countdownRunning = true;


    let number = 3;


    $("countdown-number")
      .textContent =
      number;


    $("countdown-number")
      .style.animation =
      "none";


    void $("countdown-number")
      .offsetWidth;


    $("countdown-number")
      .style.animation =
      "";


    $("countdown-overlay")
      .classList.remove(
        "hidden"
      );


    $("countdown-overlay")
      .classList.remove(
        "ending-countdown"
      );


    beep(
      740,
      0.20,
      0.07
    );


    countdownInterval =
      setInterval(() => {

        if (
          token !== sequenceId
        ) {

          clearInterval(
            countdownInterval
          );

          countdownInterval = null;

          return;
        }


        number--;


        if (number > 0) {

          $("countdown-number")
            .textContent =
            number;


          $("countdown-number")
            .style.animation =
            "none";


          void $("countdown-number")
            .offsetWidth;


          $("countdown-number")
            .style.animation =
            "";


          beep(
            number === 1
              ? 980
              : 820,
            0.20,
            0.07
          );


          return;
        }


        clearInterval(
          countdownInterval
        );


        countdownInterval = null;


        $("countdown-overlay")
          .classList.add(
            "hidden"
          );


        if (
          token !== sequenceId
        ) {
          return;
        }


        countdownRunning = false;


        onComplete();

      }, 1000);
  }


  // ============================================================
  // ROUND TIMER
  // ============================================================

  function startRoundTimer() {
    stopRoundTimerOnly();


    timerRemaining =
      ROUND_SECONDS;


    updateTimerDisplay();


    const token =
      sequenceId;


    showPictureElement();


    beep(
      540,
      0.08,
      0.045
    );


    timerInterval =
      setInterval(() => {

        if (
          token !== sequenceId
        ) {

          stopRoundTimerOnly();

          return;
        }


        timerRemaining--;


        updateTimerDisplay();


        /*
         * The final 3 seconds are
         * part of the same 10-second
         * timer.
         */
        if (
          timerRemaining <= 3 &&
          timerRemaining > 0
        ) {

          showEndingCountdownNumber(
            timerRemaining
          );


          beep(
            timerRemaining === 1
              ? 980
              : 700,
            0.12,
            0.055
          );
        }


        /*
         * At zero, reveal the name.
         *
         * The level is NOT completed.
         */
        if (
          timerRemaining <= 0
        ) {

          stopRoundTimerOnly();


          hideCountdownOverlay();


          revealAnswer();


          beep(
            420,
            0.22,
            0.06
          );
        }

      }, 1000);
  }


  function showEndingCountdownNumber(
    number
  ) {
    const overlay =
      $("countdown-overlay");


    const countdownNumber =
      $("countdown-number");


    countdownNumber.textContent =
      number;


    /*
     * Very transparent so the
     * picture remains visible.
     */
    overlay.classList.add(
      "ending-countdown"
    );


    overlay.classList.remove(
      "hidden"
    );


    countdownNumber.style.animation =
      "none";


    void countdownNumber.offsetWidth;


    countdownNumber.style.animation =
      "";
  }


  function hideCountdownOverlay() {
    const overlay =
      $("countdown-overlay");


    overlay.classList.remove(
      "ending-countdown"
    );


    overlay.classList.add(
      "hidden"
    );
  }


  // ============================================================
  // SOUND
  // ============================================================

  function beep(
    frequency = 660,
    duration = 0.11,
    volume = 0.045
  ) {
    if (!soundEnabled) {
      return;
    }


    try {

      audioContext ||=
        new (
          window.AudioContext ||
          window.webkitAudioContext
        )();


      if (
        audioContext.state ===
        "suspended"
      ) {
        audioContext.resume();
      }


      const oscillator =
        audioContext.createOscillator();


      const gain =
        audioContext.createGain();


      oscillator.type =
        "sine";


      oscillator.frequency.value =
        frequency;


      gain.gain.setValueAtTime(
        volume,
        audioContext.currentTime
      );


      gain.gain.exponentialRampToValueAtTime(
        0.001,
        audioContext.currentTime +
          duration
      );


      oscillator.connect(gain);


      gain.connect(
        audioContext.destination
      );


      oscillator.start();


      oscillator.stop(
        audioContext.currentTime +
          duration
      );

    } catch (_) {
      // Audio is optional.
    }
  }


  // ============================================================
  // SETTINGS
  // ============================================================

  function loadSettings() {
    const settings =
      safeRead(
        SETTINGS_KEY,
        {}
      );


    soundEnabled =
      settings.soundEnabled !== false;


    $("sound-toggle")
      .textContent =
      soundEnabled
        ? "🔊"
        : "🔇";
  }


  function saveSettings() {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        soundEnabled
      })
    );
  }


  // ============================================================
  // LOAD CONTESTANTS
  // ============================================================

  async function loadContestants() {
    try {

      const response =
        await fetch(
          "contestants.json",
          {
            cache: "no-store"
          }
        );


      if (!response.ok) {
        throw new Error(
          "Could not load contestants.json"
        );
      }


      const data =
        await response.json();


      contestants =
        Array.isArray(data)
          ? data.filter(
              (person) =>
                person &&
                person.id &&
                person.name &&
                person.photo
            )
          : [];


    } catch (error) {

      console.error(error);

      contestants = [];
    }


    rebuildLevels();


    loadProgress();


    renderLevels();


    showScreen("home");
  }


  // ============================================================
  // EVENT LISTENERS
  // ============================================================

  $("home-button")
    .addEventListener(
      "click",
      () => {

        stopAllTiming();

        renderLevels();

        showScreen("home");
      }
    );


  $("previous-button")
    .addEventListener(
      "click",
      previousPerson
    );


  $("next-button")
    .addEventListener(
      "click",
      nextPerson
    );


  $("reset-progress-button")
    .addEventListener(
      "click",
      () => {

        const confirmed =
          window.confirm(
            "Reset all level progress?"
          );


        if (confirmed) {
          resetProgress();
        }
      }
    );


  $("sound-toggle")
    .addEventListener(
      "click",
      () => {

        soundEnabled =
          !soundEnabled;


        $("sound-toggle")
          .textContent =
          soundEnabled
            ? "🔊"
            : "🔇";


        saveSettings();


        if (soundEnabled) {
          beep();
        }
      }
    );


  // ============================================================
  // KEYBOARD
  // ============================================================

  document.addEventListener(
    "keydown",
    (event) => {

      if (
        screens.game.classList.contains(
          "hidden"
        )
      ) {
        return;
      }


      if (
        event.target.matches(
          "input, textarea, select"
        )
      ) {
        return;
      }


      if (
        event.code === "ArrowRight"
      ) {
        nextPerson();
      }


      if (
        event.code === "ArrowLeft"
      ) {
        previousPerson();
      }
    }
  );


  // ============================================================
  // INITIALIZE
  // ============================================================

  loadSettings();

  loadContestants();

})();