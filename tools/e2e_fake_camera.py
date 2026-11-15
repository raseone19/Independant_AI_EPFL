"""End-to-end check of the web app in headless Chrome, with a video file as the fake camera.

What it does
  1. Serves the app plus local copies of the MediaPipe library, WASM and model.
  2. Starts Chrome with a fake camera that plays your clip (.y4m, made with ffmpeg).
  3. Clicks through: start camera, 30 s chair stand, TUG (stopped by hand),
     one balance stage, then the video-file mode. Saves screenshots and a JSON summary.

Setup (once)
  pip install playwright
  npm pack @mediapipe/tasks-vision@1.2.3 && tar -xzf mediapipe-tasks-vision-1.2.3.tgz
  # the model: https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task
  ffmpeg -i clip.mp4 -vf scale=640:360,fps=30 -pix_fmt yuv420p clip.y4m

Run
  python tools/e2e_fake_camera.py --app . --mp ./package --model ./pose_landmarker_lite.task \
      --y4m clip.y4m --mp4 clip.mp4 --out e2e_out
"""

import argparse
import functools
import http.server
import json
import shutil
import tempfile
import threading
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

MIME = {".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm",
        ".task": "application/octet-stream", ".html": "text/html", ".json": "application/json"}


class Handler(http.server.SimpleHTTPRequestHandler):
    def guess_type(self, path):
        return MIME.get(Path(path).suffix, super().guess_type(path))

    def log_message(self, *args):  # keep the output readable
        pass


def build_site(app: Path, mp: Path, model: Path) -> Path:
    site = Path(tempfile.mkdtemp(prefix="e2e_site_"))
    for name in ("index.html", "logic.js"):
        shutil.copy(app / name, site / name)
    shutil.copy(mp / "vision_bundle.mjs", site / "vision_bundle.mjs")
    shutil.copytree(mp / "wasm", site / "wasm")
    (site / "models").mkdir()
    shutil.copy(model, site / "models" / "pose_landmarker_lite.task")
    return site


def serve(site: Path, port: int):
    handler = functools.partial(Handler, directory=str(site))
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def stats(page):
    return page.evaluate(
        """() => { const s = window.__app; const f = s.feat || {};
        return { running: s.running, source: s.source, frames: s.perf.frames, poseFrames: s.perf.poseFrames,
                 fps: Math.round(s.perf.fps * 10) / 10, delegate: s.delegate, framingOk: s.framingOk,
                 framingReason: s.framingReason, knee: f.kneeAngle ? Math.round(f.kneeAngle) : null,
                 lum: s.lum, test: s.test ? { kind: s.test.kind, phase: s.test.phase } : null }; }"""
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--app", default=".")
    ap.add_argument("--mp", required=True, help="unpacked @mediapipe/tasks-vision package folder")
    ap.add_argument("--model", required=True)
    ap.add_argument("--y4m", required=True, help="clip for the fake camera")
    ap.add_argument("--mp4", help="same clip as mp4, to test the video-file mode")
    ap.add_argument("--chrome", default="/usr/bin/google-chrome")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--out", default="e2e_out")
    ap.add_argument("--quick", action="store_true", help="skip the 30 s chair stand")
    a = ap.parse_args()

    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    site = build_site(Path(a.app), Path(a.mp), Path(a.model))
    httpd = serve(site, a.port)
    url = (f"http://127.0.0.1:{a.port}/index.html?lib=./vision_bundle.mjs&wasm=./wasm"
           f"&model=./models/pose_landmarker_lite.task&delegate=CPU")
    report = {"console_errors": [], "page_errors": [], "steps": {}}

    with sync_playwright() as p:
        browser = p.chromium.launch(
            executable_path=a.chrome,
            headless=True,
            args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
                  f"--use-file-for-fake-video-capture={Path(a.y4m).resolve()}",
                  "--autoplay-policy=no-user-gesture-required"],
        )
        page = browser.new_page(viewport={"width": 1280, "height": 720})
        page.on("console", lambda m: m.type == "error" and report["console_errors"].append(m.text))
        page.on("pageerror", lambda e: report["page_errors"].append(str(e)))

        # 1. Camera + model
        page.goto(url)
        page.uncheck("#readAloud")
        page.click("#btnCamera")
        page.wait_for_function("() => window.__app.running && window.__app.perf.frames > 5", timeout=90000)
        time.sleep(6)
        report["steps"]["camera"] = stats(page)
        page.screenshot(path=str(out / "01_camera.png"))

        # 2. 30-second chair stand (framing override: the demo clip is not a chair test)
        if not a.quick:
            page.click("[data-test=chair]")
            page.check("#override")
            page.click("#btnStart")
            page.wait_for_function("() => !!window.__app.session.tests.chair_stand_30s", timeout=60000)
            report["steps"]["chair"] = page.evaluate("() => window.__app.session.tests.chair_stand_30s")
            page.screenshot(path=str(out / "02_chair_result.png"))

        # 3. TUG, stopped by hand after 5 s
        page.click("[data-test=tug]")
        page.check("#override")
        page.click("#btnStart")
        time.sleep(3 + 5)  # countdown + 5 s
        page.screenshot(path=str(out / "03_tug_running.png"))
        if page.is_visible("#btnSeated"):  # the clip may already have ended the TUG on its own
            page.click("#btnSeated")
        page.wait_for_function("() => !!window.__app.session.tests.tug", timeout=15000)
        report["steps"]["tug"] = page.evaluate("() => window.__app.session.tests.tug")

        # 4. Balance, stage 1
        page.click("[data-test=balance]")
        page.check("#override")
        page.click("#btnStart")
        page.wait_for_function("() => window.__app.test.runner.results.length >= 1", timeout=20000)
        report["steps"]["balance_stage1"] = page.evaluate("() => window.__app.test.runner.results")
        report["steps"]["session_json"] = json.loads(page.text_content("#jsonOut") or "{}")
        page.screenshot(path=str(out / "04_balance.png"))
        page.evaluate("() => document.getElementById('report').scrollIntoView({block: 'start'})")
        time.sleep(0.3)
        page.screenshot(path=str(out / "04_report_card.png"))

        # 5. Video-file mode
        if a.mp4:
            page.goto(url)
            page.set_input_files("#fileInput", a.mp4)
            page.wait_for_function("() => window.__app.source === 'file' && window.__app.perf.frames > 20", timeout=60000)
            time.sleep(2)
            report["steps"]["file_mode"] = stats(page)
            page.screenshot(path=str(out / "05_file_mode.png"))

        # 6. Phone layouts
        for name, size in {"06_phone_portrait": (390, 844), "07_phone_landscape": (844, 390)}.items():
            ph = browser.new_page(viewport={"width": size[0], "height": size[1]}, device_scale_factor=2)
            ph.goto(url)
            ph.screenshot(path=str(out / f"{name}.png"))
            ph.close()
        browser.close()

    httpd.shutdown()
    (out / "report.json").write_text(json.dumps(report, indent=2))
    print(json.dumps({k: v for k, v in report.items() if k != "steps"} | {"steps": list(report["steps"])}, indent=2))
    for k, v in report["steps"].items():
        if k != "session_json":
            print(k, json.dumps(v)[:400])


if __name__ == "__main__":
    main()
