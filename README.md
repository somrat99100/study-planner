# Study Planner — Agriculture Students

A shared study-plan tracker with per-user checkbox progress, backed by Firebase (Auth + Firestore).

## Structure

```
study-planner/
├── .firebaserc          # Firebase project alias (set your own project ID)
├── .gitignore
├── README.md
├── firebase.json        # Firebase Hosting + Firestore config
├── firestore.rules      # Firestore security rules
├── index.html           # Main app: login, tracker, calendar, profile, reports, daily tracker
├── admin.html           # Admin-only dashboard: export/backup, reset, cross-user analytics
├── bulk-import.html     # Admin-only: bulk CSV task import
├── css/
│   └── style.css        # All styles for index.html
└── js/
    └── script.js        # All app logic for index.html (Firebase init, rendering, event handlers)
```

`admin.html` and `bulk-import.html` are self-contained (styles/scripts inlined) — they're standalone
admin tools, not part of the main user-facing app, so they aren't split into `css/`/`js/`.

## Setup

1. Create a Firebase project and enable **Authentication** (Email/Password) and **Firestore**.
2. Replace `YOUR_FIREBASE_PROJECT_ID` in `.firebaserc` with your actual project ID.
3. Confirm the Firebase config object inside `js/script.js` (and inside `admin.html` /
   `bulk-import.html`) matches your project's config.
4. Set `ADMIN_EMAIL` consistently in `js/script.js`, `admin.html`, and `bulk-import.html` — this
   must exactly match the value in `firestore.rules`'s `isAdmin()` check, or admin writes will be
   silently rejected by Firestore even though the UI shows admin controls.
5. Deploy:
   ```bash
   npm install -g firebase-tools   # if not already installed
   firebase login
   firebase deploy
   ```

## Notes

- This is a static site — no build step, no bundler. `js/script.js` uses native ES module
  `import`s pulling the Firebase SDK from Google's CDN, so it **must be served over http/https**
  (Firebase Hosting, GitHub Pages, etc.) — opening `index.html` directly via `file://` will not
  work due to CORS restrictions on module scripts.
- Keep `css/style.css` and `js/script.js` alongside `index.html`'s folder structure exactly as
  shown — the `<link>`/`<script src>` paths are relative.
