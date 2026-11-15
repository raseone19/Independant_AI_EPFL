# Sit-to-stand check (MVP 0.2)

A phone web app for older adults and Spitex visits. The phone camera and an on-device pose model (MediaPipe Pose Landmarker) watch the person; simple rules count and time the movements. No video is recorded or sent.

Two pages:

- **`index.html`, the simple screen for user tests.** One exercise, the 30-second chair stand. Spoken guidance in French, German, Italian, English or Spanish, a hands-free start once the person is seated and fully in view, a big counter that also counts out loud, then the result and the next exercise. Hidden team notes log each session for the test.
- **`nurse.html`, the full nurse version.** Timed Up and Go, 30-second chair stand and 4-stage balance, a report with CDC references and the trend against the last visit, proposed exercise levels and a session JSON.

## Live app

**https://raseone19.github.io/Independant_AI_EPFL/** (the nurse version is at `/nurse.html`)

The camera needs HTTPS, which GitHub Pages provides. To turn Pages on once: make the repo public (or use GitHub Pro), then **Settings > Pages**, Source "Deploy from a branch", branch `main`, folder `/ (root)`, Save. Every push to `main` updates the live app.

## Running a user test with the simple screen

1. Open the link on the phone and tap the person's language.
2. Open **For the team** and set the age band and sex. They are only used for the suggested exercise and never shown to the person.
3. Give the phone to the person and ask them to place it so it sees them. This is the setup task: note whether they need help.
4. They tap **Start** and sit down. The app says what to do, starts by itself, counts out loud for 30 s and shows the result.
5. Count the stands by hand at the same time. On the result screen open **Team notes**: enter your count, tick "Needed help to place the phone" if so, add notes, **Save**.
6. After the last person: **For the team > Export results (CSV)**. Each phone keeps its own sessions.

Safety: a sturdy chair against a wall, someone always next to the person, and only the chair stand.

## How the simple screen decides

- **Start:** whole body in view and seated (knee angle under 115°) for 1.5 s, then "3, 2, 1, go".
- **Count:** one stand each time the knee straightens past 160°. At 30 s, a stand that is more than halfway up counts (CDC rule).
- **No guessing:** if fewer than 80% of the frames were usable, it shows "?" and asks to try again.
- **Next exercise** (3 times a week, from the Otago programme): 0 stands → stand up with both hands, 5 times; below the CDC reference for age and sex → with one hand, 5 times; at or above it → without hands, 10 times.
- **Arms:** if the wrists leave the chest, the result adds a tip to keep the arms crossed.

## Working on it as a team

1. `git clone https://github.com/raseone19/Independant_AI_EPFL.git`
2. Make a branch per change, push it, open a pull request.
3. `npm test` must pass before merging (Node 20+). Changing a threshold? Say which clips you replayed and what changed.
4. **Never commit videos of people.** `recordings/`, `*.mp4` and `*.mov` are git-ignored: keep test clips on your own drive.

## Run it locally

```bash
python3 -m http.server 8000      # then open http://localhost:8000 on the same computer
npm test                         # unit tests
```

Double-clicking the HTML file does not work: the browser blocks the code from loading as a plain file. `localhost` counts as secure, so the laptop webcam works.

## Files

| File | What it is |
| --- | --- |
| `index.html` | Simple screen for user tests (chair stand only) |
| `nurse.html` | Full nurse version: camera or video file, 3 tests, report, levels, JSON export |
| `logic.js` | The rules, shared by both pages: features, 1€ filter, framing check, the three test state machines, CDC references, level proposals |
| `test/logic.test.mjs` | 21 unit tests on synthetic movements |
| `tools/e2e_simple.py`, `tools/e2e_fake_camera.py` | Headless Chrome runs of each page with a recorded clip as the camera |
| `samples/last_visit_example.json` | Made-up previous session for the nurse version |

## Tuning

Every threshold is in `CONFIG` at the top of `logic.js`:

| Setting | Default | Meaning |
| --- | --- | --- |
| `chairStand.standAboveDeg` / `sitBelowDeg` | 160° / 115° | Knee angle that counts as standing / seated |
| `chairStand.armsAwayRatio` | 0.9 | Wrist distance from the chest, as a share of torso length, that flags the arms |
| `balance.moveRatio` / `moveMinMs` | 0.08 / 250 ms | Foot displacement (share of leg length) and how long it must last to end a balance stage |
| `tug.walkMinRatio` / `seatedHoldMs` | 0.8 / 300 ms | Sideways hip travel needed, and seated time needed, before the TUG timer stops |
| `quality.minGoodFrameRatio` | 0.8 | Below this share of usable frames, no number is shown |

## What the page loads

The MediaPipe library and WASM come from jsDelivr and the pose model from Google's model storage (`@mediapipe/tasks-vision` 1.2.3, Apache-2.0). To serve them from this repo instead, copy `vision_bundle.mjs`, `wasm/` and the `.task` model into the folder and open the page with `?lib=./vision_bundle.mjs&wasm=./wasm&model=./pose_landmarker_lite.task`. Only relative paths are accepted.

## Known limits

- Thresholds are first guesses: they pass the synthetic tests and ran cleanly on real clips, but have not been checked against hand counts with older adults yet. That is what the team notes are for.
- One person in view. With two people the model follows the clearest one.
- The simple screen uses the front camera so the person sees the counter. A view from a little to the side shows the knees best; straight from the front, the count may be less reliable.
- Spoken guidance uses the phone's built-in voices, so quality varies.
- Not a medical device: it documents exercise performance and does not assess fall risk.
