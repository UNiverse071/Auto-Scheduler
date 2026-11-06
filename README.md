# Smart Scheduler

Give it tasks, how important they are and when they're due; it splits them into work sessions inside your
working hours, keeps your days off free, and re-plans when you report that a session did or didn't get done.
Each person has their own account. There is a website and a Chrome extension.

```bash
npm start                  # website + accounts server at http://localhost:5173
npm test                   # 100 tests (Node's built-in runner, no dependencies)
npm run build:extension    # builds the Chrome extension into dist/extension
```

## Chrome extension

1. `npm start` (the extension talks to the same server as the website).
2. `npm run build:extension`.
3. Chrome -> `chrome://extensions` -> turn on **Developer mode** -> **Load unpacked** -> pick `dist/extension`.
4. Click the toolbar icon, create an account (or sign in) with the same username as on the website.

The popup shows today's sessions with Done / Partly / Couldn't buttons and a quick "add task" form; "Open full
planner" opens everything in a tab. In the background it notifies you when a session starts and when one has
ended without a report, and the icon's badge counts the sessions waiting for a report.
To use a server that isn't on localhost, type its address on the sign-in screen; Chrome will ask permission.

## Planning

- **Importance (1-5) and deadline** per task. *Planning style* controls what comes first: a slider from
  "deadlines" to "importance" (presets: Balanced, Deadline-driven, Importance first, Finish early),
  "always do work due today first", and whether work is spread evenly until the deadline or done as early as possible.
- **Days off**: single dates or ranges. Nothing is planned on them, and deadline tasks are re-spread over the
  remaining days. Weekly work days and hours are in *Working hours & session sizes*.
- **Reporting**: say how many minutes of work you finished and how long you spent. Unfinished work is carried
  forward; slow pace, tight deadlines and repeated misses produce suggestions.
- **Calendar**: "Export to calendar (.ics)" for Google/Outlook/Apple. Live two-way sync would need an OAuth app
  with the calendar provider, which is not included.

## Accounts and where data lives

`server/app.js` is a dependency-free Node server: scrypt-hashed passwords, 256-bit session tokens (only their
hashes are stored), lock-out after 8 wrong passwords, per-user data files in `data/` (git-ignored), CORS only for
localhost and `chrome-extension://`, and a strict Content-Security-Policy. Each device keeps a cached copy so it
works offline and syncs when the server is reachable; if two devices edit at once the server's copy wins.
`npm start` binds to this computer only. To share it, set `HOST=0.0.0.0` **and put it behind HTTPS**
(passwords and tokens travel over the connection). `PORT` and `DATA_DIR` are also configurable.

## Code map

- `public/scheduler.js` - the planning engine: pure functions `(state, input, now) -> new state`.
- `public/app.js`, `index.html`, `styles.css` - the UI, shared by the website and the extension.
- `public/api.js`, `platform.js`, `reminders.js` - server client, web/extension differences, notification logic.
- `server/app.js`, `server.js` - accounts API and static hosting.
- `extension/`, `scripts/build-extension.js` - manifest, background worker, build (copies the shared files).
- `test/` - written before the code; each feature has its tests first.
