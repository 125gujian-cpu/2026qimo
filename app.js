(() => {
  "use strict";

  const DB_NAME = "combined-law-quiz-db";
  const DB_VERSION = 1;
  const STORE_NAME = "kv";
  const STATE_KEY = "study-state-v1";
  const DEFAULT_STATE = {
    schemaVersion: 1,
    progress: {},
    activeSession: null,
    lastSession: null,
    settings: { streakTarget: 3 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  let data = null;
  let state = null;
  let db = null;
  let installPrompt = null;
  let storageMode = "IndexedDB";
  let storagePersisted = false;
  const subjectMap = new Map();
  const questionMap = new Map();
  const chapterMap = new Map();

  const main = document.getElementById("main");
  const bottomNav = document.getElementById("bottom-nav");
  const toastEl = document.getElementById("toast");
  const modalRoot = document.getElementById("modal-root");
  const importInput = document.getElementById("import-file");

  const now = () => new Date().toISOString();
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const esc = (value) =>
    String(value ?? "").replace(/[&<>'"]/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;",
    })[char]);
  const pct = (part, total) => (total ? Math.round((part / total) * 100) : 0);
  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
  const shuffle = (items) => {
    const copy = [...items];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const random = Math.floor(Math.random() * (index + 1));
      [copy[index], copy[random]] = [copy[random], copy[index]];
    }
    return copy;
  };

  function allQuestions(subject) {
    return subject.chapters.flatMap((chapter) => chapter.questions);
  }

  async function openDatabase() {
    if (!("indexedDB" in window)) {
      storageMode = "localStorage 兼容模式";
      return null;
    }
    try {
      return await new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains(STORE_NAME)) {
            database.createObjectStore(STORE_NAME, { keyPath: "key" });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } catch {
      storageMode = "localStorage 兼容模式";
      return null;
    }
  }

  async function readState() {
    if (!db) {
      try {
        return JSON.parse(localStorage.getItem(STATE_KEY));
      } catch {
        return null;
      }
    }
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const request = tx.objectStore(STORE_NAME).get(STATE_KEY);
      request.onsuccess = () => resolve(request.result?.value || null);
      request.onerror = () => reject(request.error);
    });
  }

  async function save() {
    if (!state) return;
    state.updatedAt = now();
    if (!db) {
      localStorage.setItem(STATE_KEY, JSON.stringify(state));
      return;
    }
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const request = tx.objectStore(STORE_NAME).put({ key: STATE_KEY, value: state });
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  function defaultProgress() {
    return {
      attempts: 0,
      correct: 0,
      wrong: 0,
      lastCorrect: null,
      lastSelected: [],
      lastAnsweredAt: null,
      inWrongBook: false,
      reviewStreak: 0,
      starred: false,
    };
  }

  function normalizeState(saved) {
    const next = { ...clone(DEFAULT_STATE), ...(saved && typeof saved === "object" ? saved : {}) };
    next.settings = { ...DEFAULT_STATE.settings, ...(saved?.settings || {}) };
    next.settings.streakTarget = clamp(Number(next.settings.streakTarget) || 3, 1, 5);
    next.progress = saved?.progress && typeof saved.progress === "object" ? saved.progress : {};
    Object.keys(next.progress).forEach((uid) => {
      if (!questionMap.has(uid)) delete next.progress[uid];
    });
    if (next.activeSession?.questionUids) {
      next.activeSession.questionUids = next.activeSession.questionUids.filter((uid) => questionMap.has(uid));
      if (!next.activeSession.questionUids.length) next.activeSession = null;
    }
    return next;
  }

  function getProgress(uid) {
    if (!state.progress[uid]) state.progress[uid] = defaultProgress();
    return state.progress[uid];
  }

  function toast(message) {
    toastEl.textContent = message;
    toastEl.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => toastEl.classList.remove("show"), 1800);
  }

  function modal({ title, body, confirmText = "确定", cancelText = "取消", danger = false, onConfirm }) {
    modalRoot.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal">
          <h2>${esc(title)}</h2>
          <div>${body}</div>
          <div class="modal-actions">
            <button class="secondary-btn" data-modal-cancel type="button">${esc(cancelText)}</button>
            <button class="${danger ? "danger-btn" : "primary-btn dark"}" data-modal-confirm type="button">${esc(confirmText)}</button>
          </div>
        </div>
      </div>`;
    modalRoot.querySelector("[data-modal-cancel]").onclick = () => { modalRoot.innerHTML = ""; };
    modalRoot.querySelector(".modal-backdrop").onclick = (event) => {
      if (event.target === event.currentTarget) modalRoot.innerHTML = "";
    };
    modalRoot.querySelector("[data-modal-confirm]").onclick = async () => {
      modalRoot.innerHTML = "";
      if (onConfirm) await onConfirm();
    };
  }

  function setHash(route) {
    location.hash = `#/${route}`;
  }

  function parseRoute() {
    const parts = location.hash.replace(/^#\//, "").split("/").filter(Boolean);
    return parts.length ? parts : ["home"];
  }

  function currentSubjectId() {
    const parts = parseRoute();
    if (parts[0] === "subject") return parts[1];
    if (state.activeSession?.subjectId && parts[0] === "practice") return state.activeSession.subjectId;
    return null;
  }

  function subjectById(id) {
    return subjectMap.get(id) || data.subjects[0];
  }

  function subjectStats(subject) {
    return statsFor(allQuestions(subject).map((question) => question.uid));
  }

  function statsFor(uids) {
    let attempts = 0;
    let correct = 0;
    let answered = 0;
    let wrongBook = 0;
    let starred = 0;
    uids.forEach((uid) => {
      const progress = state.progress[uid];
      if (!progress) return;
      attempts += progress.attempts || 0;
      correct += progress.correct || 0;
      if (progress.attempts) answered += 1;
      if (progress.inWrongBook) wrongBook += 1;
      if (progress.starred) starred += 1;
    });
    return { attempts, correct, answered, wrongBook, starred, accuracy: pct(correct, attempts) };
  }

  function chapterStats(chapter) {
    return statsFor(chapter.questions.map((question) => question.uid));
  }

  function typeLabel(question) {
    return question.type === "multiple" ? "多选题" : "单选题";
  }

  function modeName(mode) {
    return {
      sequential: "顺序练习",
      unanswered: "未做题",
      random: "随机练习",
      wrong: "错题复刷",
      starred: "收藏题",
    }[mode] || "练习";
  }

  function renderTopline(subject = null) {
    const tabs = data.subjects.map((item) => `
      <button class="subject-tab ${subject?.id === item.id ? "active" : ""}" data-subject-switch="${item.id}" type="button">${esc(item.name)}</button>
    `).join("");
    return `
      <div class="topline">
        <a class="mini-brand" href="#/home">
          <span class="brand-mark">法</span>
          <span>部门法期末刷题</span>
        </a>
        <div class="subject-tabs">${tabs}<button class="subject-tab" data-route="data" type="button">数据</button></div>
      </div>`;
  }

  function bindTopline() {
    main.querySelectorAll("[data-subject-switch]").forEach((button) => {
      button.onclick = () => setHash(`subject/${button.dataset.subjectSwitch}`);
    });
    main.querySelectorAll("[data-route]").forEach((button) => {
      button.onclick = () => setHash(button.dataset.route);
    });
  }

  function renderHome() {
    const total = data.subjects.reduce((sum, subject) => sum + subject.total, 0);
    const allUids = data.subjects.flatMap((subject) => allQuestions(subject).map((question) => question.uid));
    const stats = statsFor(allUids);
    bottomNav.classList.add("hidden");
    main.innerHTML = `
      <section class="home-hero">
        <h1>部门法期末刷题</h1>
        <p>一个网址刷两个部门法：行政法 ${subjectMap.get("admin").total} 题，国际法 ${subjectMap.get("intl").total} 题。两套题库、进度、错题和收藏互相隔离，不会串题。</p>
        <div class="hero-actions">
          <button class="primary-btn" data-start-any type="button">综合随机 20 题</button>
          <button class="secondary-btn" data-route="data" type="button">导入 / 导出记录</button>
        </div>
      </section>
      <section class="stats-grid">
        <div class="stat-card"><span>总题量</span><strong>${total}</strong><small>两科合计</small></div>
        <div class="stat-card"><span>已覆盖</span><strong>${stats.answered}/${total}</strong><small>${pct(stats.answered, total)}%</small></div>
        <div class="stat-card"><span>累计作答</span><strong>${stats.attempts}</strong><small>次</small></div>
        <div class="stat-card"><span>当前错题</span><strong>${stats.wrongBook}</strong><small>两科合计</small></div>
      </section>
      <div class="section-head">
        <div><h2>选择部门法</h2><p>进入科目后再按章节、题型和错题本练习。</p></div>
      </div>
      <section class="subject-grid">${data.subjects.map(subjectCard).join("")}</section>`;
    bindTopline();
    main.querySelector("[data-start-any]").onclick = () => {
      const uids = shuffle(data.subjects.flatMap((subject) => allQuestions(subject).map((question) => question.uid))).slice(0, 20);
      startSession({ questionUids: uids, mode: "random", subjectId: null, title: "两科综合随机 20 题" });
    };
  }

  function subjectCard(subject) {
    const stats = subjectStats(subject);
    return `
      <article class="subject-card">
        <button data-open-subject="${subject.id}" type="button">
          <div class="subject-head">
            <span class="brand-mark">${esc(subject.mark)}</span>
            <div>
              <h2>${esc(subject.name)}</h2>
              <p>${esc(subject.subtitle)}</p>
            </div>
          </div>
          <p>${esc(subject.description)}</p>
          <div class="meta-row" style="margin-top:12px">
            <span>${subject.chapters.length} 章</span>
            <span>${subject.total} 题</span>
            <span>已做 ${stats.answered}</span>
            <span>错题 ${stats.wrongBook}</span>
          </div>
          <div class="progress"><i style="width:${pct(stats.answered, subject.total)}%"></i></div>
          <div class="chapter-bottom"><span>覆盖率 ${pct(stats.answered, subject.total)}%</span><span>正确率 ${stats.accuracy}%</span></div>
        </button>
      </article>`;
  }

  function renderSubjectHome(subject) {
    const stats = subjectStats(subject);
    const resume = state.activeSession && !state.activeSession.completed && state.activeSession.subjectId === subject.id
      ? `<div class="resume-card"><div><h3>继续 ${esc(subject.name)} 练习</h3><p>${esc(state.activeSession.title)} · 第 ${Math.min(state.activeSession.currentIndex + 1, state.activeSession.questionUids.length)} / ${state.activeSession.questionUids.length} 题</p></div><div class="resume-actions"><button class="secondary-btn" data-discard-session type="button">放弃</button><button class="primary-btn dark" data-resume type="button">继续</button></div></div>`
      : "";
    main.innerHTML = `
      ${renderTopline(subject)}
      <section class="subject-hero">
        <h1>${esc(subject.title)}</h1>
        <p>${esc(subject.description)}答题记录保存在本机，错题连续答对 ${state.settings.streakTarget} 次后自动移出。</p>
        <div class="hero-actions">
          <button class="primary-btn" data-random-subject type="button">本科随机 20 题</button>
          <button class="secondary-btn" data-subject-wrong type="button">错题复刷 ${stats.wrongBook ? `(${stats.wrongBook})` : ""}</button>
          <button class="secondary-btn" data-star-practice type="button">收藏题</button>
        </div>
      </section>
      ${resume}
      <section class="stats-grid">
        <div class="stat-card"><span>已覆盖</span><strong>${stats.answered}/${subject.total}</strong><small>${pct(stats.answered, subject.total)}%</small></div>
        <div class="stat-card"><span>累计作答</span><strong>${stats.attempts}</strong><small>次</small></div>
        <div class="stat-card"><span>总体正确率</span><strong>${stats.accuracy}%</strong><small>${stats.correct} 题次正确</small></div>
        <div class="stat-card"><span>当前错题</span><strong>${stats.wrongBook}</strong><small>待复刷</small></div>
      </section>
      <div class="section-head"><div><h2>章节进度</h2><p>点击章节进入专项练习。</p></div><button class="link-btn" data-route="subject/${subject.id}/chapters" type="button">查看全部</button></div>
      <section class="chapter-grid">${subject.chapters.map((chapter) => chapterCard(subject, chapter)).join("")}</section>`;
    bindTopline();
    bindSubjectCommon(subject);
    main.querySelector("[data-random-subject]").onclick = () => {
      startSession({ questionUids: shuffle(allQuestions(subject).map((question) => question.uid)).slice(0, 20), mode: "random", subjectId: subject.id, title: `${subject.name} · 随机 20 题` });
    };
    main.querySelector("[data-subject-wrong]").onclick = () => setHash(`subject/${subject.id}/wrong`);
    main.querySelector("[data-star-practice]").onclick = () => {
      const uids = allQuestions(subject).filter((question) => getProgress(question.uid).starred).map((question) => question.uid);
      if (!uids.length) return toast("还没有收藏题");
      startSession({ questionUids: uids, mode: "starred", subjectId: subject.id, title: `${subject.name} · 收藏题` });
    };
    const resumeBtn = main.querySelector("[data-resume]");
    if (resumeBtn) resumeBtn.onclick = () => setHash("practice");
    const discardBtn = main.querySelector("[data-discard-session]");
    if (discardBtn) discardBtn.onclick = () => modal({ title: "放弃当前练习？", body: "<p>已提交记录会保留，未完成队列会删除。</p>", confirmText: "放弃练习", danger: true, onConfirm: async () => { state.activeSession = null; await save(); renderSubjectHome(subject); } });
    renderBottomNav(subject, "home");
  }

  function chapterCard(subject, chapter) {
    const stats = chapterStats(chapter);
    return `
      <article class="chapter-card">
        <button data-open-chapter="${chapter.id}" type="button">
          <span class="chapter-index">${esc(chapter.chapterNo)}</span>
          <h3>${esc(chapter.title)}</h3>
          <div class="meta-row"><span>共 ${chapter.questions.length} 题</span><span>已做 ${stats.answered}</span><span>错题 ${stats.wrongBook}</span></div>
          <div class="progress"><i style="width:${pct(stats.answered, chapter.questions.length)}%"></i></div>
          <div class="chapter-bottom"><span>覆盖率 ${pct(stats.answered, chapter.questions.length)}%</span><span>正确率 ${stats.accuracy}%</span></div>
        </button>
      </article>`;
  }

  function bindSubjectCommon(subject) {
    main.querySelectorAll("[data-open-subject]").forEach((button) => {
      button.onclick = () => setHash(`subject/${button.dataset.openSubject}`);
    });
    main.querySelectorAll("[data-open-chapter]").forEach((button) => {
      button.onclick = () => setHash(`subject/${subject.id}/chapter/${button.dataset.openChapter}`);
    });
    main.querySelectorAll("[data-route]").forEach((button) => {
      button.onclick = () => setHash(button.dataset.route);
    });
  }

  function renderChapters(subject) {
    main.innerHTML = `${renderTopline(subject)}<div class="page-head"><div><h1>${esc(subject.name)}分章节练习</h1><p>每章可顺序练习、只做未完成题、随机练习，或进入本章错题复刷。</p></div></div><section class="chapter-grid">${subject.chapters.map((chapter) => chapterCard(subject, chapter)).join("")}</section>`;
    bindTopline();
    bindSubjectCommon(subject);
    renderBottomNav(subject, "chapters");
  }

  function renderChapter(subject, chapterId) {
    const chapter = chapterMap.get(`${subject.id}:${chapterId}`);
    if (!chapter) return setHash(`subject/${subject.id}/chapters`);
    const stats = chapterStats(chapter);
    const counts = { all: chapter.questions.length, single: chapter.questions.filter((q) => q.type === "single").length, multiple: chapter.questions.filter((q) => q.type === "multiple").length };
    let filter = "all";
    main.innerHTML = `
      ${renderTopline(subject)}
      <button class="back-btn" data-route="subject/${subject.id}/chapters" type="button">← 返回章节</button>
      <div class="page-head"><div><span class="chapter-index">${esc(chapter.chapterNo)}</span><h1>${esc(chapter.title)}</h1><p>${esc(subject.name)} · 共 ${chapter.questions.length} 题 · 已覆盖 ${stats.answered} 题 · 错题 ${stats.wrongBook} 题</p></div></div>
      <section class="panel"><h2>开始练习</h2><div class="mode-grid">
        <button class="mode-card" data-mode="sequential" type="button"><strong>顺序练习</strong><small>按原顺序作答</small></button>
        <button class="mode-card" data-mode="unanswered" ${stats.answered === chapter.questions.length ? "disabled" : ""} type="button"><strong>未做题</strong><small>剩余 ${chapter.questions.length - stats.answered} 题</small></button>
        <button class="mode-card" data-mode="wrong" ${!stats.wrongBook ? "disabled" : ""} type="button"><strong>错题复刷</strong><small>${stats.wrongBook} 题，连续答对 ${state.settings.streakTarget} 次移出</small></button>
        <button class="mode-card" data-mode="random" type="button"><strong>随机练习</strong><small>本章题目随机排序</small></button>
      </div></section>
      <section class="panel"><h2>题型筛选</h2><div class="filter-row"><button class="chip active" data-filter="all" type="button">全部 ${counts.all}</button><button class="chip" data-filter="single" type="button">单选 ${counts.single}</button><button class="chip" data-filter="multiple" type="button">多选 ${counts.multiple}</button></div></section>
      <section class="panel"><h2>题目索引</h2><div class="question-list" id="chapter-question-list"></div></section>`;
    bindTopline();
    bindSubjectCommon(subject);
    const drawList = () => {
      const questions = chapter.questions.filter((question) => filter === "all" || question.type === filter);
      document.getElementById("chapter-question-list").innerHTML = questions.map((question) => `<div class="question-row"><span class="q-no">${question.number}</span><div class="q-summary">${esc(question.stem)}<small>${typeLabel(question)}${getProgress(question.uid).starred ? " · 已收藏" : ""}</small></div>${statusText(question)}</div>`).join("");
    };
    drawList();
    main.querySelectorAll("[data-filter]").forEach((button) => {
      button.onclick = () => {
        filter = button.dataset.filter;
        main.querySelectorAll("[data-filter]").forEach((item) => item.classList.toggle("active", item === button));
        drawList();
      };
    });
    main.querySelectorAll("[data-mode]").forEach((button) => {
      button.onclick = () => {
        if (button.disabled) return;
        let questions = chapter.questions.filter((question) => filter === "all" || question.type === filter);
        const mode = button.dataset.mode;
        if (mode === "unanswered") questions = questions.filter((question) => !getProgress(question.uid).attempts);
        if (mode === "wrong") questions = questions.filter((question) => getProgress(question.uid).inWrongBook);
        if (mode === "random") questions = shuffle(questions);
        if (!questions.length) return toast("当前筛选下没有可练习题目");
        startSession({ questionUids: questions.map((question) => question.uid), mode, subjectId: subject.id, chapterId: chapter.id, title: `${subject.name} · ${chapter.title} · ${modeName(mode)}` });
      };
    });
    renderBottomNav(subject, "chapters");
  }

  function statusText(question) {
    const progress = state.progress[question.uid];
    if (!progress || !progress.attempts) return '<span class="status-dot">未做</span>';
    if (progress.inWrongBook) return '<span class="status-dot wrong">错题</span>';
    return '<span class="status-dot done">已做</span>';
  }

  async function startSession({ questionUids, mode, subjectId, chapterId = null, title }) {
    if (!questionUids.length) return toast("没有可练习的题目");
    state.activeSession = { id: `s-${Date.now()}`, questionUids, currentIndex: 0, mode, subjectId, chapterId, title, answers: {}, startedAt: now(), completed: false };
    await save();
    setHash("practice");
  }

  function renderPractice() {
    const session = state.activeSession;
    if (!session || session.completed) return setHash("home");
    const index = clamp(session.currentIndex, 0, session.questionUids.length - 1);
    session.currentIndex = index;
    const question = questionMap.get(session.questionUids[index]);
    if (!question) { state.activeSession = null; save(); return setHash("home"); }
    const subject = subjectById(question.lawId);
    const answerState = session.answers[question.uid] || { selected: [], submitted: false, correct: null };
    session.answers[question.uid] = answerState;
    const progress = getProgress(question.uid);
    const optionHtml = question.options.map((option) => {
      const selected = answerState.selected.includes(option.key);
      const isCorrect = answerState.submitted && question.answer.includes(option.key);
      const isIncorrect = answerState.submitted && selected && !question.answer.includes(option.key);
      return `<button class="option ${selected ? "selected" : ""} ${isCorrect ? "correct" : ""} ${isIncorrect ? "incorrect" : ""}" data-option="${option.key}" ${answerState.submitted ? "disabled" : ""} type="button"><span class="option-key">${esc(option.key)}</span><span>${esc(option.text)}</span></button>`;
    }).join("");
    const feedback = answerState.submitted ? `<div class="answer-panel ${answerState.correct ? "good" : "bad"}"><strong>${answerState.correct ? "Correct" : "Wrong"} · 答案：${esc(question.answerLabel || question.answer.join(""))}</strong><div>${esc(question.explanation || "暂无解析。")}</div>${progress.inWrongBook ? `<div class="note-box">错题本进度：连续答对 ${progress.reviewStreak}/${state.settings.streakTarget} 次。</div>` : ""}</div>` : "";
    main.innerHTML = `
      ${renderTopline(subject)}
      <div class="practice-shell">
        <div class="practice-top"><div><button class="back-btn" data-exit-practice type="button">← 退出练习</button><h1>${esc(session.title)}</h1><p>第 ${index + 1} / ${session.questionUids.length} 题</p></div><div class="practice-actions"><button class="star-btn ${progress.starred ? "active" : ""}" data-star type="button" aria-label="收藏题目">${progress.starred ? "★" : "☆"}</button></div></div>
        <div class="practice-progress progress"><i style="width:${pct(index + 1, session.questionUids.length)}%"></i></div>
        <article class="question-card"><div class="question-meta"><span class="badge ${question.type === "multiple" ? "multi" : ""}">${esc(subject.name)} · ${typeLabel(question)}${question.type === "multiple" ? " · 可多选" : ""}</span><span>${question.isOutdated ? '<span class="badge warn">旧法提示</span>' : ""}${progress.inWrongBook ? '<span class="badge wrong">错题本</span>' : ""}</span></div><h2>${question.number}. ${esc(question.stem)}</h2><div class="options">${optionHtml}</div>${feedback}<div class="practice-footer"><div><button class="secondary-btn" data-prev ${index === 0 ? "disabled" : ""} type="button">上一题</button><button class="secondary-btn" data-next ${index === session.questionUids.length - 1 ? "disabled" : ""} type="button">下一题</button></div>${answerState.submitted ? `<button class="primary-btn dark submit-btn" data-advance type="button">${index === session.questionUids.length - 1 ? "完成练习" : "下一题"}</button>` : `<button class="primary-btn dark submit-btn" data-submit ${!answerState.selected.length ? "disabled" : ""} type="button">提交答案</button>`}</div></article>
      </div>`;
    bindTopline();
    const saveSession = async () => { state.activeSession = session; await save(); };
    main.querySelector("[data-exit-practice]").onclick = () => modal({ title: "退出当前练习？", body: "<p>练习位置和已提交记录已经自动保存。</p>", confirmText: "退出", onConfirm: () => setHash(session.chapterId ? `subject/${subject.id}/chapter/${session.chapterId}` : `subject/${subject.id}`) });
    main.querySelector("[data-star]").onclick = async () => { progress.starred = !progress.starred; await save(); renderPractice(); toast(progress.starred ? "已收藏" : "已取消收藏"); };
    main.querySelectorAll("[data-option]").forEach((button) => {
      button.onclick = async () => {
        const key = button.dataset.option;
        answerState.selected = question.type === "multiple"
          ? (answerState.selected.includes(key) ? answerState.selected.filter((item) => item !== key) : [...answerState.selected, key])
          : [key];
        await saveSession();
        renderPractice();
      };
    });
    const submit = main.querySelector("[data-submit]");
    if (submit) submit.onclick = async () => { answerState.submitted = true; answerState.correct = sameAnswer(answerState.selected, question.answer); recordAttempt(question.uid, answerState.correct, answerState.selected); await saveSession(); renderPractice(); };
    const prev = main.querySelector("[data-prev]");
    if (prev) prev.onclick = async () => { session.currentIndex -= 1; await saveSession(); renderPractice(); window.scrollTo({ top: 0, behavior: "smooth" }); };
    const next = main.querySelector("[data-next]");
    if (next) next.onclick = async () => { session.currentIndex += 1; await saveSession(); renderPractice(); window.scrollTo({ top: 0, behavior: "smooth" }); };
    const advance = main.querySelector("[data-advance]");
    if (advance) advance.onclick = async () => { if (index === session.questionUids.length - 1) await finishSession(); else { session.currentIndex += 1; await saveSession(); renderPractice(); window.scrollTo({ top: 0, behavior: "smooth" }); } };
    renderBottomNav(subject, "home");
  }

  function sameAnswer(selected, answer) {
    return [...selected].sort().join("") === [...answer].sort().join("");
  }

  function recordAttempt(uid, correct, selected) {
    const progress = getProgress(uid);
    progress.attempts += 1;
    progress.lastCorrect = correct;
    progress.lastSelected = [...selected];
    progress.lastAnsweredAt = now();
    if (correct) {
      progress.correct += 1;
      if (progress.inWrongBook) {
        progress.reviewStreak += 1;
        if (progress.reviewStreak >= state.settings.streakTarget) progress.inWrongBook = false;
      }
    } else {
      progress.wrong += 1;
      progress.inWrongBook = true;
      progress.reviewStreak = 0;
    }
  }

  async function finishSession() {
    const session = state.activeSession;
    const submitted = Object.values(session.answers).filter((answer) => answer.submitted);
    const correct = submitted.filter((answer) => answer.correct).length;
    const incorrectUids = session.questionUids.filter((uid) => session.answers[uid]?.submitted && !session.answers[uid].correct);
    state.lastSession = { title: session.title, total: session.questionUids.length, answered: submitted.length, correct, incorrectUids, finishedAt: now(), subjectId: session.subjectId, chapterId: session.chapterId };
    state.activeSession = null;
    await save();
    setHash("summary");
  }

  function renderSummary() {
    const summary = state.lastSession;
    if (!summary) return setHash("home");
    const accuracy = pct(summary.correct, summary.answered);
    main.innerHTML = `<div class="summary"><section class="panel summary-score"><span class="badge">练习完成</span><h1>${esc(summary.title)}</h1><strong>${accuracy}%</strong><p>本次正确率</p><div class="summary-grid"><div><b>${summary.answered}</b><span>已作答</span></div><div><b>${summary.correct}</b><span>答对</span></div><div><b>${summary.answered - summary.correct}</b><span>答错</span></div></div><div class="summary-actions">${summary.incorrectUids.length ? '<button class="secondary-btn" data-review-session type="button">重做本次错题</button>' : ""}<button class="primary-btn dark" data-summary-back type="button">返回</button></div></section></div>`;
    const review = main.querySelector("[data-review-session]");
    if (review) review.onclick = () => startSession({ questionUids: summary.incorrectUids, mode: "wrong", subjectId: summary.subjectId, chapterId: summary.chapterId, title: "本次错题重做" });
    main.querySelector("[data-summary-back]").onclick = () => setHash(summary.subjectId ? `subject/${summary.subjectId}` : "home");
    bottomNav.classList.add("hidden");
  }

  function renderWrong(subject) {
    const wrongQuestions = allQuestions(subject).filter((question) => getProgress(question.uid).inWrongBook);
    const groups = subject.chapters.map((chapter) => ({ chapter, questions: chapter.questions.filter((question) => getProgress(question.uid).inWrongBook) })).filter((group) => group.questions.length);
    main.innerHTML = `${renderTopline(subject)}<div class="page-head"><div><h1>${esc(subject.name)}错题复刷</h1><p>答错自动加入错题本；连续答对 ${state.settings.streakTarget} 次后自动移出。</p></div>${wrongQuestions.length ? '<button class="primary-btn dark" data-start-wrong type="button">开始全部错题</button>' : ""}</div>${wrongQuestions.length ? groups.map(({ chapter, questions }) => `<section class="panel"><div class="section-head" style="margin:0 0 12px"><div><h2>${esc(chapter.title)}</h2><p>${questions.length} 道错题</p></div><button class="link-btn" data-wrong-ch="${chapter.id}" type="button">本章复刷</button></div><div class="wrong-grid">${questions.map((question) => wrongItem(question)).join("")}</div></section>`).join("") : '<section class="panel empty"><strong>目前没有错题</strong>答错的题目会自动加入这里。</section>'}`;
    bindTopline();
    const start = main.querySelector("[data-start-wrong]");
    if (start) start.onclick = () => startSession({ questionUids: wrongQuestions.map((question) => question.uid), mode: "wrong", subjectId: subject.id, title: `${subject.name} · 全部错题复刷` });
    main.querySelectorAll("[data-wrong-ch]").forEach((button) => {
      button.onclick = () => {
        const chapter = chapterMap.get(`${subject.id}:${button.dataset.wrongCh}`);
        startSession({ questionUids: chapter.questions.filter((question) => getProgress(question.uid).inWrongBook).map((question) => question.uid), mode: "wrong", subjectId: subject.id, chapterId: chapter.id, title: `${subject.name} · ${chapter.title} · 错题复刷` });
      };
    });
    renderBottomNav(subject, "wrong");
  }

  function wrongItem(question) {
    const progress = getProgress(question.uid);
    return `<div class="wrong-item"><div><h3>${question.number}. ${esc(question.stem)}</h3><p>${subjectById(question.lawId).name} · ${typeLabel(question)} · 累计答错 ${progress.wrong} 次</p></div><div class="streak">巩固 ${progress.reviewStreak}/${state.settings.streakTarget}<span class="mastery-dots">${Array.from({ length: state.settings.streakTarget }, (_, index) => `<i class="${index < progress.reviewStreak ? "on" : ""}"></i>`).join("")}</span></div></div>`;
  }

  async function refreshStorageInfo() {
    try { if (navigator.storage?.persisted) storagePersisted = await navigator.storage.persisted(); } catch { storagePersisted = false; }
  }

  function renderData() {
    const allUids = data.subjects.flatMap((subject) => allQuestions(subject).map((question) => question.uid));
    const stats = statsFor(allUids);
    main.innerHTML = `${renderTopline(null)}<div class="page-head"><div><h1>数据与设置</h1><p>两科记录都保存在当前固定网址和当前浏览器中。</p></div></div><div class="notice">同一个固定网址下更新网站文件，通常不会清除已有 IndexedDB 记录。换设备、换浏览器或清除站点数据前，请先导出 JSON 备份。</div><section class="data-grid"><div class="data-block"><h3>保存状态</h3><p>存储引擎：${esc(storageMode)}</p><div class="storage-status"><span class="dot ${storagePersisted ? "ok" : ""}"></span><b>${storagePersisted ? "已获得持久化存储保护" : "尚未获得持久化存储保护"}</b></div><div class="button-row"><button class="primary-btn dark" data-persist type="button">申请持久保存</button><button class="secondary-btn" data-install-help type="button">安装到桌面</button></div></div><div class="data-block"><h3>学习记录</h3><p>已覆盖 ${stats.answered}/${allUids.length} 题，累计作答 ${stats.attempts} 次，当前错题 ${stats.wrongBook} 道。</p><div class="button-row"><button class="primary-btn dark" data-export type="button">导出记录</button><button class="secondary-btn" data-import type="button">导入记录</button></div></div><div class="data-block"><h3>错题掌握规则</h3><p>当前设置：错题连续答对 ${state.settings.streakTarget} 次后移出错题本。</p><div class="filter-row">${[1,2,3,4,5].map((num) => `<button class="chip ${num === state.settings.streakTarget ? "active" : ""}" data-target="${num}" type="button">${num} 次</button>`).join("")}</div></div><div class="data-block"><h3>重置数据</h3><p>可清空两科练习进度、错题、收藏和当前练习位置；题库文件不会受影响。</p><div class="button-row"><button class="danger-btn" data-clear type="button">清空全部记录</button></div></div></section>`;
    bindTopline();
    main.querySelector("[data-export]").onclick = exportData;
    main.querySelector("[data-import]").onclick = () => importInput.click();
    main.querySelector("[data-persist]").onclick = requestPersist;
    main.querySelector("[data-install-help]").onclick = showInstallHelp;
    main.querySelector("[data-clear]").onclick = () => modal({ title: "确认清空全部记录？", body: "<p>行政法和国际法的答题次数、错题、收藏和当前练习都会被删除。建议先导出备份。</p>", confirmText: "永久清空", danger: true, onConfirm: async () => { state = clone(DEFAULT_STATE); await save(); toast("记录已清空"); renderData(); } });
    main.querySelectorAll("[data-target]").forEach((button) => { button.onclick = async () => { state.settings.streakTarget = Number(button.dataset.target); await save(); renderData(); toast("错题规则已更新"); }; });
    bottomNav.classList.add("hidden");
  }

  function exportData() {
    const payload = { app: "部门法期末刷题", formatVersion: 1, questionBankVersion: data.version, exportedAt: now(), state };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(blob);
    anchor.download = `部门法刷题记录_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(anchor.href), 1000);
    toast("记录已导出");
  }

  importInput.onchange = async () => {
    const file = importInput.files?.[0];
    importInput.value = "";
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      const imported = payload.state || payload;
      modal({ title: "导入学习记录？", body: `<p>备份时间：${esc(payload.exportedAt || "未知")}。导入后会覆盖当前两科记录。</p>`, confirmText: "覆盖并导入", onConfirm: async () => { state = normalizeState(imported); await save(); toast("记录已恢复"); renderData(); } });
    } catch {
      toast("无法读取该备份文件");
    }
  };

  async function requestPersist() {
    if (!navigator.storage?.persist) return toast("当前浏览器不支持申请持久化存储");
    try { storagePersisted = await navigator.storage.persist(); toast(storagePersisted ? "已获得持久化存储保护" : "浏览器暂未授予持久化存储"); renderData(); } catch { toast("申请失败"); }
  }

  function showInstallHelp() {
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const body = ios ? "<p>请使用 Safari 打开固定网址，点击底部“分享”按钮，再选择“添加到主屏幕”。</p>" : "<p>使用 Chrome 或 Edge 打开固定网址，点击地址栏右侧的安装图标；也可以点击页面提示“在应用中打开/安装”。</p>";
    modal({ title: "安装到桌面", body, confirmText: "知道了", cancelText: "关闭" });
  }

  function renderBottomNav(subject, active) {
    bottomNav.classList.remove("hidden");
    bottomNav.innerHTML = `<button data-nav="home" class="${active === "home" ? "active" : ""}" type="button"><span>⌂</span><em>${esc(subject.name)}</em></button><button data-nav="chapters" class="${active === "chapters" ? "active" : ""}" type="button"><span>▦</span><em>章节</em></button><button data-nav="wrong" class="${active === "wrong" ? "active" : ""}" type="button"><span>↻</span><em>错题</em></button><button data-nav="data" type="button"><span>◉</span><em>数据</em></button>`;
    bottomNav.querySelector('[data-nav="home"]').onclick = () => setHash(`subject/${subject.id}`);
    bottomNav.querySelector('[data-nav="chapters"]').onclick = () => setHash(`subject/${subject.id}/chapters`);
    bottomNav.querySelector('[data-nav="wrong"]').onclick = () => setHash(`subject/${subject.id}/wrong`);
    bottomNav.querySelector('[data-nav="data"]').onclick = () => setHash("data");
  }

  function render() {
    const parts = parseRoute();
    window.scrollTo(0, 0);
    if (parts[0] === "home") renderHome();
    else if (parts[0] === "subject") {
      const subject = subjectById(parts[1]);
      if (!parts[2]) renderSubjectHome(subject);
      else if (parts[2] === "chapters") renderChapters(subject);
      else if (parts[2] === "chapter") renderChapter(subject, parts[3]);
      else if (parts[2] === "wrong") renderWrong(subject);
      else renderSubjectHome(subject);
    } else if (parts[0] === "practice") renderPractice();
    else if (parts[0] === "summary") renderSummary();
    else if (parts[0] === "data") renderData();
    else setHash("home");
    main.focus({ preventScroll: true });
  }

  async function initData() {
    const response = await fetch("./data/banks.json");
    if (!response.ok) throw new Error("题库读取失败");
    data = await response.json();
    data.subjects.forEach((subject) => {
      subjectMap.set(subject.id, subject);
      subject.chapters.forEach((chapter) => {
        chapterMap.set(`${subject.id}:${chapter.id}`, chapter);
        chapter.questions.forEach((question) => questionMap.set(question.uid, question));
      });
    });
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    if (!location.protocol.startsWith("http")) return;
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }

  async function init() {
    try {
      await initData();
      db = await openDatabase();
      state = normalizeState(await readState());
      await refreshStorageInfo();
      await save();
      window.addEventListener("hashchange", render);
      window.addEventListener("beforeinstallprompt", (event) => { event.preventDefault(); installPrompt = event; });
      window.addEventListener("appinstalled", () => toast("已安装到桌面"));
      document.addEventListener("click", (event) => {
        const button = event.target.closest("[data-open-subject]");
        if (button) setHash(`subject/${button.dataset.openSubject}`);
      });
      if (!location.hash) location.hash = "#/home";
      else render();
      registerServiceWorker();
    } catch (error) {
      console.error(error);
      main.innerHTML = '<section class="panel empty"><strong>题库读取失败</strong>请确认 data/banks.json 与网页文件在同一目录中。</section>';
    }
  }

  init();
})();
