"""Headless check of the simple chair-stand page (index.html) with a clip as fake camera.

Runs: start screen -> camera -> forced countdown -> 30 s test -> result -> team notes saved -> CSV export.
Same setup as e2e_fake_camera.py (local MediaPipe copies, a .y4m clip).

  python tools/e2e_simple.py --mp ./package --model ./pose_landmarker_lite.task --y4m clip.y4m --out e2e_simple
"""
import argparse, functools, http.server, json, shutil, tempfile, threading, time
from pathlib import Path
from playwright.sync_api import sync_playwright

MIME = {".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm", ".task": "application/octet-stream"}


class Handler(http.server.SimpleHTTPRequestHandler):
    def guess_type(self, path):
        return MIME.get(Path(path).suffix, super().guess_type(path))

    def log_message(self, *args):
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--app", default=".")
    ap.add_argument("--mp", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--y4m", required=True)
    ap.add_argument("--chrome", default="/usr/bin/google-chrome")
    ap.add_argument("--port", type=int, default=8770)
    ap.add_argument("--out", default="e2e_simple")
    a = ap.parse_args()
    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)

    site = Path(tempfile.mkdtemp(prefix="e2e_simple_"))
    for name in ("index.html", "nurse.html", "logic.js"):
        shutil.copy(Path(a.app) / name, site / name)
    shutil.copy(Path(a.mp) / "vision_bundle.mjs", site / "vision_bundle.mjs")
    shutil.copytree(Path(a.mp) / "wasm", site / "wasm")
    (site / "models").mkdir()
    shutil.copy(a.model, site / "models" / "pose_landmarker_lite.task")
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", a.port), functools.partial(Handler, directory=str(site)))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    url = (f"http://127.0.0.1:{a.port}/index.html?lib=./vision_bundle.mjs&wasm=./wasm"
           f"&model=./models/pose_landmarker_lite.task&delegate=CPU")
    report = {"page_errors": [], "steps": {}}

    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=a.chrome, headless=True, args=[
            "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
            f"--use-file-for-fake-video-capture={Path(a.y4m).resolve()}", "--autoplay-policy=no-user-gesture-required"])
        ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, accept_downloads=True)
        page = ctx.new_page()
        page.on("pageerror", lambda e: report["page_errors"].append(str(e)))
        page.goto(url)
        page.click("[data-lang=fr]")
        page.screenshot(path=str(out / "1_start_fr.png"), full_page=True)

        page.click("#startBtn")
        page.wait_for_function("() => window.__app.phase === 'waiting' && window.__app.perf.frames > 10", timeout=90000)
        time.sleep(2)
        report["steps"]["waiting"] = page.evaluate("() => ({ msg: document.getElementById('msg').textContent, reason: window.__app.framingReason, fps: Math.round(window.__app.perf.fps) })")
        page.screenshot(path=str(out / "2_camera_waiting.png"))

        page.evaluate("() => window.__app.forceCountdown()")
        page.wait_for_function("() => window.__app.phase === 'running'", timeout=30000)
        time.sleep(8)
        page.screenshot(path=str(out / "3_running.png"))
        page.wait_for_function("() => !document.getElementById('result').hidden", timeout=40000)
        time.sleep(0.5)
        report["steps"]["result"] = page.evaluate("() => window.__app.result")
        page.screenshot(path=str(out / "4_result.png"), full_page=True)

        page.click("#teamNotes summary")
        page.fill("#handCount", "7")
        page.check("#neededHelp")
        page.fill("#notes", "Asked if the phone records her")
        page.click("#saveBtn")
        report["steps"]["saved"] = page.evaluate("() => JSON.parse(localStorage.getItem('sit-to-stand-sessions'))")
        page.screenshot(path=str(out / "5_team_notes.png"), full_page=True)

        page.click("#againBtn")
        page.wait_for_function("() => window.__app.phase === 'waiting'", timeout=30000)
        page.click("#stopBtn")
        page.wait_for_function("() => !document.getElementById('start').hidden", timeout=10000)
        page.click("details.team summary")
        with page.expect_download() as dl:
            page.click("#exportBtn")
        csv_path = out / "export.csv"
        dl.value.save_as(str(csv_path))
        report["steps"]["csv"] = csv_path.read_text()

        for lang in ("de", "it", "en", "es"):
            page.click(f"[data-lang={lang}]")
            report["steps"][f"title_{lang}"] = page.inner_text("h1")
        page.click("[data-lang=es]")
        page.screenshot(path=str(out / "6_start_es.png"), full_page=True)

        land = browser.new_page(viewport={"width": 844, "height": 390}, device_scale_factor=2)
        land.goto(url)
        land.screenshot(path=str(out / "7_start_landscape.png"))
        browser.close()
    httpd.shutdown()
    (out / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False))
    print(json.dumps(report, indent=2, ensure_ascii=False)[:3000])


if __name__ == "__main__":
    main()
