    import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
    import { initializeFirestore, persistentLocalCache, collection, getDocs, addDoc, updateDoc, deleteDoc, setDoc, doc, getDoc, onSnapshot, writeBatch } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
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

    // Formats a "HH:MM" 24h string (from an <input type="time">) into a
    // friendly 12h label, e.g. "14:30" -> "2:30 PM". Returns '' if empty/invalid.
    function formatTime12h(hhmm) {
      if (!hhmm) return '';
      const [h, m] = hhmm.split(':').map(Number);
      if (Number.isNaN(h) || Number.isNaN(m)) return '';
      const period = h >= 12 ? 'PM' : 'AM';
      const h12 = h % 12 === 0 ? 12 : h % 12;
      return `${h12}:${String(m).padStart(2, '0')} ${period}`;
    }

    // Loading-overlay helpers: show the spinner, hide everything, or swap
    // to an error message + retry button so a stuck load is never silent.
    function showLoadOverlay() {
      document.getElementById('loadSpinner').style.display = '';
      document.getElementById('loadOverlayText').textContent = 'Loading your plan…';
      document.getElementById('loadRetryBtn').style.display = 'none';
      document.getElementById('loadOverlay').style.display = 'flex';
    }
    function hideLoadOverlay() {
      document.getElementById('loadOverlay').style.display = 'none';
    }
    function showLoadOverlayError(message) {
      document.getElementById('loadSpinner').style.display = 'none';
      document.getElementById('loadOverlayText').textContent = message;
      document.getElementById('loadRetryBtn').style.display = '';
      document.getElementById('loadOverlay').style.display = 'flex';
    }

    // Small popup notification (success/error) in the top-right corner —
    // used instead of native alert()/confirm() for anything that isn't a
    // destructive confirmation. Auto-dismisses after ~3.5s.
    function showToast(message, type = 'success') {
      const wrap = document.getElementById('toastWrap');
      if (!wrap) return;
      const el = document.createElement('div');
      el.className = `toast ${type}`;
      el.textContent = message;
      wrap.appendChild(el);
      setTimeout(() => {
        el.classList.add('hide');
        setTimeout(() => el.remove(), 250);
      }, 3500);
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
        title: "90-Day Study Plan",
        startDate: new Date(2026, 6, 12), // July 12, 2026
        totalDays: 90, // 90-day target — kept in sync with initApp() below and
                       // overridden once a real settings/plan doc is saved
        categories: []
      },
      events: [],
      currentWeek: 1,
      user: null,
      guestMode: false,
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
          appState.guestMode = false;
          document.body.classList.remove('guest-mode');
          document.getElementById('guestBanner').style.display = 'none';
          document.getElementById('logoutBtn').textContent = 'Logout';

          document.getElementById('loginGate').style.display = 'none';
          document.getElementById('appContent').style.display = '';
          showLoadOverlay();

          document.getElementById('profileEmailDisplay').textContent = user.email;
          document.getElementById('profileDisplayName').value = user.displayName || '';

          try {
            // Guard against a Firestore request that never resolves — e.g.
            // the security rules were saved to the repo but never actually
            // deployed to Firebase, or a network/ad-blocker/CSP issue is
            // silently swallowing the request. Bail out after 12s with a
            // clear error instead of spinning forever.
            await Promise.race([
              loadData(),
              new Promise((_, reject) => setTimeout(
                () => reject(new Error('This is taking too long — check your internet connection, and make sure the Firestore rules have actually been deployed (not just saved in the repo).')),
                12000
              ))
            ]);

            // Default the tracker to the week of the next incomplete task,
            // so returning students land where they left off instead of
            // always seeing Week 1.
            const ordered = [...appState.plan.categories].sort((a, b) => weekNumOf(a.name) - weekNumOf(b.name));
            const nextUp = ordered.find(cat => (cat.completed || 0) < 7);
            appState.currentWeek = nextUp ? weekNumOf(nextUp.name) : 1;

            render();
            dtInit(user.uid);
            hideLoadOverlay();
          } catch (error) {
            console.error('Error during post-login load:', error);
            showLoadOverlayError(error.message || 'Something went wrong loading your plan.');
          }
        } else {
          appState.user = null;
          appState.progress = {};
          teardownListeners();
          hideLoadOverlay();
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

      document.getElementById('logoutBtn').addEventListener('click', () => {
        if (appState.guestMode) {
          exitGuestMode();
        } else {
          signOut(auth);
        }
      });

      document.getElementById('guestViewBtn').addEventListener('click', enterGuestMode);
      document.getElementById('guestSignUpBtn').addEventListener('click', () => {
        exitGuestMode();
        tabSignup.click();
      });
    }

    // ───────────────────────────
    // GUEST (READ-ONLY) MODE — lets a visitor browse the plan, calendar,
    // and reports without an account. Firestore rules already allow public
    // reads on tasks/events/settings, so this is mostly a UI concern: skip
    // Firebase Auth entirely, hide every edit surface (My Profile, Daily
    // Tracker — both require a signed-in uid to persist anything), and
    // relabel the checkboxes/logout button so it's obvious how to leave.
    // ───────────────────────────
    async function enterGuestMode() {
      appState.guestMode = true;
      appState.user = null;
      document.body.classList.add('guest-mode');
      document.getElementById('loginGate').style.display = 'none';
      document.getElementById('appContent').style.display = '';
      document.getElementById('guestBanner').style.display = 'flex';
      document.getElementById('logoutBtn').textContent = 'Sign Up / Log In';
      showLoadOverlay();

      try {
        await Promise.race([
          loadData(),
          new Promise((_, reject) => setTimeout(
            () => reject(new Error('This is taking too long — check your internet connection.')),
            12000
          ))
        ]);

        const ordered = [...appState.plan.categories].sort((a, b) => weekNumOf(a.name) - weekNumOf(b.name));
        const nextUp = ordered.find(cat => (cat.completed || 0) < 7);
        appState.currentWeek = nextUp ? weekNumOf(nextUp.name) : 1;

        render();
        hideLoadOverlay();
      } catch (error) {
        console.error('Error during guest-mode load:', error);
        showLoadOverlayError(error.message || 'Something went wrong loading the plan.');
      }
    }

    function exitGuestMode() {
      appState.guestMode = false;
      appState.progress = {};
      document.body.classList.remove('guest-mode');
      teardownListeners();
      hideLoadOverlay();
      document.getElementById('guestBanner').style.display = 'none';
      document.getElementById('logoutBtn').textContent = 'Logout';
      document.getElementById('loginGate').style.display = 'flex';
      document.getElementById('appContent').style.display = 'none';
      // Reset the view back to Tracker so a subsequent real login doesn't
      // land on whatever section the guest happened to be browsing.
      document.querySelectorAll('[data-view]').forEach(b => b.classList.remove('active'));
      document.querySelector('[data-view="tracker"]').classList.add('active');
      switchView('tracker');
    }

    function initApp() {
      // 90-day target = 90/7 ≈ 13 weeks. This is just the fallback shown
      // before any data has loaded (or before a settings/plan doc exists) —
      // loadData() recalculates the real totalDays from the saved start/end
      // dates the moment they're available.
      appState.plan.totalDays = 90;
    }

    function setupEventListeners() {
      document.getElementById('loadRetryBtn').addEventListener('click', () => location.reload());

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

      // Calendar month navigation
      document.getElementById('calPrevBtn').addEventListener('click', () => {
        calendarViewDate = new Date(calendarViewDate.getFullYear(), calendarViewDate.getMonth() - 1, 1);
        renderCalendar();
      });
      document.getElementById('calNextBtn').addEventListener('click', () => {
        calendarViewDate = new Date(calendarViewDate.getFullYear(), calendarViewDate.getMonth() + 1, 1);
        renderCalendar();
      });
      document.getElementById('calTodayBtn').addEventListener('click', () => {
        calendarViewDate = new Date();
        renderCalendar();
      });
      document.getElementById('calMonthPicker').addEventListener('change', (ev) => {
        const [y, m] = ev.target.value.split('-').map(Number);
        if (!y || !m) return;
        calendarViewDate = new Date(y, m - 1, 1);
        renderCalendar();
      });
      // The input already sits invisibly on top of the label and catches
      // the click directly in most browsers. showPicker() is a belt-and-
      // braces nudge for browsers/situations where that click doesn't
      // auto-open the native picker — harmless no-op where unsupported.
      document.getElementById('calMonthLabelBtn').addEventListener('click', () => {
        const picker = document.getElementById('calMonthPicker');
        if (picker && typeof picker.showPicker === 'function') {
          try { picker.showPicker(); } catch (e) { /* ignore — overlay click already handles it */ }
        }
      });

      // Profile sub-tabs (Account / Plan Duration / Tasks / Events / Data & Backup) —
      // one unified page instead of separate cards.
      document.querySelectorAll('.profile-tab').forEach(tab => {
        tab.addEventListener('click', () => {
          const target = tab.dataset.ptab;
          document.querySelectorAll('.profile-tab').forEach(t => t.classList.toggle('active', t === tab));
          document.querySelectorAll('.profile-panel').forEach(p => {
            p.style.display = p.dataset.ppanel === target ? '' : 'none';
          });
        });
      });

      // Data & Backup actions
      document.getElementById('exportJsonBtn').addEventListener('click', exportJSONBackup);
      document.getElementById('exportCsvBtn').addEventListener('click', exportTasksCSV);
      document.getElementById('resetAllBtn').addEventListener('click', resetAllData);

      // Daily Tracker actions
      document.getElementById('dtAddTaskBtn').addEventListener('click', dtAddOrUpdateTask);
      document.getElementById('dtCancelEditBtn').addEventListener('click', dtCancelEdit);
      document.getElementById('dtHideCompleted').addEventListener('change', renderDtTasks);
    }

    function switchView(view) {
      document.getElementById('trackerView').style.display = view === 'tracker' ? 'flex' : 'none';
      document.getElementById('calendarView').style.display = view === 'calendar' ? 'flex' : 'none';
      document.getElementById('profileView').style.display = view === 'profile' ? 'flex' : 'none';
      document.getElementById('reportsView').style.display = view === 'reports' ? 'flex' : 'none';
      document.getElementById('dailyTrackerView').style.display = view === 'dailytracker' ? 'flex' : 'none';
      if (view === 'dailytracker') renderDtTasks();
      if (view === 'profile') renderProfileView();
    }

    // ───────────────────────────
    // DATA MANAGEMENT
    // ───────────────────────────
    let unsubTasks = null, unsubEvents = null, unsubPlan = null;
    let latestTasks = [];

    function teardownListeners() {
      if (unsubTasks) { unsubTasks(); unsubTasks = null; }
      if (unsubEvents) { unsubEvents(); unsubEvents = null; }
      if (unsubPlan) { unsubPlan(); unsubPlan = null; }
      latestTasks = [];
    }

    // Merge: the shared task doc supplies name/category/days/desc; the
    // signed-in user's own progress doc supplies how many days *they*
    // completed. Re-run whenever either side changes.
    function applyCategoriesFromTasksAndProgress() {
      appState.plan.categories = latestTasks.map(t => ({
        ...t,
        completed: appState.progress[t.id] || 0
      }));
    }

    // Sets up live listeners on the shared tasks/events/plan-settings docs.
    // Any signed-in user can now edit these, so the whole app stays in sync
    // in real time — no more "reload the whole collection, then re-render"
    // round trip after every add/edit/delete. The returned Promise resolves
    // once the FIRST snapshot of everything has arrived (same "data is
    // ready" contract the old one-time-read loadData() had); every snapshot
    // after that just repaints in place.
    function loadData() {
      return new Promise((resolve) => {
        let tasksReady = false, eventsReady = false, planReady = false, progressReady = false;
        let settled = false;

        function maybeResolve() {
          if (settled || !(tasksReady && eventsReady && planReady && progressReady)) return;
          settled = true;
          resolve();
        }
        function repaintIfLive() {
          if (settled) render();
        }

        // Own progress — a one-time read is enough since only this user
        // ever changes their own progress subcollection.
        (appState.user
          ? getDocs(collection(db, "users", appState.user.uid, "progress"))
          : Promise.resolve({ docs: [] })
        ).then(progSnap => {
          appState.progress = {};
          progSnap.docs.forEach(d => { appState.progress[d.id] = d.data().completed || 0; });
          applyCategoriesFromTasksAndProgress();
          progressReady = true;
          maybeResolve();
        }).catch(error => {
          console.error("Error loading user progress:", error);
          progressReady = true;
          maybeResolve();
        });

        unsubTasks = onSnapshot(collection(db, "tasks"), snap => {
          latestTasks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
          applyCategoriesFromTasksAndProgress();
          tasksReady = true;
          maybeResolve();
          repaintIfLive();
        }, error => {
          console.error("Error loading tasks:", error);
          tasksReady = true;
          maybeResolve();
        });

        unsubEvents = onSnapshot(collection(db, "events"), snap => {
          appState.events = snap.docs.map(d => ({ id: d.id, ...d.data() }));
          eventsReady = true;
          maybeResolve();
          repaintIfLive();
        }, error => {
          console.error("Error loading events:", error);
          eventsReady = true;
          maybeResolve();
        });

        // Plan-wide start/end date, editable by any user from My Profile.
        // Falls back to the defaults set in initApp() if no settings doc
        // has been saved yet.
        unsubPlan = onSnapshot(doc(db, "settings", "plan"), snap => {
          if (snap.exists()) {
            const p = snap.data();
            if (p.startDate) appState.plan.startDate = new Date(p.startDate + 'T00:00:00');
            if (p.endDate) {
              appState.plan.endDate = p.endDate;
              const s = new Date(p.startDate + 'T00:00:00');
              const e = new Date(p.endDate + 'T00:00:00');
              appState.plan.totalDays = Math.max(1, Math.round((e - s) / 86400000) + 1);
            }
          }
          planReady = true;
          maybeResolve();
          repaintIfLive();
        }, error => {
          console.error("Error loading plan settings:", error);
          planReady = true;
          maybeResolve();
        });
      });
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

    function dateForWeekDay(weekNum, dayIndex) {
      const start = new Date(appState.plan.startDate);
      start.setHours(0, 0, 0, 0);
      return new Date(start.getTime() + ((weekNum - 1) * 7 + dayIndex) * 86400000);
    }

    function dayLabelFor(weekNum, dayIndex) {
      return dateForWeekDay(weekNum, dayIndex).toLocaleDateString('en-US', { weekday: 'short' });
    }

    function render() {
      updateTimelinePanel();
      renderCategoryProgress();
      renderWeeklySummary();
      renderDailyCompletionLog();
      renderWeekSelector();
      renderTasks();
      renderTodaysFocus();
      renderCalendar();
      renderUpcomingEvents();
      renderSidebarDtTasks();
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

    // Builds a day-by-day activity log: every checked-off task-day (derived
    // from each category's completed count + the real calendar date that
    // day-index maps to via the plan's start date) plus every event that
    // falls on that date, grouped and sorted newest-first. There's no
    // separate "completed at" timestamp stored per day — checking off day N
    // implies days 0..N-1 are done too (see toggleDay), so that's exactly
    // what gets expanded here.
    function buildDailyCompletionLog() {
      const map = new Map(); // "YYYY-MM-DD" -> { date, tasks: [], events: [] }

      function entryFor(dateObj) {
        const d = new Date(dateObj);
        d.setHours(0, 0, 0, 0);
        const key = d.toISOString().slice(0, 10);
        if (!map.has(key)) map.set(key, { date: d, key, tasks: [], events: [] });
        return map.get(key);
      }

      appState.plan.categories.forEach(cat => {
        const wk = weekNumOf(cat.name);
        const completed = Number(cat.completed) || 0;
        for (let i = 0; i < completed; i++) {
          entryFor(dateForWeekDay(wk, i)).tasks.push({
            category: cat.category,
            name: cat.name
          });
        }
      });

      appState.events.forEach(e => {
        const { start, end } = eventDateRange(e);
        if (!start) return;
        const s = new Date(start + 'T00:00:00');
        const en = new Date((end || start) + 'T00:00:00');
        for (let d = new Date(s); d <= en; d.setDate(d.getDate() + 1)) {
          entryFor(d).events.push({ title: e.title, type: e.type, time: e.time });
        }
      });

      return [...map.values()].sort((a, b) => b.date - a.date);
    }

    function renderDailyCompletionLog() {
      const container = document.getElementById('dailyCompletionLog');
      if (!container) return;

      const log = buildDailyCompletionLog();
      if (log.length === 0) {
        container.innerHTML = '<p class="daily-log-empty">Nothing completed yet — check off a day in the Tracker, or add an event, and it\'ll show up here.</p>';
        return;
      }

      const today = new Date(); today.setHours(0, 0, 0, 0);
      const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);

      container.innerHTML = log.map(entry => {
        const dateLabel = entry.date.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
        const tag = entry.date.getTime() === today.getTime()
          ? '<span class="daily-log-tag">Today</span>'
          : (entry.date.getTime() === yesterday.getTime() ? '<span class="daily-log-tag">Yesterday</span>' : '');

        const taskChips = entry.tasks.map(t => {
          const color = CATEGORY_COLORS[t.category] || 'var(--stone)';
          return `<span class="daily-log-chip" style="--chip-color:${color};">✓ ${escapeHTML(t.category)} · ${escapeHTML(t.name)}</span>`;
        }).join('');

        const eventChips = entry.events.map(e => {
          const timeLabel = e.time ? ` · ${formatTime(e.time)}` : '';
          return `<span class="daily-log-chip daily-log-chip-event">📌 ${escapeHTML(e.title)}${timeLabel}${e.type ? ` (${escapeHTML(e.type)})` : ''}</span>`;
        }).join('');

        return `
          <div class="daily-log-day fade-in">
            <div class="daily-log-date">${dateLabel}${tag}</div>
            <div class="daily-log-chips">${taskChips}${eventChips}</div>
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
        grid.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📋</div><p>No tasks for this week yet. Add tasks from My Profile.</p></div>';
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
              const { week: todayWeek, day: todayDayIndex } = getTodayPointer();
              const isToday = appState.currentWeek === todayWeek && i === todayDayIndex;
              return `
              <div class="day-check${i < completed ? ' done' : ''}${isToday ? ' today' : ''}" data-cat="${cat.id}" data-day="${i}" title="Day ${i + 1} (${dayNames[i]})${isToday ? ' — today' : ''}">
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
      if (appState.guestMode) {
        showToast('Sign up to save your progress — this view is read-only.', 'error');
        return;
      }
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
        showToast('Could not save that change — please check your connection and try again.', 'error');
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
        focusEl.innerHTML = '<div class="text-muted" style="font-size:0.9rem;">📋 No tasks assigned yet for this week. Check My Profile.</div>';
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
    // PROFILE VIEW — account settings + shared plan management + backup,
    // unified into one page. Every signed-in user gets the full page.
    // ───────────────────────────
    function renderProfileView() {
      if (!appState.user) return;

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
      const todayStr = new Date().toISOString().slice(0, 10);
      const orderedEvents = [...appState.events].sort((a, b) => new Date(eventDateRange(a).start) - new Date(eventDateRange(b).start));
      eventListEl.innerHTML = orderedEvents.length
        ? orderedEvents.map(e => {
            const { start, end } = eventDateRange(e);
            const dateLabel = !start ? '—' : (start === end
              ? new Date(start).toLocaleDateString('en-GB')
              : `${new Date(start).toLocaleDateString('en-GB')} – ${new Date(end).toLocaleDateString('en-GB')}`);
            const timeLabel = e.time ? ` · ${formatTime(e.time)}` : '';
            const isPast = (end || start) < todayStr;
            return `
              <div class="inline-list-row${isPast ? ' is-past-event' : ''}">
                <span><strong>${escapeHTML(e.title)}</strong> · ${dateLabel}${timeLabel} · ${escapeHTML(e.type || '')}${isPast ? ' <span class="past-tag">Past</span>' : ''}</span>
                <div class="row-actions">
                  <button class="btn btn-sm btn-secondary" onclick="editEventInline('${e.id}')">Edit</button>
                  <button class="btn btn-sm btn-danger" onclick="deleteEventInline('${e.id}')">Delete</button>
                </div>
              </div>
            `;
          }).join('')
        : '<div class="inline-list-row text-muted">No events yet.</div>';

      renderDataStats();
    }

    // Cheap summary stats for the Data & Backup tab — built entirely from
    // data already sitting in appState (no extra Firestore reads), so
    // opening this tab never costs a network round trip.
    function renderDataStats() {
      const statsEl = document.getElementById('dataStats');
      if (!statsEl) return;
      const totalTasks = appState.plan.categories.length;
      const totalEvents = appState.events.length;
      const numWeeks = Math.max(0, ...appState.plan.categories.map(c => weekNumOf(c.name)), 0);
      const numCats = new Set(appState.plan.categories.map(c => c.category)).size;

      const stats = [
        { label: 'Total Tasks', value: totalTasks },
        { label: 'Weeks Planned', value: numWeeks },
        { label: 'Categories', value: numCats },
        { label: 'Events', value: totalEvents }
      ];
      statsEl.innerHTML = stats.map(s => `
        <div class="stat-mini">
          <div class="stat-mini-value">${s.value}</div>
          <div class="stat-mini-label">${escapeHTML(s.label)}</div>
        </div>
      `).join('');
    }

    // ───────────────────────────
    // DATA & BACKUP — replaces the old standalone admin.html dashboard.
    // Export/CSV are built entirely from state already in memory (no extra
    // Firestore reads); reset is the only feature that talks to the network.
    // ───────────────────────────
    function downloadBlob(blob, filename) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    }

    function exportJSONBackup() {
      const data = {
        plan: {
          title: appState.plan.title,
          startDate: toISODate(appState.plan.startDate),
          totalDays: appState.plan.totalDays
        },
        // Shared task/event fields only — intentionally excludes each
        // student's personal completed-day counts, which live in their own
        // private progress subcollection and aren't part of "the plan".
        tasks: appState.plan.categories.map(({ completed, ...t }) => t),
        events: appState.events,
        exportedAt: new Date().toISOString()
      };
      downloadBlob(
        new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
        `study-plan-backup-${toISODate(new Date())}.json`
      );
      showToast('Backup downloaded.', 'success');
    }

    function exportTasksCSV() {
      const csvField = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      let csv = 'Week,Category,Target Days,Description\n';
      [...appState.plan.categories]
        .sort((a, b) => weekNumOf(a.name) - weekNumOf(b.name))
        .forEach(t => {
          csv += [csvField(t.name), csvField(t.category), Number(t.days) || 0, csvField(t.desc)].join(',') + '\n';
        });
      downloadBlob(
        new Blob([csv], { type: 'text/csv' }),
        `study-plan-tasks-${toISODate(new Date())}.csv`
      );
      showToast('CSV downloaded.', 'success');
    }

    async function resetAllData() {
      const msgEl = document.getElementById('pfDataMsg');
      const taskCount = appState.plan.categories.length;
      const eventCount = appState.events.length;

      if (!taskCount && !eventCount) {
        showToast('Nothing to reset — the plan is already empty.', 'error');
        return;
      }
      if (!confirm(`This will permanently delete all ${taskCount} task(s) and ${eventCount} event(s) for everyone. Export a backup first if you haven't. Continue?`)) return;
      if (prompt('Type DELETE (all caps) to confirm — this cannot be undone:') !== 'DELETE') {
        showToast('Reset cancelled — nothing was deleted.', 'error');
        return;
      }

      msgEl.textContent = 'Deleting…';
      try {
        const targets = [
          ...appState.plan.categories.map(t => ({ col: 'tasks', id: t.id })),
          ...appState.events.map(e => ({ col: 'events', id: e.id }))
        ];
        // Firestore batches cap at 500 writes — chunk defensively in case
        // the plan ever grows past that.
        for (let i = 0; i < targets.length; i += 400) {
          const batch = writeBatch(db);
          targets.slice(i, i + 400).forEach(({ col, id }) => batch.delete(doc(db, col, id)));
          await batch.commit();
        }
        msgEl.textContent = '';
        showToast('All tasks and events have been reset.', 'success');
      } catch (error) {
        msgEl.textContent = `Could not reset: ${error.code || error.message}`;
        showToast('Could not complete reset.', 'error');
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
      // If a user picks a start date that isn't a Sunday, roll it back to the
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
    // TASK ADD / EDIT / DELETE (any signed-in user)
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
    // switches the form into "update" mode, so a user can change a
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

      const wasEditing = !!editingTaskId;
      try {
        if (editingTaskId) {
          await updateDoc(doc(db, "tasks", editingTaskId), { name, category, days, desc });
        } else {
          await addDoc(collection(db, "tasks"), { name, category, days, desc, completed: 0, createdAt: new Date() });
        }
        // No manual reload needed — the live tasks listener (see loadData())
        // picks this up and repaints automatically, including for everyone
        // else currently viewing the plan.
        resetTaskForm();
        showToast(wasEditing ? 'Task updated.' : 'Task added.', 'success');
      } catch (error) {
        msgEl.textContent = `Could not save task: ${error.code || error.message}`;
        showToast('Could not save task.', 'error');
      }
    }

    window.deleteTaskInline = async function(taskId) {
      if (!confirm('Delete this task? This cannot be undone.')) return;
      try {
        await deleteDoc(doc(db, "tasks", taskId));
        if (editingTaskId === taskId) resetTaskForm();
        showToast('Task deleted.', 'success');
      } catch (error) {
        showToast(`Could not delete task: ${error.code || error.message}`, 'error');
      }
    }

    // ───────────────────────────
    // EVENT ADD / EDIT / DELETE (any signed-in user)
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
      document.getElementById('pfEventTime').value = '';
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
      document.getElementById('pfEventTime').value = e.time || '';
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
      const time = document.getElementById('pfEventTime').value; // optional, "" if not set
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

      const wasEditing = !!editingEventId;
      try {
        if (editingEventId) {
          await updateDoc(doc(db, "events", editingEventId), { title, startDate, endDate, time, type });
        } else {
          await addDoc(collection(db, "events"), { title, startDate, endDate, time, type });
        }
        // The live events listener repaints the calendar/upcoming lists —
        // no manual reload needed.
        resetEventForm();
        showToast(wasEditing ? 'Event updated.' : 'Event added.', 'success');
      } catch (error) {
        msgEl.textContent = `Could not save event: ${error.code || error.message}`;
        showToast('Could not save event.', 'error');
      }
    }

    window.deleteEventInline = async function(eventId) {
      if (!confirm('Delete this event?')) return;
      try {
        await deleteDoc(doc(db, "events", eventId));
        if (editingEventId === eventId) resetEventForm();
        showToast('Event deleted.', 'success');
      } catch (error) {
        showToast(`Could not delete event: ${error.code || error.message}`, 'error');
      }
    }

    // Tracks which month the user has navigated to — starts on the real
    // current month, but Prev/Next/Today can move it independently so
    // browsing the calendar doesn't depend on today's date.
    let calendarViewDate = new Date();

    function renderCalendar() {
      const grid = document.getElementById('calendarGrid');
      const monthLabel = document.getElementById('calendarMonth');

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const year = calendarViewDate.getFullYear();
      const month = calendarViewDate.getMonth();

      monthLabel.textContent = new Date(year, month).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

      // Keep the invisible <input type="month"> in sync so it always opens
      // pre-set to the month currently on screen.
      const picker = document.getElementById('calMonthPicker');
      if (picker) picker.value = `${year}-${String(month + 1).padStart(2, '0')}`;

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
        const isPast = date < today && !isToday;

        const dayEvents = appState.events.filter(e => {
          const { start, end } = eventDateRange(e);
          if (!start) return false;
          const s = new Date(start); s.setHours(0, 0, 0, 0);
          const en = new Date(end || start); en.setHours(0, 0, 0, 0);
          return date >= s && date <= en;
        });
        const isExamDay = dayEvents.some(e => e.type === 'Exam');
        const hasEvent = dayEvents.length > 0;

        if (isToday) cell.classList.add('today');
        if (isPast) cell.classList.add('past');
        if (isExamDay) cell.classList.add('exam-day');
        if (hasEvent) cell.classList.add('has-event');
        if (hasEvent) {
          cell.title = dayEvents.map(e => `${e.title}${e.time ? ' · ' + formatTime(e.time) : ''} (${e.type || 'Event'})`).join('\n');
        }

        grid.appendChild(cell);
      }
    }

    // "14:30" -> "2:30 PM". Falls back to the raw value if it doesn't
    // parse, so nothing crashes on odd/legacy data.
    function formatTime(t) {
      if (!t) return '';
      const m = String(t).match(/^(\d{1,2}):(\d{2})/);
      if (!m) return t;
      let h = parseInt(m[1], 10);
      const min = m[2];
      const suffix = h >= 12 ? 'PM' : 'AM';
      h = h % 12 || 12;
      return `${h}:${min} ${suffix}`;
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
        const dateLabelFor = ({ start, end, e }) => {
          const dateStr = start === end
            ? new Date(start).toLocaleDateString('en-GB')
            : `${new Date(start).toLocaleDateString('en-GB')} – ${new Date(end).toLocaleDateString('en-GB')}`;
          return e.time ? `${dateStr} · ${formatTime(e.time)}` : dateStr;
        };

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
    // DAILY TRACKER — a private, per-account everyday to-do list.
    // Add anything at any time, with an optional priority, due date,
    // and time. Priority IS the list's order (1 = top); the ▲▼
    // buttons re-rank a task by moving it and renumbering everyone
    // else to match. Stored as a single array on dailyTrackers/{uid}
    // (same doc/rules the old tracker used) — small enough that
    // reading/writing the whole list on each change is simple and
    // plenty fast.
    // ═══════════════════════════════════════════════════════════
    let dtUid = null;
    let dtTasks = [];      // [{ id, title, priority, dueDate, time, completed, createdAt }]
    let dtEditingId = null;

    function dtReset() {
      dtUid = null;
      dtTasks = [];
      dtEditingId = null;
      renderSidebarDtTasks();
    }

    async function dtInit(uid) {
      dtUid = uid;
      try {
        const snap = await getDoc(doc(db, 'dailyTrackers', uid));
        const data = snap.exists() ? snap.data() : null;
        dtTasks = (data && Array.isArray(data.tasks)) ? data.tasks : [];
      } catch (e) {
        console.error('Error loading Daily Tracker:', e);
        dtTasks = [];
      }
      dtRenumber();
      renderSidebarDtTasks();
      // If the user is already sitting on the Daily Tracker tab (fast tab
      // switch right after login), paint immediately instead of waiting
      // for the next manual navigation.
      if (document.getElementById('dailyTrackerView').style.display !== 'none') {
        renderDtTasks();
      }
    }

    async function dtSave() {
      if (!dtUid) return;
      try {
        await setDoc(doc(db, 'dailyTrackers', dtUid), { tasks: dtTasks, updatedAt: new Date() });
      } catch (e) {
        console.error('Error saving Daily Tracker:', e);
        showToast('Could not save — please check your connection.', 'error');
      }
    }

    // Keeps priority numbers a clean, gapless 1..N matching the array's
    // actual order. The array position IS the source of truth for order;
    // "priority" is just that position shown as a friendly number.
    function dtRenumber() {
      dtTasks.forEach((t, i) => { t.priority = i + 1; });
    }

    function dtGenId() {
      return 'dt' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    }

    window.dtEditTask = function(id) {
      const t = dtTasks.find(x => x.id === id);
      if (!t) return;
      document.getElementById('dtTaskTitle').value = t.title || '';
      document.getElementById('dtTaskPriority').value = t.priority || '';
      document.getElementById('dtTaskDueDate').value = t.dueDate || '';
      document.getElementById('dtTaskTime').value = t.time || '';
      dtEditingId = id;
      document.getElementById('dtAddTaskBtn').textContent = 'Update Task';
      document.getElementById('dtCancelEditBtn').style.display = '';
      document.getElementById('dtTaskMsg').textContent = '';
      document.getElementById('dtTaskTitle').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    function dtCancelEdit() {
      dtEditingId = null;
      document.getElementById('dtTaskTitle').value = '';
      document.getElementById('dtTaskPriority').value = '';
      document.getElementById('dtTaskDueDate').value = '';
      document.getElementById('dtTaskTime').value = '';
      document.getElementById('dtAddTaskBtn').textContent = '+ Add Task';
      document.getElementById('dtCancelEditBtn').style.display = 'none';
      document.getElementById('dtTaskMsg').textContent = '';
    }

    async function dtAddOrUpdateTask() {
      const msgEl = document.getElementById('dtTaskMsg');
      const title = document.getElementById('dtTaskTitle').value.trim();
      const priorityRaw = document.getElementById('dtTaskPriority').value;
      const dueDate = document.getElementById('dtTaskDueDate').value;
      const time = document.getElementById('dtTaskTime').value;
      msgEl.textContent = '';

      if (!title) {
        msgEl.textContent = 'Enter what you need to do.';
        return;
      }

      if (dtEditingId) {
        const t = dtTasks.find(x => x.id === dtEditingId);
        if (t) {
          t.title = title;
          t.dueDate = dueDate || '';
          t.time = time || '';
          // Re-rank only if a valid new priority number was actually typed
          const parsed = priorityRaw ? parseInt(priorityRaw, 10) : NaN;
          if (!Number.isNaN(parsed)) {
            const wantIdx = Math.min(Math.max(parsed, 1), dtTasks.length) - 1;
            dtTasks = dtTasks.filter(x => x.id !== dtEditingId);
            dtTasks.splice(wantIdx, 0, t);
          }
        }
        dtRenumber();
        await dtSave();
        dtCancelEdit();
        renderDtTasks();
        showToast('Task updated.', 'success');
        return;
      }

      const newTask = {
        id: dtGenId(),
        title,
        dueDate: dueDate || '',
        time: time || '',
        completed: false,
        createdAt: new Date().toISOString()
      };

      const parsed = priorityRaw ? parseInt(priorityRaw, 10) : NaN;
      const insertAt = Number.isNaN(parsed)
        ? dtTasks.length
        : Math.min(Math.max(parsed, 1), dtTasks.length + 1) - 1;
      dtTasks.splice(insertAt, 0, newTask);
      dtRenumber();

      await dtSave();
      dtCancelEdit();
      renderDtTasks();
      showToast('Task added.', 'success');
    }

    window.dtToggleComplete = async function(id) {
      const t = dtTasks.find(x => x.id === id);
      if (!t) return;
      t.completed = !t.completed;
      renderDtTasks();
      await dtSave();
    }

    window.dtMoveTask = async function(id, dir) {
      const idx = dtTasks.findIndex(x => x.id === id);
      if (idx === -1) return;
      const newIdx = idx + dir;
      if (newIdx < 0 || newIdx >= dtTasks.length) return;
      const [item] = dtTasks.splice(idx, 1);
      dtTasks.splice(newIdx, 0, item);
      dtRenumber();
      renderDtTasks();
      await dtSave();
    }

    window.dtDeleteTask = async function(id) {
      if (!confirm('Delete this task?')) return;
      dtTasks = dtTasks.filter(x => x.id !== id);
      dtRenumber();
      if (dtEditingId === id) dtCancelEdit();
      renderDtTasks();
      await dtSave();
      showToast('Task deleted.', 'success');
    }

    function renderDtTasks() {
      const listEl = document.getElementById('dtTaskList');
      renderSidebarDtTasks();
      if (!listEl) return;

      const hideCompleted = document.getElementById('dtHideCompleted')?.checked;
      const tasks = hideCompleted ? dtTasks.filter(t => !t.completed) : dtTasks;

      if (dtTasks.length === 0) {
        listEl.innerHTML = '<div class="dt-empty-state">No tasks yet — add your first one above.</div>';
        return;
      }
      if (tasks.length === 0) {
        listEl.innerHTML = '<div class="dt-empty-state">Everything\u2019s checked off. \ud83c\udf89</div>';
        return;
      }

      const todayStr = new Date().toISOString().slice(0, 10);

      listEl.innerHTML = tasks.map(t => {
        const realIdx = dtTasks.findIndex(x => x.id === t.id);
        const isFirst = realIdx === 0;
        const isLast = realIdx === dtTasks.length - 1;
        const isOverdue = !t.completed && t.dueDate && t.dueDate < todayStr;
        const isToday = t.dueDate === todayStr;

        let dueBadge = '';
        if (t.dueDate) {
          const dateLabel = new Date(t.dueDate + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
          const timeLabel = t.time ? ` · ${formatTime(t.time)}` : '';
          const badgeClass = isOverdue ? 'dt-due-badge overdue' : (isToday ? 'dt-due-badge today' : 'dt-due-badge');
          const tag = isOverdue ? ' (overdue)' : (isToday ? ' (today)' : '');
          dueBadge = `<span class="${badgeClass}">\ud83d\udcc5 ${dateLabel}${timeLabel}${tag}</span>`;
        } else if (t.time) {
          dueBadge = `<span class="dt-due-badge">\ud83d\udd50 ${formatTime(t.time)}</span>`;
        }

        return `
          <div class="dt-task-row${t.completed ? ' completed' : ''}${isOverdue ? ' overdue' : ''}">
            <div class="dt-task-order">
              <button class="dt-move-btn" ${isFirst ? 'disabled' : ''} onclick="dtMoveTask('${t.id}', -1)" title="Move up — higher priority">▲</button>
              <span class="dt-priority-badge" title="Priority">${t.priority}</span>
              <button class="dt-move-btn" ${isLast ? 'disabled' : ''} onclick="dtMoveTask('${t.id}', 1)" title="Move down — lower priority">▼</button>
            </div>
            <label class="dt-task-check">
              <input type="checkbox" ${t.completed ? 'checked' : ''} onchange="dtToggleComplete('${t.id}')">
            </label>
            <div class="dt-task-body">
              <div class="dt-task-title">${escapeHTML(t.title)}</div>
              ${dueBadge ? `<div class="dt-task-meta">${dueBadge}</div>` : ''}
            </div>
            <div class="row-actions">
              <button class="btn btn-sm btn-secondary" onclick="dtEditTask('${t.id}')">Edit</button>
              <button class="btn btn-sm btn-danger" onclick="dtDeleteTask('${t.id}')">Delete</button>
            </div>
          </div>
        `;
      }).join('');
    }

    // Compact mirror of the Daily Tracker list, shown in the sidebar under
    // "Upcoming in Next 7 Days" so tasks are visible no matter which view
    // is open. Same priority order as the main list; checking a box here
    // calls the exact same dtToggleComplete() used on the Daily Tracker
    // page, so both stay in sync automatically.
    function renderSidebarDtTasks() {
      const container = document.getElementById('sidebarDtTasks');
      if (!container) return;

      if (!appState.user || appState.guestMode) {
        container.innerHTML = '<div class="text-muted text-sm">Log in to track daily tasks</div>';
        return;
      }
      if (dtTasks.length === 0) {
        container.innerHTML = '<div class="text-muted text-sm">No tasks yet — add one in Daily Tracker</div>';
        return;
      }

      const todayStr = new Date().toISOString().slice(0, 10);

      container.innerHTML = dtTasks.map(t => {
        const isOverdue = !t.completed && t.dueDate && t.dueDate < todayStr;
        let dueLabel = '';
        if (t.dueDate) {
          const dateLabel = new Date(t.dueDate + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
          const timeLabel = t.time ? ` · ${formatTime(t.time)}` : '';
          dueLabel = `<div class="sidebar-task-due${isOverdue ? ' overdue' : ''}">📅 ${dateLabel}${timeLabel}${isOverdue ? ' · overdue' : ''}</div>`;
        } else if (t.time) {
          dueLabel = `<div class="sidebar-task-due">🕐 ${formatTime(t.time)}</div>`;
        }
        return `
          <div class="sidebar-task-row${t.completed ? ' completed' : ''}">
            <input type="checkbox" ${t.completed ? 'checked' : ''} onchange="dtToggleComplete('${t.id}')">
            <div>
              <div class="sidebar-task-title">${escapeHTML(t.title)}</div>
              ${dueLabel}
            </div>
          </div>
        `;
      }).join('');
    }
