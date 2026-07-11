    import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
    import { initializeFirestore, persistentLocalCache, collection, getDocs, addDoc, updateDoc, deleteDoc, setDoc, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
    import { getAuth, signOut, signInWithEmailAndPassword, createUserWithEmailAndPassword, onAuthStateChanged, updateProfile, updatePassword, reauthenticateWithCredential, EmailAuthProvider } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

    // ───────────────────────────
    // FIREBASE CONFIG
    // ⚠️ PASTE YOUR REAL CONFIG HERE — copy it from:
    // Firebase Console → ⚙️ Project settings → Your apps → (</>) → SDK setup and config
    // Make sure projectId here EXACTLY matches the project ID shown in your
    // Firebase console URL (e.g. planner-a3863-ce3fc, not just planner-a3863).
    // ───────────────────────────
    const firebaseConfig = {
      apiKey:            "AIzaSyA0NiUGQ-YIWkARYfbHRacz9QdDVZ41wLM",
      authDomain:        "planner-a3863-ce3fc.firebaseapp.com",
      projectId:         "planner-a3863-ce3fc",
      storageBucket:     "planner-a3863-ce3fc.firebasestorage.app",
      messagingSenderId: "259248084380",
      appId:             "1:259248084380:web:5286b52f7dbb588793a459"
    };

    const app = initializeApp(firebaseConfig);
    // Persistent local cache (IndexedDB): if the connection is slow or drops,
    // Firestore can fall back to the last-synced data instead of the app
    // hanging on a dead network request. Doesn't change the first-ever load
    // (nothing cached yet), but helps a lot on repeat visits and flaky mobile
    // connections.
    const db = initializeFirestore(app, {
      localCache: persistentLocalCache()
    });
    const auth = getAuth(app);

    // ⚠️ Must exactly match ADMIN_EMAIL in admin.html / bulk-import.html
    // and the isAdmin() check in firestore.rules.
    const ADMIN_EMAIL = "admin@example.com";

    // Fixed display order for categories within a week (used for sorting
    // and for finding the "next" incomplete task in Today's Focus).
    const CATEGORY_ORDER = ['BAU', 'Agri-Career', 'Agri-Pedia', 'BCS'];

    // Escapes untrusted text before it's inserted via innerHTML, so a task
    // name/description/event title can never inject executable HTML.
    function escapeHTML(str) {
      return String(str ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      }[c]));
    }

    // Formats a Date as YYYY-MM-DD using its LOCAL calendar fields (not UTC),
    // matching what an <input type="date"> expects/returns. Shared by the
    // profile view (prefill) and savePlanDates (Sunday-alignment + save).
    function toISODate(d) {
      const dt = new Date(d);
      return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
    }

    // Pulls the week number out of a task name like "Week 3" → 3. Falls
    // back to 0 (sorts first) if the name doesn't contain a number.
    function weekNumOf(name) {
      const m = String(name || '').match(/\d+/);
      return m ? parseInt(m[0], 10) : 0;
    }

    // ───────────────────────────
    // APP STATE
    // ───────────────────────────
    let appState = {
      plan: {
        title: "100-Day Study Plan",
        startDate: new Date(2026, 6, 12), // July 12, 2026
        totalDays: 90,
        categories: [],
        weeks: []
      },
      events: [],
      currentWeek: 1,
      user: null,
      isAdmin: false,
      progress: {} // { [taskId]: completedCount } for the signed-in user
    };

    // ───────────────────────────
    // INITIALIZATION
    // ───────────────────────────
    window.addEventListener('DOMContentLoaded', () => {
      initApp();
      setupEventListeners();
      setupAuthListeners();
      document.getElementById('projectIdLabel').textContent = firebaseConfig.projectId;

      onAuthStateChanged(auth, async (user) => {
        if (user) {
          appState.user = user;
          appState.isAdmin = user.email === ADMIN_EMAIL;

          document.getElementById('loginGate').style.display = 'none';
          document.getElementById('appContent').style.display = '';
          document.getElementById('loadOverlay').style.display = 'flex';

          document.getElementById('profileEmailDisplay').textContent = user.email;
          document.getElementById('profileAdminTag').style.display = appState.isAdmin ? '' : 'none';
          document.getElementById('adminManageCard').style.display = appState.isAdmin ? '' : 'none';
          document.getElementById('profileDisplayName').value = user.displayName || '';

          await loadData();

          // Default the tracker to the week of the next incomplete task,
          // so returning students land where they left off instead of
          // always seeing Week 1.
          const ordered = [...appState.plan.categories].sort((a, b) => weekNumOf(a.name) - weekNumOf(b.name));
          const nextUp = ordered.find(cat => (cat.completed || 0) < 7);
          appState.currentWeek = nextUp ? weekNumOf(nextUp.name) : 1;

          render();
          dtInit(user.uid);
          document.getElementById('loadOverlay').style.display = 'none';
        } else {
          appState.user = null;
          appState.isAdmin = false;
          appState.progress = {};
          document.getElementById('loadOverlay').style.display = 'none';
          document.getElementById('loginGate').style.display = 'flex';
          document.getElementById('appContent').style.display = 'none';
          dtReset();
        }
      });
    });

    function setupAuthListeners() {
      let mode = 'login';
      const tabLogin = document.getElementById('tabLogin');
      const tabSignup = document.getElementById('tabSignup');
      const loginBtn = document.getElementById('loginBtn');
      const errEl = document.getElementById('loginError');

      tabLogin.addEventListener('click', () => {
        mode = 'login';
        tabLogin.classList.add('active');
        tabSignup.classList.remove('active');
        loginBtn.textContent = 'Log In';
        errEl.textContent = '';
      });

      tabSignup.addEventListener('click', () => {
        mode = 'signup';
        tabSignup.classList.add('active');
        tabLogin.classList.remove('active');
        loginBtn.textContent = 'Create Account';
        errEl.textContent = '';
      });

      loginBtn.addEventListener('click', async () => {
        const email = document.getElementById('loginEmail').value.trim();
        const password = document.getElementById('loginPassword').value;
        errEl.textContent = '';

        if (!email || !password) {
          errEl.textContent = 'Please enter both email and password.';
          return;
        }

        loginBtn.disabled = true;
        try {
          if (mode === 'signup') {
            await createUserWithEmailAndPassword(auth, email, password);
          } else {
            await signInWithEmailAndPassword(auth, email, password);
          }
        } catch (error) {
          errEl.textContent = `${mode === 'signup' ? 'Sign up' : 'Log in'} failed: ${error.code || error.message}`;
        } finally {
          loginBtn.disabled = false;
        }
      });

      document.getElementById('logoutBtn').addEventListener('click', () => signOut(auth));
    }

    function initApp() {
      // Week 1 = 7 days; this is recalculated when data loads
      appState.plan.totalDays = 100; // 14-15 weeks
      for (let w = 1; w <= 15; w++) {
        appState.plan.weeks.push({
          wk: w,
          rows: []
        });
      }
    }

    function setupEventListeners() {
      // Navigation
      document.querySelectorAll('[data-view]').forEach(btn => {
        btn.addEventListener('click', () => {
          const view = btn.dataset.view;
          switchView(view);
          document.querySelectorAll('[data-view]').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
        });
      });

      // Profile view actions
      document.getElementById('saveNameBtn').addEventListener('click', saveDisplayName);
      document.getElementById('savePasswordBtn').addEventListener('click', changePassword);
      document.getElementById('savePlanDatesBtn').addEventListener('click', savePlanDates);
      document.getElementById('addTaskBtn').addEventListener('click', addTaskInline);
      document.getElementById('cancelTaskEditBtn').addEventListener('click', cancelTaskEdit);
      document.getElementById('addEventBtn').addEventListener('click', addEventInline);
      document.getElementById('cancelEventEditBtn').addEventListener('click', cancelEventEdit);

      // Daily Tracker actions
      document.getElementById('dtAddCatBtn').addEventListener('click', () => dtAddCatRow());
      document.getElementById('dtGenerateBtn').addEventListener('click', dtGenerateTracker);
      document.getElementById('dtEditSetupBtn').addEventListener('click', dtShowSetup);
      document.getElementById('dtArchiveToggle').addEventListener('click', dtToggleArchive);
      document.getElementById('dtTimerTog').addEventListener('click', dtToggleTimerPanel);
      document.getElementById('dtTimerStartBtn').addEventListener('click', dtTimerStart);
      document.getElementById('dtTimerResetBtn').addEventListener('click', dtTimerReset);
    }

    function switchView(view) {
      document.getElementById('trackerView').style.display = view === 'tracker' ? 'flex' : 'none';
      document.getElementById('calendarView').style.display = view === 'calendar' ? 'flex' : 'none';
      document.getElementById('profileView').style.display = view === 'profile' ? 'flex' : 'none';
      document.getElementById('reportsView').style.display = view === 'reports' ? 'flex' : 'none';
      document.getElementById('dailyTrackerView').style.display = view === 'dailytracker' ? 'flex' : 'none';
      document.getElementById('dtTimerFab').style.display = (view === 'dailytracker' && dtData) ? 'block' : 'none';
      if (view === 'profile') renderProfileView();
    }

    // ───────────────────────────
    // DATA MANAGEMENT
    // ───────────────────────────
    async function loadData() {
      try {
        // These 4 reads are completely independent of each other, so fire them
        // all at once instead of waiting for each round trip in sequence —
        // this alone cuts initial-load time roughly to the length of the
        // single slowest request instead of the sum of all four.
        const progressPromise = appState.user
          ? getDocs(collection(db, "users", appState.user.uid, "progress")).catch(error => {
              console.error("Error loading user progress:", error);
              return null;
            })
          : Promise.resolve(null);

        const planPromise = getDoc(doc(db, "settings", "plan")).catch(error => {
          console.error("Error loading plan settings:", error);
          return null;
        });

        const [tasksSnap, progSnap, eventsSnap, planSnap] = await Promise.all([
          getDocs(collection(db, "tasks")),
          progressPromise,
          getDocs(collection(db, "events")),
          planPromise
        ]);

        const tasks = tasksSnap.docs.map(d => ({ id: d.id, ...d.data() }));

        // Load this signed-in user's own progress subcollection. Firestore
        // rules guarantee this query can only ever return their own docs.
        appState.progress = {};
        if (progSnap) {
          progSnap.docs.forEach(d => {
            appState.progress[d.id] = d.data().completed || 0;
          });
        }

        // Merge: the shared task doc supplies name/category/days/desc; the
        // user's own progress doc supplies how many days *they* completed.
        appState.plan.categories = tasks.map(t => ({
          ...t,
          completed: appState.progress[t.id] || 0
        }));

        appState.events = eventsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

        // Plan-wide start/end date, editable by the admin from My Profile.
        // Falls back to the hardcoded defaults set in initApp() if no
        // settings doc has been saved yet.
        if (planSnap && planSnap.exists()) {
          const p = planSnap.data();
          if (p.startDate) appState.plan.startDate = new Date(p.startDate + 'T00:00:00');
          if (p.endDate) {
            appState.plan.endDate = p.endDate;
            const s = new Date(p.startDate + 'T00:00:00');
            const e = new Date(p.endDate + 'T00:00:00');
            appState.plan.totalDays = Math.max(1, Math.round((e - s) / 86400000) + 1);
          }
        }
      } catch (error) {
        console.error("Error loading data:", error);
      }
    }

    // ───────────────────────────
    // RENDERING
    // ───────────────────────────
    const CATEGORY_COLORS = {
      'BAU': '#8bc34a',
      'Agri-Career': '#4a90d9',
      'Agri-Pedia': '#8d8360',
      'BCS': '#c76b2e'
    };

    // Each week spans 7 real calendar days starting from plan.startDate.
    // Day index 0 of a week always lands on the same weekday as day index 0
    // of every other week, since 7 divides evenly — so this only needs the
    // start date to be correct once, for every week to line up automatically.
    // Figures out which week + day-index (0=Sat ... 6=Fri) corresponds to
    // *today's real calendar date*, based on the plan's start date. This is
    // what "Today's Focus" uses — it's independent of whichever week the
    // student happens to be browsing in the main tracker.
    function getTodayPointer() {
      const start = new Date(appState.plan.startDate);
      start.setHours(0, 0, 0, 0);
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      let diffDays = Math.floor((today - start) / 86400000);
      if (diffDays < 0) diffDays = 0; // plan hasn't started yet → show Week 1, Day 1
      const maxDays = Math.max(1, appState.plan.totalDays) - 1;
      if (diffDays > maxDays) diffDays = maxDays; // plan finished → pin to last day

      const week = Math.floor(diffDays / 7) + 1;
      const day = diffDays % 7;
      return { week, day };
    }

    function dayLabelFor(weekNum, dayIndex) {
      const start = new Date(appState.plan.startDate);
      start.setHours(0, 0, 0, 0);
      const date = new Date(start.getTime() + ((weekNum - 1) * 7 + dayIndex) * 86400000);
      return date.toLocaleDateString('en-US', { weekday: 'short' });
    }

    function render() {
      updateTimelinePanel();
      renderCategoryProgress();
      renderWeeklySummary();
      renderWeekSelector();
      renderTasks();
      renderTodaysFocus();
      renderCalendar();
      renderUpcomingEvents();
      if (document.getElementById('profileView').style.display !== 'none') {
        renderProfileView();
      }
    }

    // Groups the flat categories list into one entry per week
    // Each week = 7 days × number of categories in that week
    function groupByWeek() {
      const map = new Map();
      appState.plan.categories.forEach(cat => {
        const wk = weekNumOf(cat.name);
        if (!map.has(wk)) {
          map.set(wk, { wk, name: cat.name, items: [] });
        }
        const g = map.get(wk);
        g.items.push(cat);
      });
      return [...map.values()].sort((a, b) => a.wk - b.wk);
    }

    // Groups the flat categories list into one entry per CATEGORY (BAU,
    // Agri-Career, Agri-Pedia, BCS), summing total/completed across
    // every week that category appears in
    function groupByCategory() {
      const map = new Map();
      appState.plan.categories.forEach(cat => {
        if (!map.has(cat.category)) {
          map.set(cat.category, { category: cat.category, totalCompleted: 0, totalWeeks: 0 });
        }
        const g = map.get(cat.category);
        g.totalCompleted += Number(cat.completed) || 0;
        g.totalWeeks += 1; // Count how many weeks this category appears in
      });
      return CATEGORY_ORDER
        .map(c => map.get(c))
        .filter(Boolean)
        .concat([...map.values()].filter(g => !CATEGORY_ORDER.includes(g.category)));
    }

    function updateTimelinePanel() {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const startDate = new Date(appState.plan.startDate);
      startDate.setHours(0, 0, 0, 0);
      const daysPassed = Math.max(0, Math.min(appState.plan.totalDays, Math.floor((today - startDate) / 86400000)));
      const daysLeft = Math.max(0, appState.plan.totalDays - daysPassed);

      document.getElementById('daysPassed').textContent = daysPassed;
      document.getElementById('daysLeft').textContent = daysLeft;
      document.getElementById('startDateLabel').textContent = startDate.toLocaleDateString('en-GB', {
        day: '2-digit', month: '2-digit', year: '2-digit'
      }).split('/').join('/');
      // "Ends" tracks the currently selected week (from the week dropdown),
      // not the whole plan — so picking Week 2 shows Week 2's last day,
      // capped so it never runs past the plan's actual final day.
      const lastDayOfSelectedWeek = Math.min(appState.currentWeek * 7, appState.plan.totalDays) - 1;
      const endDate = new Date(startDate.getTime() + lastDayOfSelectedWeek * 86400000);
      document.getElementById('endDateLabel').textContent = endDate.toLocaleDateString('en-GB', {
        day: '2-digit', month: '2-digit', year: '2-digit'
      });

      // Calculate progress: completed items / (7 days per week × number of weeks × categories)
      // Each category should be completed 7 times (once per day for a week), then the next week repeats
      const numWeeks = Math.ceil(appState.plan.totalDays / 7);
      const numCats = appState.plan.categories.length;
      const totalTarget = numWeeks * 7 * numCats;
      const totalCompleted = appState.plan.categories.reduce((sum, cat) => sum + (Number(cat.completed) || 0), 0);
      const overallProgress = totalTarget > 0 ? Math.round((totalCompleted / totalTarget) * 100 * 10) / 10 : 0;

      document.getElementById('overallProgress').textContent = overallProgress + '%';
      document.getElementById('completionStat').textContent = totalCompleted;
      document.getElementById('completionStatLabel').textContent =
        totalTarget > 0 ? `Items Complete out of ${totalTarget}` : 'Items Complete';
    }

    function renderCategoryProgress() {
      const container = document.getElementById('categoryProgress');
      const categories = groupByCategory();

      if (categories.length === 0) {
        container.innerHTML = '<p class="text-muted text-center">No categories added yet</p>';
        return;
      }

      container.innerHTML = categories.map(g => {
        // Each category appears in X weeks, each week = 7 days
        const totalExpected = g.totalWeeks * 7;
        const pct = totalExpected > 0 ? Math.round((g.totalCompleted / totalExpected) * 100 * 10) / 10 : 0;
        const color = CATEGORY_COLORS[g.category] || 'var(--stone)';
        return `
          <div class="panel-row">
            <div class="panel-row-label" style="background:${color}; color:#fff;">${escapeHTML(g.category)}</div>
            <div class="panel-row-value">${pct}%</div>
          </div>
        `;
      }).join('');
    }

    function renderWeeklySummary() {
      const listEl = document.getElementById('weeklySummary');
      const weeks = groupByWeek();

      if (weeks.length === 0) {
        listEl.innerHTML = '<p class="text-muted text-center">No weeks added yet</p>';
        return;
      }

      listEl.innerHTML = weeks.map(g => {
        // Each week = 7 days × number of categories in that week
        const daysPerWeek = 7;
        const totalExpected = daysPerWeek * g.items.length;
        const totalCompleted = g.items.reduce((sum, item) => sum + (Number(item.completed) || 0), 0);
        const pct = totalExpected > 0 ? Math.round((totalCompleted / totalExpected) * 100) : 0;
        return `
          <div class="panel-row week-row">
            <div class="panel-row-label">${escapeHTML(g.name)}</div>
            <div class="panel-row-value">${pct}%</div>
          </div>
        `;
      }).join('');
    }

    function renderWeekSelector() {
      const selector = document.getElementById('weekSelector');
      selector.innerHTML = '';
      const weekCount = Math.max(1, ...appState.plan.categories.map(c => weekNumOf(c.name)), Math.ceil(appState.plan.totalDays / 7));
      for (let w = 1; w <= weekCount; w++) {
        const opt = document.createElement('option');
        opt.value = w;
        opt.textContent = `Week ${w}`;
        if (w === appState.currentWeek) opt.selected = true;
        selector.appendChild(opt);
      }
      selector.onchange = () => { appState.currentWeek = parseInt(selector.value, 10); updateTimelinePanel(); renderTasks(); };
    }

    // Shows one week at a time (Week N = 7 days: Sat-Fri)
    // For each day, displays all categories that need to be completed that day
    // User checks off categories sequentially within each day
    // Progress = (total categories completed across all days) / (7 days × categories per day)
    function renderTasks() {
      const grid = document.getElementById('taskGrid');
      const heading = document.getElementById('weekBigHeading');
      const sub = document.getElementById('weekHeadingSub');
      grid.innerHTML = '';

      heading.textContent = `Week ${appState.currentWeek}`;

      // Get all categories for this week
      const weekCats = appState.plan.categories
        .filter(cat => weekNumOf(cat.name) === appState.currentWeek)
        .sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category));

      if (weekCats.length === 0) {
        sub.textContent = '';
        grid.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📋</div><p>No tasks for this week yet. Add tasks in the Admin panel.</p></div>';
        return;
      }

      // Week 1 = 7 days, each day has the same categories
      const daysPerWeek = 7;
      const totalCatsPerDay = weekCats.length;
      const totalExpected = daysPerWeek * totalCatsPerDay;
      const totalCompleted = weekCats.reduce((sum, c) => sum + (Number(c.completed) || 0), 0);
      const weekPct = totalExpected > 0 ? Math.round((totalCompleted / totalExpected) * 100) : 0;
      sub.textContent = `${totalCompleted}/${totalExpected} · ${weekPct}% complete`;

      // Task cards (one per category, showing all 7 days for this week).
      // The sequential "which category is next" checklist lives in the
      // 🎯 Today's Focus sidebar box instead — no need to duplicate it here.
      weekCats.forEach(cat => {
        const card = document.createElement('div');
        const completed = Number(cat.completed) || 0;
        const progress = daysPerWeek > 0 ? Math.round((completed / daysPerWeek) * 100) : 0;
        const catColor = CATEGORY_COLORS[cat.category] || 'var(--stone)';
        const progressLevel = Math.floor(progress / 6.67); // 0-15 scale for color buckets
        card.className = 'cat-task-card fade-in' + (completed >= daysPerWeek ? ' completed' : '');
        card.style.setProperty('--cat-color', catColor);

        card.innerHTML = `
          <div class="task-header">
            <div>
              <span class="cat-badge" style="--cat-color:${catColor};">${escapeHTML(cat.category)}</span>
              ${cat.desc ? `<div class="cat-target-sub">${escapeHTML(cat.desc)}</div>` : ''}
            </div>
            <div class="progress-ring" style="--progress: ${progress * 3.6}deg;">${progress}%</div>
          </div>
          <div class="progress-bar">
            <div class="progress-fill" style="width: ${progress}%;" data-progress="${progressLevel}"></div>
          </div>
          <div class="day-checks">
            ${[...Array(daysPerWeek)].map((_, i) => {
              const dayNames = ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
              return `
              <div class="day-check${i < completed ? ' done' : ''}" data-cat="${cat.id}" data-day="${i}" title="Day ${i + 1} (${dayNames[i]})">
                ${dayNames[i]}
              </div>
            `}).join('')}
          </div>
        `;
        grid.appendChild(card);
      });

      // Event delegation
      grid.querySelectorAll('.day-check').forEach(el => {
        el.addEventListener('click', () => toggleDay(el.dataset.cat, parseInt(el.dataset.day, 10), el));
      });
    }

    // Optimistic update: checking off a day increments the completion count
    // The checkbox flips instantly in the UI, Firestore write happens in background
    // When all 7 days are complete, next category becomes active
    window.toggleDay = async function(catId, dayIndex, el) {
      if (!appState.user) return;
      const cat = appState.plan.categories.find(c => c.id === catId);
      if (!cat) return;

      const previous = cat.completed;
      // Allow toggling: if clicking past current, advance; if clicking before, go to that day
      const next = cat.completed > dayIndex ? dayIndex : dayIndex + 1;
      // Cap at 7 (one week)
      const finalNext = Math.min(next, 7);
      cat.completed = finalNext;

      // Repaint immediately, without waiting on Firestore.
      renderTasks();
      renderCategoryProgress();
      renderWeeklySummary();
      renderTodaysFocus();
      updateTimelinePanel();

      try {
        await setDoc(doc(db, "users", appState.user.uid, "progress", catId), {
          completed: finalNext,
          updatedAt: new Date()
        }, { merge: true });
        appState.progress[catId] = finalNext;
      } catch (error) {
        console.error("Error updating progress:", error);
        // Roll back on failure
        cat.completed = previous;
        renderTasks();
        renderCategoryProgress();
        renderWeeklySummary();
        renderTodaysFocus();
        updateTimelinePanel();
        alert('Could not save that change — please check your connection and try again.');
      }
    }

    // TODAY'S FOCUS — a sequential checklist for *today specifically*.
    // Shows every category scheduled for today's week, in order
    // (Agronomy Part-1 → Agronomy 131-140 → Letter A → BCS Target, etc).
    // Only ONE item blinks at a time: the first one not yet checked off
    // for today. Once it's checked, it hides and the next one starts
    // blinking. Categories already done for today are hidden entirely.
    function renderTodaysFocus() {
      const focusEl = document.getElementById('todaysFocus');
      const focusCard = document.getElementById('todaysFocusCard');
      const metaEl = document.getElementById('todaysFocusMeta');
      focusCard.classList.remove('blinking'); // no more whole-box blinking

      const { week: todayWeek, day: todayDayIndex } = getTodayPointer();
      const dayNames = ['Saturday', 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
      const todayName = dayNames[todayDayIndex];

      const weekCats = appState.plan.categories
        .filter(cat => weekNumOf(cat.name) === todayWeek)
        .sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category));

      metaEl.textContent = `📅 ${todayName} · Week ${todayWeek}, Day ${todayDayIndex + 1} of 7`;

      if (weekCats.length === 0) {
        focusEl.innerHTML = '<div class="text-muted" style="font-size:0.9rem;">📋 No tasks assigned yet for this week. Check the Admin panel.</div>';
        return;
      }

      // A category counts as "done for today" once its completed-days
      // count has passed today's day-index (day-checks fill in order,
      // so completed > todayDayIndex means today's box is checked).
      let foundActive = false;
      let allDoneToday = true;

      const rows = weekCats.map(cat => {
        const completed = Number(cat.completed) || 0;
        const doneToday = completed > todayDayIndex;
        if (!doneToday) allDoneToday = false;

        let stateClass = '';
        if (!doneToday && !foundActive) {
          stateClass = 'active';
          foundActive = true;
        } else if (doneToday) {
          stateClass = 'completed hidden'; // hide once checked for today
        }

        const statusEmoji = doneToday ? '✓' : '';
        const clickable = stateClass === 'active';

        return `
          <div class="category-item ${stateClass}" ${clickable ? `data-cat="${cat.id}" data-day="${todayDayIndex}" style="cursor:pointer;"` : ''}>
            <div class="category-name">${escapeHTML(cat.category)} · ${escapeHTML(cat.desc || '')}</div>
            ${statusEmoji ? `<div class="category-status">${statusEmoji}</div>` : ''}
          </div>
        `;
      }).join('');

      focusEl.innerHTML = allDoneToday
        ? `<div style="color: var(--moss-dark); font-weight: 600; font-size: 0.95rem;">🎉 All done for today! Great work.</div>`
        : rows;

      // Let the student tap the active (blinking) row to check it off
      // directly, instead of having to scroll down to the day-check grid.
      focusEl.querySelectorAll('.category-item.active[data-cat]').forEach(el => {
        el.addEventListener('click', () => toggleDay(el.dataset.cat, parseInt(el.dataset.day, 10), el));
      });
    }

    // ───────────────────────────
    // PROFILE VIEW — account settings + embedded admin management
    // ───────────────────────────
    function renderProfileView() {
      if (!appState.user) return;

      if (appState.isAdmin) {
        document.getElementById('pfPlanStartDate').value = toISODate(appState.plan.startDate);
        const end = new Date(new Date(appState.plan.startDate).getTime() + (appState.plan.totalDays - 1) * 86400000);
        document.getElementById('pfPlanEndDate').value = toISODate(end);

        const taskListEl = document.getElementById('pfTaskList');
        const ordered = [...appState.plan.categories].sort((a, b) => {
          const wkDiff = weekNumOf(a.name) - weekNumOf(b.name);
          if (wkDiff !== 0) return wkDiff;
          return CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category);
        });

        taskListEl.innerHTML = ordered.length
          ? ordered.map(t => `
              <div class="inline-list-row">
                <span><strong>${escapeHTML(t.name)}</strong> · ${escapeHTML(t.category)} · ${Number(t.days) || 0} days${t.desc ? ' — ' + escapeHTML(t.desc) : ''}</span>
                <div class="row-actions">
                  <button class="btn btn-sm btn-secondary" onclick="editTaskInline('${t.id}')">Edit</button>
                  <button class="btn btn-sm btn-danger" onclick="deleteTaskInline('${t.id}')">Delete</button>
                </div>
              </div>
            `).join('')
          : '<div class="inline-list-row text-muted">No tasks yet.</div>';

        const eventListEl = document.getElementById('pfEventList');
        const orderedEvents = [...appState.events].sort((a, b) => new Date(eventDateRange(a).start) - new Date(eventDateRange(b).start));
        eventListEl.innerHTML = orderedEvents.length
          ? orderedEvents.map(e => {
              const { start, end } = eventDateRange(e);
              const dateLabel = !start ? '—' : (start === end
                ? new Date(start).toLocaleDateString('en-GB')
                : `${new Date(start).toLocaleDateString('en-GB')} – ${new Date(end).toLocaleDateString('en-GB')}`);
              return `
                <div class="inline-list-row">
                  <span><strong>${escapeHTML(e.title)}</strong> · ${dateLabel} · ${escapeHTML(e.type || '')}</span>
                  <div class="row-actions">
                    <button class="btn btn-sm btn-secondary" onclick="editEventInline('${e.id}')">Edit</button>
                    <button class="btn btn-sm btn-danger" onclick="deleteEventInline('${e.id}')">Delete</button>
                  </div>
                </div>
              `;
            }).join('')
          : '<div class="inline-list-row text-muted">No events yet.</div>';
      }
    }

    window.saveDisplayName = async function() {
      const msgEl = document.getElementById('profileNameMsg');
      const name = document.getElementById('profileDisplayName').value.trim();
      msgEl.textContent = '';
      msgEl.classList.remove('ok');
      try {
        await updateProfile(auth.currentUser, { displayName: name });
        msgEl.textContent = 'Saved.';
        msgEl.classList.add('ok');
      } catch (error) {
        msgEl.textContent = `Could not save: ${error.code || error.message}`;
      }
    }

    window.changePassword = async function() {
      const msgEl = document.getElementById('profilePasswordMsg');
      const currentPassword = document.getElementById('profileCurrentPassword').value;
      const newPassword = document.getElementById('profileNewPassword').value;
      msgEl.textContent = '';
      msgEl.classList.remove('ok');

      if (!currentPassword || !newPassword) {
        msgEl.textContent = 'Enter your current and new password.';
        return;
      }
      if (newPassword.length < 6) {
        msgEl.textContent = 'New password must be at least 6 characters.';
        return;
      }

      try {
        // Firebase requires a recent login before letting you change your
        // password — re-authenticating here does that without forcing a
        // full logout/login cycle.
        const credential = EmailAuthProvider.credential(auth.currentUser.email, currentPassword);
        await reauthenticateWithCredential(auth.currentUser, credential);
        await updatePassword(auth.currentUser, newPassword);
        document.getElementById('profileCurrentPassword').value = '';
        document.getElementById('profileNewPassword').value = '';
        msgEl.textContent = 'Password updated.';
        msgEl.classList.add('ok');
      } catch (error) {
        msgEl.textContent = `Could not update password: ${error.code || error.message}`;
      }
    }

    async function savePlanDates() {
      const msgEl = document.getElementById('pfPlanMsg');
      const startVal = document.getElementById('pfPlanStartDate').value;
      const endVal = document.getElementById('pfPlanEndDate').value;
      msgEl.textContent = '';
      msgEl.style.color = 'var(--terracotta)';

      if (!startVal || !endVal) {
        msgEl.textContent = 'Pick both a starting and ending date.';
        return;
      }
      if (endVal < startVal) {
        msgEl.textContent = 'Ending date must be on or after the starting date.';
        return;
      }

      // Weeks always need to begin on Sunday (Day 1 = Sunday, ... Day 7 = Saturday).
      // If the admin picks a start date that isn't a Sunday, roll it back to the
      // Sunday on/before the picked date, so the picked date still falls inside
      // Week 1 — rather than silently starting the week on the wrong weekday.
      const pickedStart = new Date(startVal + 'T00:00:00');
      const weekday = pickedStart.getDay(); // 0 = Sunday
      const sundayStart = new Date(pickedStart);
      sundayStart.setDate(sundayStart.getDate() - weekday);
      const adjustedStartVal = toISODate(sundayStart);
      const wasAdjusted = adjustedStartVal !== startVal;

      try {
        await setDoc(doc(db, "settings", "plan"), { startDate: adjustedStartVal, endDate: endVal });
        appState.plan.startDate = new Date(adjustedStartVal + 'T00:00:00');
        appState.plan.endDate = endVal;
        const s = new Date(adjustedStartVal + 'T00:00:00');
        const e = new Date(endVal + 'T00:00:00');
        appState.plan.totalDays = Math.max(1, Math.round((e - s) / 86400000) + 1);

        // Reflect the actually-applied (Sunday-aligned) date back into the input
        // so the field never shows a stale, un-adjusted value.
        document.getElementById('pfPlanStartDate').value = adjustedStartVal;

        render();
        msgEl.style.color = 'var(--moss)';
        msgEl.textContent = wasAdjusted
          ? `Plan duration saved. Start date shifted back to Sunday, ${sundayStart.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' })}, so weeks begin on Sunday.`
          : 'Plan duration saved.';
      } catch (error) {
        msgEl.textContent = `Could not save: ${error.code || error.message}`;
      }
    }

    // ───────────────────────────
    // TASK ADD / EDIT / DELETE (admin)
    // ───────────────────────────
    let editingTaskId = null;

    function resetTaskForm() {
      document.getElementById('pfTaskName').value = '';
      document.getElementById('pfTaskCategory').value = 'BAU';
      document.getElementById('pfTaskDays').value = '';
      document.getElementById('pfTaskDesc').value = '';
      editingTaskId = null;
      document.getElementById('addTaskBtn').textContent = '+ Add Task';
      document.getElementById('cancelTaskEditBtn').style.display = 'none';
    }

    // Populates the Add Task form with an existing task's values and
    // switches the form into "update" mode, so admins can change a
    // category's target/days without deleting and re-creating it.
    window.editTaskInline = function(taskId) {
      const t = appState.plan.categories.find(c => c.id === taskId);
      if (!t) return;
      document.getElementById('pfTaskName').value = t.name || '';
      document.getElementById('pfTaskCategory').value = t.category || 'BAU';
      document.getElementById('pfTaskDays').value = Number(t.days) || '';
      document.getElementById('pfTaskDesc').value = t.desc || '';
      editingTaskId = taskId;
      document.getElementById('addTaskBtn').textContent = 'Update Task';
      document.getElementById('cancelTaskEditBtn').style.display = '';
      document.getElementById('pfTaskMsg').textContent = '';
      document.getElementById('pfTaskName').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    window.cancelTaskEdit = function() {
      resetTaskForm();
      document.getElementById('pfTaskMsg').textContent = '';
    }

    window.addTaskInline = async function() {
      const msgEl = document.getElementById('pfTaskMsg');
      const name = document.getElementById('pfTaskName').value.trim();
      const category = document.getElementById('pfTaskCategory').value;
      const days = parseInt(document.getElementById('pfTaskDays').value, 10);
      const desc = document.getElementById('pfTaskDesc').value.trim();
      msgEl.textContent = '';

      if (!name || !days || days < 1) {
        msgEl.textContent = 'Enter a week name and a valid number of days.';
        return;
      }

      try {
        if (editingTaskId) {
          await updateDoc(doc(db, "tasks", editingTaskId), { name, category, days, desc });
        } else {
          await addDoc(collection(db, "tasks"), { name, category, days, desc, completed: 0, createdAt: new Date() });
        }
        resetTaskForm();
        await loadData();
        render();
      } catch (error) {
        msgEl.textContent = `Could not save task: ${error.code || error.message}`;
      }
    }

    window.deleteTaskInline = async function(taskId) {
      if (!confirm('Delete this task? This cannot be undone.')) return;
      try {
        await deleteDoc(doc(db, "tasks", taskId));
        if (editingTaskId === taskId) resetTaskForm();
        await loadData();
        render();
      } catch (error) {
        alert(`Could not delete task: ${error.code || error.message}`);
      }
    }

    // ───────────────────────────
    // EVENT ADD / EDIT / DELETE (admin)
    // ───────────────────────────
    let editingEventId = null;

    // Events store startDate/endDate. Falls back to the older single
    // "date" field for events created before this feature existed, so
    // nothing already in Firestore breaks.
    function eventDateRange(e) {
      const start = e.startDate || e.date || '';
      const end = e.endDate || start;
      return { start, end };
    }

    function resetEventForm() {
      document.getElementById('pfEventTitle').value = '';
      document.getElementById('pfEventStartDate').value = '';
      document.getElementById('pfEventEndDate').value = '';
      document.getElementById('pfEventType').value = 'Exam';
      editingEventId = null;
      document.getElementById('addEventBtn').textContent = '+ Add Event';
      document.getElementById('cancelEventEditBtn').style.display = 'none';
    }

    window.editEventInline = function(eventId) {
      const e = appState.events.find(ev => ev.id === eventId);
      if (!e) return;
      const { start, end } = eventDateRange(e);
      document.getElementById('pfEventTitle').value = e.title || '';
      document.getElementById('pfEventStartDate').value = start || '';
      document.getElementById('pfEventEndDate').value = (end && end !== start) ? end : '';
      document.getElementById('pfEventType').value = e.type || 'Exam';
      editingEventId = eventId;
      document.getElementById('addEventBtn').textContent = 'Update Event';
      document.getElementById('cancelEventEditBtn').style.display = '';
      document.getElementById('pfEventMsg').textContent = '';
      document.getElementById('pfEventTitle').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    window.cancelEventEdit = function() {
      resetEventForm();
      document.getElementById('pfEventMsg').textContent = '';
    }

    window.addEventInline = async function() {
      const msgEl = document.getElementById('pfEventMsg');
      const title = document.getElementById('pfEventTitle').value.trim();
      const startDate = document.getElementById('pfEventStartDate').value;
      let endDate = document.getElementById('pfEventEndDate').value;
      const type = document.getElementById('pfEventType').value;
      msgEl.textContent = '';

      if (!title || !startDate) {
        msgEl.textContent = 'Enter an event title and a start date.';
        return;
      }
      if (endDate && endDate < startDate) {
        msgEl.textContent = 'End date cannot be before the start date.';
        return;
      }
      if (!endDate) endDate = startDate;

      try {
        if (editingEventId) {
          await updateDoc(doc(db, "events", editingEventId), { title, startDate, endDate, type });
        } else {
          await addDoc(collection(db, "events"), { title, startDate, endDate, type });
        }
        resetEventForm();
        await loadData();
        render();
      } catch (error) {
        msgEl.textContent = `Could not save event: ${error.code || error.message}`;
      }
    }

    window.deleteEventInline = async function(eventId) {
      if (!confirm('Delete this event?')) return;
      try {
        await deleteDoc(doc(db, "events", eventId));
        if (editingEventId === eventId) resetEventForm();
        await loadData();
        render();
      } catch (error) {
        alert(`Could not delete event: ${error.code || error.message}`);
      }
    }

    function renderCalendar() {
      const grid = document.getElementById('calendarGrid');
      const monthLabel = document.getElementById('calendarMonth');
      
      const today = new Date();
      const year = today.getFullYear();
      const month = today.getMonth();
      
      monthLabel.textContent = new Date(year, month).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      
      grid.innerHTML = '';
      
      // Day of week headers
      ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].forEach(day => {
        const dow = document.createElement('div');
        dow.className = 'cal-dow';
        dow.textContent = day;
        grid.appendChild(dow);
      });

      const firstDay = new Date(year, month, 1).getDay();
      const daysInMonth = new Date(year, month + 1, 0).getDate();

      // Empty cells
      for (let i = 0; i < firstDay; i++) {
        const cell = document.createElement('div');
        cell.className = 'cal-day empty';
        grid.appendChild(cell);
      }

      // Days
      for (let day = 1; day <= daysInMonth; day++) {
        const cell = document.createElement('div');
        const date = new Date(year, month, day);
        cell.className = 'cal-day';
        cell.textContent = day;

        const isToday = date.toDateString() === today.toDateString();
        const isExamDay = appState.events.some(e => {
          if (e.type !== 'Exam') return false;
          const { start, end } = eventDateRange(e);
          if (!start) return false;
          const s = new Date(start); s.setHours(0, 0, 0, 0);
          const en = new Date(end || start); en.setHours(0, 0, 0, 0);
          return date >= s && date <= en;
        });

        if (isToday) cell.classList.add('today');
        if (isExamDay) cell.classList.add('exam-day');

        grid.appendChild(cell);
      }
    }

    function renderUpcomingEvents() {
      const container = document.getElementById('upcomingEvents');
      const nextWeekContainer = document.getElementById('nextWeekEvents');

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const weekFromNow = new Date(today);
      weekFromNow.setDate(weekFromNow.getDate() + 7);

      // An event counts as "upcoming" if it hasn't fully ended yet (its end
      // date is today or later) and it starts within the next 7 days —
      // this way multi-day events (e.g. an exam period) still show up for
      // their whole duration, not just their first day.
      const upcomingEvents = appState.events
        .map(e => ({ e, ...eventDateRange(e) }))
        .filter(({ start, end }) => {
          if (!start) return false;
          const s = new Date(start); s.setHours(0, 0, 0, 0);
          const en = new Date(end || start); en.setHours(0, 0, 0, 0);
          return en >= today && s <= weekFromNow;
        })
        .sort((a, b) => new Date(a.start) - new Date(b.start));

      if (upcomingEvents.length === 0) {
        container.innerHTML = '<div class="text-muted text-center">No events scheduled</div>';
        nextWeekContainer.innerHTML = '<div class="text-muted text-sm">No events scheduled</div>';
      } else {
        const dateLabelFor = ({ start, end }) => start === end
          ? new Date(start).toLocaleDateString('en-GB')
          : `${new Date(start).toLocaleDateString('en-GB')} – ${new Date(end).toLocaleDateString('en-GB')}`;

        container.innerHTML = upcomingEvents.map(x => `
          <div class="event-item fade-in">
            <div class="event-date">${dateLabelFor(x)}</div>
            <div class="event-title">${escapeHTML(x.e.title)}</div>
          </div>
        `).join('');

        nextWeekContainer.innerHTML = upcomingEvents.map(x => `
          <div class="event-item fade-in">
            <div class="event-date">${dateLabelFor(x)}</div>
            <div class="event-title" style="font-size: 0.9rem;">${escapeHTML(x.e.title)}</div>
          </div>
        `).join('');
      }
    }

    // ═══════════════════════════════════════════════════════════
    // DAILY TRACKER — personal, self-service category tracker with
    // a floating study timer. Uses the SAME sign-in and Firestore
    // project as the rest of the app (doc: dailyTrackers/{uid}),
    // so there is only one login system for the whole site.
    // ═══════════════════════════════════════════════════════════
    const DT_MAX_CATS = 10;
    let dtUid = null;
    let dtData = null;          // { categories:[...], totalStudySecs, createdAt }
    let dtArchiveOpen = false;

    // ── timer state ──
    let dtTimerInt = null;
    let dtTimerRunning = false;
    let dtRunStartTs = null;
    let dtBaseSessionSecs = 0;

    function dtReset() {
      dtUid = null; dtData = null;
      clearInterval(dtTimerInt); dtTimerRunning = false; dtRunStartTs = null; dtBaseSessionSecs = 0;
      document.getElementById('dtTimerFab').style.display = 'none';
    }

    async function dtInit(uid) {
      dtUid = uid;
      try {
        const snap = await getDoc(doc(db, 'dailyTrackers', uid));
        dtData = snap.exists() ? snap.data() : null;
      } catch (e) {
        console.error('Error loading Daily Tracker:', e);
        dtData = null;
      }
      if (dtData && Array.isArray(dtData.categories) && dtData.categories.length) {
        dtShowTracker();
      } else {
        dtShowSetup();
      }
      // Keep the timer FAB in sync with whichever view is currently open
      const onDtView = document.getElementById('dailyTrackerView').style.display !== 'none';
      document.getElementById('dtTimerFab').style.display = (onDtView && dtData) ? 'block' : 'none';
    }

    async function dtSave() {
      if (!dtUid || !dtData) return;
      try {
        await setDoc(doc(db, 'dailyTrackers', dtUid), dtData);
      } catch (e) {
        console.error('Error saving Daily Tracker:', e);
      }
    }

    // ─── SETUP SCREEN ───
    function dtShowSetup() {
      document.getElementById('dtSetupCard').style.display = '';
      document.getElementById('dtTrackerScreen').style.display = 'none';
      document.getElementById('dtTimerFab').style.display = 'none';
      const rows = document.getElementById('dtCatRows');
      rows.innerHTML = '';
      const existing = (dtData?.categories || []).filter(c => !c.archived);
      if (existing.length) {
        existing.forEach(c => dtAddCatRow(c.name, c.target, c.targetDays));
        document.getElementById('dtSetupIntro').textContent = 'Edit your categories below, or add new ones. Existing progress is kept for categories you don\u2019t rename.';
      } else {
        document.getElementById('dtSetupIntro').textContent = 'Add your own study categories with a target number of days each, then start checking off days as you study. This tracker is private to your account.';
        dtAddCatRow();
      }
      dtUpdateCatCount();
    }

    function dtAddCatRow(name = '', target = '', days = '') {
      const rows = document.getElementById('dtCatRows');
      if (rows.children.length >= DT_MAX_CATS) return;
      const row = document.createElement('div');
      row.className = 'dt-setup-row';
      row.innerHTML = `
        <input type="text" class="login-input dt-cn" placeholder="Category name" value="${escapeHTML(name)}" style="margin-bottom:0;">
        <input type="text" class="login-input dt-ct" placeholder="Target / chapter" value="${escapeHTML(target)}" style="margin-bottom:0;">
        <input type="number" min="1" class="login-input dt-cd" placeholder="Days" value="${days}" style="margin-bottom:0;">
        <button type="button" class="dt-rm-btn">✕</button>
      `;
      row.querySelector('.dt-rm-btn').addEventListener('click', () => { row.remove(); dtUpdateCatCount(); });
      rows.appendChild(row);
      dtUpdateCatCount();
    }

    function dtUpdateCatCount() {
      const n = document.getElementById('dtCatRows').children.length;
      document.getElementById('dtCatCount').textContent = `${n} / ${DT_MAX_CATS} categories`;
      document.getElementById('dtAddCatBtn').style.display = n >= DT_MAX_CATS ? 'none' : '';
    }

    async function dtGenerateTracker() {
      const rowsEl = document.querySelectorAll('#dtCatRows .dt-setup-row');
      const prevByName = {};
      (dtData?.categories || []).forEach(c => { prevByName[c.name.trim().toLowerCase()] = c; });

      const cats = [];
      let invalid = false;
      rowsEl.forEach(r => {
        const name = r.querySelector('.dt-cn').value.trim();
        const target = r.querySelector('.dt-ct').value.trim();
        const daysN = parseInt(r.querySelector('.dt-cd').value, 10);
        if (!name) return;
        if (isNaN(daysN) || daysN < 1) { invalid = true; return; }
        const prev = prevByName[name.toLowerCase()];
        let daysArr;
        if (prev && !prev.archived) {
          daysArr = prev.days.slice(0, daysN);
          while (daysArr.length < daysN) daysArr.push(false);
        } else {
          daysArr = Array(daysN).fill(false);
        }
        cats.push({
          id: prev?.id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
          name, target: target || '—', targetDays: daysN,
          days: daysArr, archived: false
        });
      });

      if (invalid) return dtSetupMsg('Each category needs a valid number of days (1+).', true);
      if (!cats.length) return dtSetupMsg('Add at least one category with a name and target days.', true);

      // Preserve already-archived categories untouched
      const archived = (dtData?.categories || []).filter(c => c.archived);

      dtData = {
        categories: [...cats, ...archived],
        totalStudySecs: dtData?.totalStudySecs || 0,
        createdAt: dtData?.createdAt || new Date().toISOString()
      };
      await dtSave();
      dtSetupMsg('Saved!', false);
      dtShowTracker();
    }

    function dtSetupMsg(msg, isError) {
      const el = document.getElementById('dtSetupMsg');
      el.textContent = msg;
      el.style.color = isError ? 'var(--terracotta)' : 'var(--moss)';
      if (!isError) setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 2500);
    }

    // ─── TRACKER SCREEN ───
    function dtShowTracker() {
      document.getElementById('dtSetupCard').style.display = 'none';
      document.getElementById('dtTrackerScreen').style.display = '';
      const onDtView = document.getElementById('dailyTrackerView').style.display !== 'none';
      document.getElementById('dtTimerFab').style.display = onDtView ? 'block' : 'none';
      document.getElementById('dtTitle').textContent = `My Daily Tracker`;
      document.getElementById('dtStarted').textContent = dtData?.createdAt
        ? `Started ${new Date(dtData.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`
        : '';
      dtRenderCards();
      dtRenderArchive();
      dtFillTimerCats();
    }

    function dtProgress(cat) {
      const checked = cat.days.filter(Boolean).length;
      const pct = cat.targetDays ? Math.min(100, Math.round(checked / cat.targetDays * 100)) : 0;
      return { checked, pct };
    }

    function dtRenderCards() {
      const wrap = document.getElementById('dtCardsWrap');
      wrap.innerHTML = '';
      const active = dtData.categories.filter(c => !c.archived);
      if (!active.length) {
        wrap.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🗓️</div><p>All categories archived — add a new one from "Add / Edit Categories".</p></div>';
        return;
      }
      active.forEach(cat => {
        const { checked, pct } = dtProgress(cat);
        const card = document.createElement('div');
        card.className = 'dt-card fade-in';
        card.innerHTML = `
          <div class="dt-card-top">
            <div>
              <div class="dt-cat-name">${escapeHTML(cat.name)}</div>
              <div class="dt-cat-target">${escapeHTML(cat.target)} · ${checked}/${cat.targetDays} days</div>
            </div>
            <div class="dt-pct-chip${pct >= 100 ? ' full' : ''}">${pct}%</div>
          </div>
          <div class="dt-days"></div>
        `;
        const daysEl = card.querySelector('.dt-days');
        cat.days.forEach((done, di) => {
          const d = document.createElement('div');
          d.className = 'dt-day' + (done ? ' done' : '');
          d.textContent = done ? '✓' : (di + 1);
          d.addEventListener('click', () => dtToggleDay(cat.id, di));
          daysEl.appendChild(d);
        });
        wrap.appendChild(card);
      });
    }

    async function dtToggleDay(catId, dayIdx) {
      const cat = dtData.categories.find(c => c.id === catId);
      if (!cat) return;
      cat.days[dayIdx] = !cat.days[dayIdx];

      // Auto-archive once every day is checked, preserving the record.
      const { checked } = dtProgress(cat);
      if (checked >= cat.targetDays && !cat.archived) {
        cat.archived = true;
        cat.finalChecked = checked;
        cat.completedAt = new Date().toLocaleDateString('en-GB');
      }
      dtRenderCards();
      dtRenderArchive();
      await dtSave();
    }

    function dtRenderArchive() {
      const arc = dtData.categories.filter(c => c.archived);
      const section = document.getElementById('dtArchiveSection');
      if (!arc.length) { section.style.display = 'none'; return; }
      section.style.display = '';
      document.getElementById('dtArchiveBadge').textContent = arc.length;
      const list = document.getElementById('dtArchiveList');
      list.className = 'dt-archive-list' + (dtArchiveOpen ? ' open' : '');
      list.innerHTML = arc.map(c => `
        <div class="dt-archive-card">
          <div>
            <div style="font-weight:600;">${escapeHTML(c.name)}</div>
            <div class="text-muted text-sm">${escapeHTML(c.target)} · ${c.finalChecked || c.targetDays}/${c.targetDays} days${c.completedAt ? ' · Completed ' + c.completedAt : ''}</div>
          </div>
          <div class="dt-pct-chip full">✓ 100%</div>
        </div>
      `).join('');
    }

    function dtToggleArchive() {
      dtArchiveOpen = !dtArchiveOpen;
      dtRenderArchive();
    }

    // ─── STUDY TIMER (localStorage-persisted, flushed to Firestore) ───
    function dtPad2(n) { return String(n).padStart(2, '0'); }

    function dtLiveElapsed() {
      return dtTimerRunning ? Math.floor((Date.now() - dtRunStartTs) / 1000) : 0;
    }

    function dtUpdateDigits() {
      const secs = dtBaseSessionSecs + dtLiveElapsed();
      const hh = Math.floor(secs / 3600), mm = Math.floor((secs % 3600) / 60), ss = secs % 60;
      document.getElementById('dtTimerDigits').textContent = `${dtPad2(hh)}:${dtPad2(mm)}:${dtPad2(ss)}`;
    }

    function dtRunTick() {
      clearInterval(dtTimerInt);
      dtUpdateDigits();
      dtTimerInt = setInterval(dtUpdateDigits, 1000);
    }

    function dtFillTimerCats() {
      const sel = document.getElementById('dtTimerCatSel');
      sel.innerHTML = '<option value="">— No category —</option>';
      (dtData?.categories || []).forEach(c => {
        if (c.archived) return;
        const o = document.createElement('option');
        o.value = c.id; o.textContent = c.name;
        sel.appendChild(o);
      });
    }

    function dtToggleTimerPanel() {
      document.getElementById('dtTimerPanel').classList.toggle('open');
    }

    async function dtTimerStart() {
      const btn = document.getElementById('dtTimerStartBtn');
      const tog = document.getElementById('dtTimerTog');
      if (dtTimerRunning) {
        // Pause — flush elapsed time into the running total
        dtTimerRunning = false;
        dtBaseSessionSecs += dtLiveElapsed();
        clearInterval(dtTimerInt);
        dtData.totalStudySecs = (dtData.totalStudySecs || 0) + dtLiveElapsed();
        btn.textContent = '▶ Start';
        tog.classList.remove('running');
        await dtSave();
      } else {
        dtTimerRunning = true;
        dtRunStartTs = Date.now();
        btn.textContent = '⏸ Pause';
        tog.classList.add('running');
        dtRunTick();
      }
    }

    function dtTimerReset() {
      if (dtTimerRunning) dtTimerStart(); // pause & flush first
      clearInterval(dtTimerInt);
      dtBaseSessionSecs = 0;
      dtUpdateDigits();
    }

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && dtTimerRunning) dtRunTick();
    });
    window.addEventListener('focus', () => { if (dtTimerRunning) dtRunTick(); });
