(() => {
  "use strict";


  /* ==========================================================
     DEMO DATA
     ========================================================== */

  const contestants = [
    {
      id: "test-001",
      name: "Brendan",
      photo: "test-photos/test-001.PNG"
    },
    {
      id: "test-002",
      name: "Hof",
      photo: "test-photos/test-002.PNG"
    },
    {
      id: "test-003",
      name: "Eric",
      photo: "test-photos/test-003.PNG"
    },
    {
      id: "test-004",
      name: "Hofmann",
      photo: "test-photos/test-004.PNG"
    },
    {
      id: "test-005",
      name: "I ate a lot of food",
      photo: "test-photos/test-005.PNG"
    },
    {
      id: "test-006",
      name: "Jerry",
      photo: "test-photos/test-006.PNG"
    },
    {
      id: "test-007",
      name: "Lil Huss",
      photo: "test-photos/test-007.PNG"
    },
    {
      id: "test-008",
      name: "Brian",
      photo: "test-photos/test-008.PNG"
    }
  ];


  /* ==========================================================
     SETTINGS
     ========================================================== */

  const STORAGE_KEY = "only1name-demo-progress-v1";
  const SETTINGS_KEY = "only1name-demo-settings-v1";

  const GROUP_SIZE = 4;
  const ROUND_SECONDS = 10;


  /* ==========================================================
     ELEMENTS
     ========================================================== */

  const $ = (id) =>
    document.getElementById(id);


  const screens = {
    home: $("home-screen"),
    game: $("game-screen")
  };


  /* ==========================================================
     STATE
     ========================================================== */

  let levels = [];

  let currentLevel = 0;
  let currentIndex = 0;

  let completedLevels = new Set();

  let timerRemaining = ROUND_SECONDS;

  let timerInterval = null;
  let countdownInterval = null;

  let sequenceId = 0;

  let countdownRunning = false;

  let soundEnabled = true;

  let audioContext = null;


  /* ==========================================================
     STORAGE
     ========================================================== */

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
                Number.isInteger(
                  levelIndex
                ) &&
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


  /* ==========================================================
     LEVELS
     ========================================================== */

  function rebuildLevels() {

    levels = [];

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


  /* ==========================================================
     HOME SCREEN
     ========================================================== */

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
              ? `<span class="level-check">✓</span>`
              : ""
          }
        `;


        card.addEventListener(
          "click",
          () => {
            startLevel(index);
          }
        );


        levelsGrid.appendChild(
          card
        );
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


  /* ==========================================================
     SCREEN CONTROL
     ========================================================== */

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


  /* ==========================================================
     START LEVEL
     ========================================================== */

  function startLevel(levelIndex) {

    if (!levels[levelIndex]) {
      return;
    }


    stopAllTiming();


    currentLevel =
      levelIndex;

    currentIndex = 0;


    showScreen("game");


    renderContestant(true);


    startLevelCountdown();
  }


  /* ==========================================================
     CONTESTANT
     ========================================================== */

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


    $("reveal-name")
      .textContent =
      person.name || "Unknown";


    $("reveal-overlay")
      .classList.add(
        "hidden"
      );


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


    $("previous-button")
      .disabled =
      currentIndex === 0;


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


  /* ==========================================================
     ANSWER
     ========================================================== */

  function revealAnswer() {

    const person =
      getCurrentContestant();


    if (!person) {
      return;
    }


    showPictureElement();


    $("reveal-name")
      .textContent =
      person.name || "Unknown";


    $("reveal-overlay")
      .classList.remove(
        "hidden"
      );
  }


  /* ==========================================================
     NAVIGATION
     ========================================================== */

  function nextPerson() {

    const level =
      getCurrentLevel();


    if (!level.length) {
      return;
    }


    if (
      currentIndex ===
      level.length - 1
    ) {

      finishLevel();

      return;
    }


    stopAllTiming();


    currentIndex++;


    renderContestant(false);


    startRoundTimer();
  }


  function previousPerson() {

    if (currentIndex <= 0) {
      return;
    }


    stopAllTiming();


    currentIndex--;


    renderContestant(false);


    startRoundTimer();
  }


  function finishLevel() {

    stopAllTiming();


    completedLevels.add(
      currentLevel
    );


    saveProgress();


    renderLevels();


    showScreen("home");
  }


  /* ==========================================================
     TIMING
     ========================================================== */

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


  /* ==========================================================
     START COUNTDOWN
     ========================================================== */

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

          countdownInterval =
            null;

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


        countdownInterval =
          null;


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


  /* ==========================================================
     ROUND TIMER
     ========================================================== */

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


  /* ==========================================================
     SOUND
     ========================================================== */

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

    } catch (_) {}
  }


  /* ==========================================================
     SETTINGS
     ========================================================== */

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


  /* ==========================================================
     EVENTS
     ========================================================== */

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
            "Reset all demo progress?"
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
        event.code ===
        "ArrowRight"
      ) {

        nextPerson();
      }


      if (
        event.code ===
        "ArrowLeft"
      ) {

        previousPerson();
      }
    }
  );


  /* ==========================================================
     START
     ========================================================== */

  rebuildLevels();

  loadProgress();

  loadSettings();

  renderLevels();

  showScreen("home");

})();