# Study Planner — Agriculture Students

A shared 90-day study-plan tracker with per-user checkbox progress, backed by Firebase (Auth +
Firestore). Every registered user can manage the shared plan (tasks, events, dates) from their
own **My Profile** page — there is no separate admin account or dashboard.

## Structure

```
study-planner/
├── .firebaserc          # Firebase project alias (set your own project ID)
├── .gitignore
├── README.md
├── firebase.json        # Firebase Hosting + Firestore config
├── firestore.rules      # Firestore security rules
├── index.html           # The entire app: login, tracker, calendar, profile (incl. plan
│                         #   management + data/backup), reports, daily tracker
├── css/
│   └── style.css        # All styles
└── js/
    └── script.js        # All app logic (Firebase init, rendering, event handlers)
```

## Setup

1. Create a Firebase project and enable **Authentication** (Email/Password) and **Firestore**.
2. Replace `YOUR_FIREBASE_PROJECT_ID` in `.firebaserc` with your actual project ID.
3. Confirm the `firebaseConfig` object inside `js/script.js` matches your project's config.
4. Deploy:
   ```bash
   npm install -g firebase-tools   # if not already installed
   firebase login
   firebase deploy
   ```

## Note on shared write access

Any signed-up user can add/edit/delete tasks and events and change the plan's start/end dates —
this is intentional, so the group can self-manage without a gatekeeper, but it does mean one
person's mistake affects everyone's view. Each user's own daily checkbox progress and Daily
Tracker stay private to them (enforced by `firestore.rules`, not just the UI). The **Data &
Backup** tab on the Profile page lets anyone export a JSON/CSV backup of the shared plan, or
reset it, so mistakes are recoverable.

## Notes

- This is a static site — no build step, no bundler. `js/script.js` uses native ES module
  `import`s pulling the Firebase SDK from Google's CDN, so it **must be served over http/https**
  (Firebase Hosting, GitHub Pages, etc.) — opening `index.html` directly via `file://` will not
  work due to CORS restrictions on module scripts.
- Keep `css/style.css` and `js/script.js` alongside `index.html`'s folder structure exactly as
  shown — the `<link>`/`<script src>` paths are relative.
