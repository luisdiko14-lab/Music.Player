"""pywebview desktop shell and JavaScript API for Music.Player."""

from __future__ import annotations

import json
import os
import queue
import shutil
import subprocess
import sys
import threading
from pathlib import Path
from urllib.parse import urlsplit

import webview

try:
    import pystray
    from PIL import Image, ImageDraw
except Exception:
    pystray = None
    Image = None
    ImageDraw = None


def settings_path() -> Path:
    if os.name == "nt":
        root = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    else:
        root = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    return root / "MusicPlayer" / "desktop-settings.json"


class DesktopAPI:
    def __init__(self):
        self.window = None
        self.managed_processes: dict[int, tuple[str, subprocess.Popen]] = {}
        self.settings_file = settings_path()
        self.tray_icon = None

    def bind_window(self, window) -> None:
        self.window = window

    def choose_executable(self) -> str | None:
        if self.window is None:
            return None
        if os.name == "nt":
            file_types = ("Applications (*.exe)",)
        else:
            file_types = ("Applications (*)",)
        selection = self.window.create_file_dialog(
            webview.FileDialog.OPEN,
            allow_multiple=False,
            file_types=file_types,
        )
        return selection[0] if selection else None

    def start_task(self, value: str) -> dict:
        value = value.strip().strip('"')
        if not value:
            return {"ok": False, "error": "Enter an app name or choose an executable."}
        candidate = Path(value).expanduser()
        if candidate.is_file():
            executable = candidate.resolve()
        else:
            executable_name = value
            if os.name == "nt" and Path(value).suffix.lower() != ".exe":
                executable_name += ".exe"
            located = shutil.which(executable_name)
            if not located:
                return {"ok": False, "error": "App not found. Enter its path or use Browse."}
            executable = Path(located).resolve()

        if os.name == "nt" and executable.suffix.lower() != ".exe":
            return {"ok": False, "error": "Choose a Windows .exe application."}
        if not executable.is_file():
            return {"ok": False, "error": "The selected executable does not exist."}

        try:
            flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) if os.name == "nt" else 0
            process = subprocess.Popen(
                [str(executable)],
                cwd=str(executable.parent),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                shell=False,
                close_fds=True,
                creationflags=flags,
            )
        except OSError as error:
            return {"ok": False, "error": str(error)}

        self.managed_processes[process.pid] = (executable.name, process)
        return {"ok": True, "task": self._task_record(process.pid)}

    def list_tasks(self) -> list[dict]:
        return [self._task_record(pid) for pid in list(self.managed_processes)]

    def end_task(self, pid: int) -> dict:
        try:
            task = self.managed_processes.get(int(pid))
        except (TypeError, ValueError):
            task = None
        if task is None:
            return {"ok": False, "error": "That task was not started by Music.Player."}

        name, process = task
        if process.poll() is not None:
            return {"ok": False, "error": f"{name} has already exited."}
        try:
            process.terminate()
        except OSError as error:
            return {"ok": False, "error": str(error)}
        return {"ok": True, "pid": process.pid}

    def load_notification_settings(self) -> dict:
        try:
            settings = json.loads(self.settings_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            settings = {}
        return {
            "enabled": bool(settings.get("enabled", True)),
            "title": str(settings.get("title", "Music.Player"))[:80],
            "message": str(settings.get("message", "Now playing: {track}"))[:200],
        }

    def save_notification_settings(self, enabled: bool, title: str, message: str) -> dict:
        settings = {
            "enabled": bool(enabled),
            "title": str(title).strip()[:80] or "Music.Player",
            "message": str(message).strip()[:200] or "Now playing: {track}",
        }
        try:
            self.settings_file.parent.mkdir(parents=True, exist_ok=True)
            temporary_file = self.settings_file.with_suffix(".tmp")
            temporary_file.write_text(json.dumps(settings, indent=2), encoding="utf-8")
            temporary_file.replace(self.settings_file)
        except OSError as error:
            return {"ok": False, "error": str(error)}
        return {"ok": True}

    def test_notification(
        self,
        track: str = "Sample track",
        title: str | None = None,
        message: str | None = None,
    ) -> dict:
        settings = self.load_notification_settings()
        if title is not None:
            settings["title"] = str(title)[:80] or "Music.Player"
        if message is not None:
            settings["message"] = str(message)[:200] or "Now playing: {track}"
        return {"ok": self.notify_track(str(track), settings)}

    def notify_track(self, track: str, settings: dict | None = None) -> bool:
        settings = settings or self.load_notification_settings()
        if not settings["enabled"] or self.tray_icon is None:
            return False
        message = settings["message"][:200]
        message = message.replace("{track}", str(track)[:160]).replace("{app}", "Music.Player")
        try:
            self.tray_icon.notify(message, settings["title"])
        except (AttributeError, NotImplementedError, RuntimeError):
            return False
        return True

    def _task_record(self, pid: int) -> dict:
        name, process = self.managed_processes[pid]
        return {
            "name": name,
            "pid": pid,
            "running": process.poll() is None,
            "returnCode": process.poll(),
        }


def make_tray_image():
    if Image is None or ImageDraw is None:
        return None
    image = Image.new("RGBA", (64, 64), (21, 26, 22, 255))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((5, 5, 59, 59), radius=11, fill=(215, 255, 105, 255))
    draw.text((13, 24), "M/P", fill=(21, 26, 22, 255))
    return image


def run_desktop_app(server, url: str, desktop_events: queue.Queue) -> int:
    api = DesktopAPI()
    app_window = webview.create_window(
        "Music.Player",
        url=url,
        js_api=api,
        width=1420,
        height=900,
        min_size=(720, 520),
        text_select=True,
        confirm_close=False,
    )
    api.bind_window(app_window)
    quit_requested = threading.Event()
    tray = None

    def show_player(_icon=None, _item=None) -> None:
        app_window.show()

    def show_task_manager(_icon=None, _item=None) -> None:
        app_window.show()
        try:
            app_window.evaluate_js("window.openTaskManager && window.openTaskManager()")
        except Exception:
            pass

    def show_notification_settings(_icon=None, _item=None) -> None:
        app_window.show()
        try:
            app_window.evaluate_js("window.openNotificationSettings && window.openNotificationSettings()")
        except Exception:
            pass

    def quit_app(_icon=None, _item=None) -> None:
        quit_requested.set()
        app_window.destroy()

    if pystray is not None:
        menu = pystray.Menu(
            pystray.MenuItem("Show Music.Player", show_player, default=True),
            pystray.MenuItem("Task manager", show_task_manager),
            pystray.MenuItem("Notifications", show_notification_settings),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Quit", quit_app),
        )
        tray = pystray.Icon("Music.Player", make_tray_image(), "Music.Player", menu)
        api.tray_icon = tray

    def on_closing(window) -> bool:
        if quit_requested.is_set():
            return True
        window.hide()
        if tray is not None:
            try:
                tray.notify("Music.Player is still running in the system tray.", "Music.Player")
            except (AttributeError, NotImplementedError, RuntimeError):
                pass
        return False

    app_window.events.closing += on_closing
    server_thread = threading.Thread(target=server.serve_forever, name="MusicPlayerHTTP", daemon=True)
    server_thread.start()
    stop_events = threading.Event()

    def deliver_notifications() -> None:
        while not stop_events.is_set():
            try:
                event = desktop_events.get(timeout=0.25)
            except queue.Empty:
                continue
            if event.get("event") in {"track-started", "station-started"}:
                api.notify_track(event.get("track", ""))

    event_thread = threading.Thread(target=deliver_notifications, name="MusicPlayerNotifications", daemon=True)
    event_thread.start()
    if tray is not None:
        tray.run_detached()

    gui = "edgechromium" if os.name == "nt" else None
    try:
        webview.start(gui=gui, debug=False, private_mode=False, storage_path=str(settings_path().parent / "webview"))
    finally:
        stop_events.set()
        if tray is not None:
            tray.stop()
        server.shutdown()
        server.server_close()
        server_thread.join(timeout=3)
        event_thread.join(timeout=1)
    return 0