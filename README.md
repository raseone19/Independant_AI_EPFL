# Strength & Balance Check (MVP 0.1)

A web app that a Spitex nurse opens on a phone during a home visit. The phone films the client, an on-device pose model (MediaPipe Pose Landmarker) finds 33 body points per frame, and simple rules turn them into the three CDC STEADI tests:

- **Timed Up and Go**: time from "Go" to seated again (StoppSturz cut-off 13.5 s)
- **30-second chair stand**: full stands in 30 s, with the CDC reference for age and sex
- **4-stage balance**: seconds held per stage until a foot moves

It then shows a one-page report, proposes the next exercise level (Otago-style ladders, one step per visit, the nurse confirms) and exports a session JSON. No video leaves the phone.

## Try it on a phone

Open **https://raseone19.github.io/Independant_AI_EPFL/** on the phone and allow the camera.

The camera only works over HTTPS, which GitHub Pages provides. If the link does not load yet, turn Pages on once: **Settings > Pages**, Source "Deploy from a branch", branch `main`, folder `/ (root)`, Save, then wait about a minute. Every push to `main` updates the live app.

Phone setup: landscape, on a tripod at hip height, 3.5 to 4 m away, side-on to a 3 m walkway with the chair at one end, back camera, one person in view.

## Working on it as a team

1. `git clone https://github.com/raseone19/Independant_AI_EPFL.git`
2. Make a branch per change (`git checkout -b chair-stand-thresholds`), push it, open a pull request.
3. `npm test` must pass before merging. Changing a threshold? Say which clips you replayed and what changed.
4. **Never commit videos of people.** This repo is public. `recordings/`, `*.mp4` and `*.mov` are git-ignored: keep test clips on your own drive.

## A session, step by step

1. **Setup**: client code, age band, sex, voice language (FR/DE/EN), camera. Tap **Start camera**.
2. Wait for the green "Full body in view" chip.
3. **Tests**: pick one, tap **Start**. Chair stand and TUG read the instructions aloud and count down "3, 2, 1, Go". Balance: show the position, tap Start when the client is steady.
4. **Report**: results, CDC reference, flags, trend against the last visit, proposed levels. Tick "Arms were used" if needed (CDC scores 0). Change a level if you disagree.
5. **Download JSON** (or Copy). Next visit: load that file as "Last visit" to get the trend and the level changes. Try it with `samples/last_visit_example.json`.

**Use a video file** runs the same pipeline on a recorded clip: pause or drag to the start of a test, then tap Start. The timer uses the clip's own timeline, so results are exact even on a slow laptop. This is how you test and tune without a person in front of the camera.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The whole app: UI, camera or video input, MediaPipe, skeleton overlay, test flows, report, export |
| `logic.js` | The test rules, no DOM and no MediaPipe: features, 1€ filter, framing check, the three test state machines, CDC references, level proposals, report rows |
| `test/logic.test.mjs` | 21 unit tests on synthetic movements (`npm test`, Node 20+) |
| `tools/e2e_fake_camera.py` | Clicks through the app in headless Chrome with a clip as fake camera |
| `samples/last_visit_example.json` | Made-up previous session for demos |

## Tuning

Every threshold is in `CONFIG` at the top of `logic.js`:

| Setting | Default | Meaning |
| --- | --- | --- |
| `chairStand.standAboveDeg` / `sitBelowDeg` | 160° / 115° | Knee angle that counts as standing / seated |
| `chairStand.armsAwayRatio` | 0.9 | Wrist distance from the chest, as a share of torso length, that flags "arms used" |
| `balance.moveRatio` / `moveMinMs` | 0.08 / 250 ms | Foot displacement (share of leg length) and how long it must last to end a stage |
| `balance.touchdownRatio` | 0.04 | One-leg stage: lifted ankle this close to the standing ankle counts as touchdown |
| `tug.walkMinRatio` / `seatedHoldMs` | 0.8 / 300 ms | Sideways hip travel needed, and seated time needed, before the timer stops |
| `quality.minGoodFrameRatio` | 0.8 | Below this share of usable frames the report says "not measured" |

Change a value, run `npm test`, then replay your recorded clips in video-file mode and compare with a stopwatch and a manual count.

## Run it locally

```bash
python3 -m http.server 8000      # then open http://localhost:8000 on the same computer
npm test                         # unit tests
```

`localhost` counts as secure, so the laptop webcam works. Phones need the HTTPS URL above.

## What the page loads

- MediaPipe library and WASM from jsDelivr, the pose model from Google's model storage (`@mediapipe/tasks-vision` 1.2.3, Apache-2.0).
- To self-host them (offline demo, or no third-party requests), copy `vision_bundle.mjs` and `wasm/` from the npm package and the `.task` model into the folder, then open `index.html?lib=./vision_bundle.mjs&wasm=./wasm&model=./pose_landmarker_lite.task`. Only relative paths are accepted.

## Known limits

- Thresholds are first guesses: they pass the synthetic tests and ran cleanly on a real test clip, but were not yet checked against stopwatch counts with older adults.
- One person in view. With two people the model follows the clearest one.
- Balance checks that the feet do not move, not that the client is in the right position: the nurse checks the position.
- TUG needs the whole 3 m walkway in view. If the client walks out of frame, use "Seated: stop the timer".
- Spoken instructions use the phone's built-in voices, so quality varies.
- Not a medical device: it documents exercise performance, it does not assess fall risk. The nurse interprets.

## Checked so far

- 21 unit tests pass (counting with noise, the CDC halfway rule, arms flag, foot movement and touchdown, TUG stop without false stops during walking, references, levels, report rows).
- Headless Chrome with a real clip as fake camera: model loads, about 25 fps with 40 ms inference on a laptop CPU, all three test flows, report and JSON export, video-file mode, no page errors. Phone speed is still to be measured (week 1 gate: 15 fps or more).
