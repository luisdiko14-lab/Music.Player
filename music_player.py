"""Serve the Music.Player browser app and expose a read-only local media library."""

from __future__ import annotations

import argparse
import importlib
import json
import mimetypes
import os
import queue
import re
import ssl
import tempfile
import sys
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import URLError
from urllib.parse import parse_qs, unquote, urlencode, urlsplit
from urllib.request import Request, urlopen
import webbrowser

SUPPORTED_MEDIA = {
    ".aac",
    ".aif",
    ".aiff",
    ".flac",
    ".m4a",
    ".mka",
    ".mkv",
    ".mov",
    ".mp3",
    ".mp4",
    ".oga",
    ".ogg",
    ".opus",
    ".wav",
    ".webm",
    ".wma",
}
MAX_UPLOAD_BYTES = 500 * 1024 * 1024
MAX_LYRICS_BYTES = 512 * 1024
MAX_RADIO_RESPONSE_BYTES = 2 * 1024 * 1024
RADIO_DIRECTORY_HOSTS = (
    "de1.api.radio-browser.info",
    "nl1.api.radio-browser.info",
    "at1.api.radio-browser.info",
)
WINDOWS_RESERVED_NAMES = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{number}" for number in range(1, 10)),
    *(f"LPT{number}" for number in range(1, 10)),
}


def user_music_root() -> Path:
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    else:
        base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))
    return base / "MusicPlayer" / "music"


def safe_upload_filename(value: str) -> str:
    basename = value.replace("\\", "/").rsplit("/", 1)[-1].strip()
    suffix = Path(basename).suffix.lower()
    if suffix not in SUPPORTED_MEDIA:
        raise ValueError("Choose a supported audio or video format")

    stem = Path(basename).stem
    stem = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", stem).strip(" .")
    if not stem:
        stem = "untitled"
    if stem.upper() in WINDOWS_RESERVED_NAMES:
        stem = f"_{stem}"
    stem = stem[:160].rstrip(" .") or "untitled"
    return f"{stem}{suffix}"


def tls_context() -> ssl.SSLContext:
    try:
        certificate_bundle = importlib.import_module("certifi").where()
    except ImportError:
        pass
    else:
        return ssl.create_default_context(cafile=certificate_bundle)
    return ssl.create_default_context()

def application_root() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def bundled_root() -> Path:
    return Path(getattr(sys, "_MEIPASS", application_root()))


def media_roots(root: Path) -> list[Path]:
    candidates = [root / "music", root / "Music", root]
    results: list[Path] = []
    for candidate in candidates:
        if candidate.is_dir():
            resolved = candidate.resolve()
            if resolved not in results:
                results.append(resolved)
    return results


def media_id(root_index: int, relative_path: Path) -> str:
    return f"{root_index}|{relative_path.as_posix()}"


def resolve_media_id(roots: list[Path], value: str, extensions: set[str]) -> Path:
    root_number, separator, relative_name = value.partition("|")
    if not separator or not relative_name:
        raise ValueError("Invalid media path")
    try:
        root = roots[int(root_number)]
    except (ValueError, IndexError) as error:
        raise ValueError("Invalid media folder") from error

    candidate = (root / unquote(relative_name)).resolve(strict=True)
    try:
        candidate.relative_to(root)
    except ValueError as error:
        raise ValueError("Path is outside the media folder") from error
    if not candidate.is_file() or candidate.suffix.lower() not in extensions:
        raise ValueError("Unsupported file")
    return candidate


class MusicRequestHandler(BaseHTTPRequestHandler):
    server_version = "MusicPlayer/1.0"

    def __init__(self, *args, web_root: Path, roots: list[Path], desktop_events=None, **kwargs):
        self.web_root = web_root.resolve()
        self.roots = [root.resolve() for root in roots]
        self.upload_root = self.roots[0]
        self.desktop_events = desktop_events
        super().__init__(*args, **kwargs)

    def do_GET(self) -> None:
        request = urlsplit(self.path)
        if request.path == "/api/tracks":
            self.send_json(self.list_tracks())
        elif request.path == "/api/lyrics":
            self.send_lyrics(parse_qs(request.query).get("id", [""])[0])
        elif request.path == "/api/stations":
            self.send_stations(parse_qs(request.query))
        elif request.path == "/api/media":
            self.send_media(parse_qs(request.query).get("id", [""])[0])
        else:
            self.send_static_file(request.path)

    def do_POST(self) -> None:
        request = urlsplit(self.path)
        if request.path == "/api/upload":
            self.receive_upload(parse_qs(request.query).get("name", [""])[0])
        elif request.path == "/api/desktop-event":
            self.receive_desktop_event()
        else:
            self.send_error(404, "Endpoint not found")

    def list_tracks(self) -> dict:
        tracks = []
        seen_paths = set()
        for root_index, root in enumerate(self.roots):
            for directory, subdirectories, filenames in os.walk(root, followlinks=False):
                subdirectories[:] = sorted(
                    name
                    for name in subdirectories
                    if not name.startswith(".")
                    and not (Path(directory) / name).is_symlink()
                )
                for filename in sorted(filenames, key=str.casefold):
                    path = Path(directory) / filename
                    if path.suffix.lower() not in SUPPORTED_MEDIA or path.is_symlink():
                        continue
                    try:
                        resolved_path = path.resolve(strict=True)
                        if resolved_path in seen_paths:
                            continue
                        stat = path.stat()
                        relative_path = path.relative_to(root)
                    except OSError:
                        continue
                    seen_paths.add(resolved_path)
                    tracks.append(
                        {
                            "id": media_id(root_index, relative_path),
                            "name": path.name,
                            "extension": path.suffix.lower(),
                            "size": stat.st_size,
                            "modified": int(stat.st_mtime),
                            "type": "video" if path.suffix.lower() in {".mkv", ".mov", ".mp4", ".webm"} else "audio",
                        }
                    )
        tracks.sort(key=lambda track: track["name"].casefold())
        return {"tracks": tracks, "extensions": sorted(SUPPORTED_MEDIA)}

    def receive_upload(self, requested_name: str) -> None:
        temporary_path = None
        try:
            filename = safe_upload_filename(requested_name)
            content_length = int(self.headers.get("Content-Length", "0"))
            if content_length <= 0:
                raise ValueError("The selected file is empty")
            if content_length > MAX_UPLOAD_BYTES:
                self.send_json({"error": "Uploads are limited to 500 MB"}, status=413)
                return

            self.upload_root.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(
                mode="wb", prefix=".upload-", suffix=".tmp", dir=self.upload_root, delete=False
            ) as temporary_file:
                temporary_path = Path(temporary_file.name)
                remaining = content_length
                while remaining:
                    chunk = self.rfile.read(min(64 * 1024, remaining))
                    if not chunk:
                        raise ValueError("Upload ended before all bytes arrived")
                    temporary_file.write(chunk)
                    remaining -= len(chunk)

            stem = Path(filename).stem
            suffix = Path(filename).suffix
            for number in range(10000):
                duplicate_suffix = f" ({number})" if number else ""
                destination = self.upload_root / f"{stem}{duplicate_suffix}{suffix}"
                try:
                    os.link(temporary_path, destination)
                    break
                except FileExistsError:
                    continue
            else:
                raise OSError("Could not find an available filename")

            temporary_path.unlink()
            temporary_path = None
            stat = destination.stat()
            root_index = self.roots.index(self.upload_root)
            track = {
                "id": media_id(root_index, Path(destination.name)),
                "name": destination.name,
                "extension": destination.suffix.lower(),
                "size": stat.st_size,
                "modified": int(stat.st_mtime),
                "type": "video" if destination.suffix.lower() in {".mkv", ".mov", ".mp4", ".webm"} else "audio",
            }
            self.send_json({"track": track}, status=201)
        except (OSError, ValueError) as error:
            self.send_json({"error": str(error) or "Upload failed"}, status=400)
        finally:
            if temporary_path is not None:
                temporary_path.unlink(missing_ok=True)

    def send_lyrics(self, identifier: str) -> None:
        try:
            root_number = int(identifier.partition("|")[0])
            root = self.roots[root_number]
            media_path = resolve_media_id(self.roots, identifier, SUPPORTED_MEDIA)
            sidecar = media_path.with_suffix(".lrc")
            if not sidecar.is_file():
                sidecar = next(
                    candidate
                    for candidate in media_path.parent.iterdir()
                    if candidate.stem.casefold() == media_path.stem.casefold()
                    and candidate.suffix.lower() == ".lrc"
                )
            sidecar = sidecar.resolve(strict=True)
            sidecar.relative_to(root)
            if not sidecar.is_file():
                raise FileNotFoundError
            if sidecar.stat().st_size > MAX_LYRICS_BYTES:
                self.send_json({"error": "Lyrics file exceeds the 512 KB limit"}, status=413)
                return
            lyrics = sidecar.read_text(encoding="utf-8-sig", errors="replace")
        except (OSError, StopIteration, ValueError, IndexError):
            self.send_json({"error": "No matching local .lrc lyrics file was found"}, status=404)
            return
        self.send_json({"name": sidecar.name, "lyrics": lyrics})

    def receive_desktop_event(self) -> None:
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
            if not 0 < content_length <= 4096:
                self.send_json({"error": "Invalid event size"}, status=400)
                return
            payload = json.loads(self.rfile.read(content_length))
            event = payload.get("event")
            track = payload.get("track")
            if event not in {"track-started", "station-started"} or not isinstance(track, str):
                self.send_json({"error": "Invalid desktop event"}, status=400)
                return
            if self.desktop_events is not None:
                try:
                    self.desktop_events.put_nowait({"event": event, "track": track[:200]})
                except queue.Full:
                    pass
            self.send_json({"accepted": True})
        except (json.JSONDecodeError, OSError, TypeError, ValueError):
            self.send_json({"error": "Invalid desktop event"}, status=400)

    def send_stations(self, query: dict[str, list[str]]) -> None:
        name = query.get("name", [""])[0].strip()[:80]
        tag = query.get("tag", [""])[0].strip()[:80]
        country_code = query.get("countrycode", [""])[0].strip().upper()
        if country_code and not re.fullmatch(r"[A-Z]{2}", country_code):
            self.send_json({"error": "Country code must contain two letters"}, status=400)
            return

        parameters = {
            "name": name,
            "tag": tag,
            "countrycode": country_code,
            "limit": "24",
            "hidebroken": "true",
            "order": "votes",
            "reverse": "true",
        }
        context = tls_context()
        for host in RADIO_DIRECTORY_HOSTS:
            request = Request(
                f"https://{host}/json/stations/search?{urlencode(parameters)}",
                headers={"User-Agent": "MusicPlayer/1.0", "Accept": "application/json"},
            )
            try:
                with urlopen(request, timeout=8, context=context) as response:
                    content = response.read(MAX_RADIO_RESPONSE_BYTES + 1)
                if len(content) > MAX_RADIO_RESPONSE_BYTES:
                    self.send_json({"error": "Radio directory response was too large"}, status=502)
                    return
                stations = json.loads(content)
                if not isinstance(stations, list):
                    raise ValueError("Invalid radio directory response")
                self.send_json({"stations": stations})
                return
            except (OSError, URLError, TimeoutError, ValueError, ssl.SSLError) as error:
                self.log_error("Radio directory %s failed: %s", host, error)

        self.send_json(
            {
                "error": "Radio directory unavailable. TLS certificate checks remain enabled; check your system date, trusted root certificates, and internet connection."
            },
            status=502,
        )

    def send_media(self, identifier: str) -> None:
        try:
            path = resolve_media_id(self.roots, identifier, SUPPORTED_MEDIA)
            file_size = path.stat().st_size
        except (OSError, ValueError):
            self.send_error(404, "Media file not found")
            return

        start, end = 0, file_size - 1
        range_header = self.headers.get("Range")
        status = 200
        if range_header:
            try:
                unit, requested_range = range_header.split("=", 1)
                first, last = requested_range.split("-", 1)
                if unit != "bytes" or "," in requested_range:
                    raise ValueError
                if first:
                    start = int(first)
                    end = min(int(last), file_size - 1) if last else file_size - 1
                else:
                    suffix_length = int(last)
                    start = max(file_size - suffix_length, 0)
                if start > end or start >= file_size:
                    raise ValueError
                status = 206
            except ValueError:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{file_size}")
                self.end_headers()
                return

        content_length = end - start + 1
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(content_length))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("X-Content-Type-Options", "nosniff")
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
        self.end_headers()
        if self.command != "HEAD":
            with path.open("rb") as media_file:
                media_file.seek(start)
                remaining = content_length
                while remaining:
                    chunk = media_file.read(min(64 * 1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)

    def send_static_file(self, request_path: str) -> None:
        relative_path = unquote(request_path.lstrip("/")) or "index.html"
        path = (self.web_root / relative_path).resolve()
        try:
            path.relative_to(self.web_root)
            if not path.is_file():
                raise FileNotFoundError
            content = path.read_bytes()
        except (OSError, ValueError):
            self.send_error(404, "Page not found")
            return

        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if content_type.startswith("text/") or content_type in {"application/javascript", "application/json"}:
            content_type += "; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(content)

    def send_json(self, payload: dict, status: int = 200) -> None:
        content = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(content)

    def log_message(self, format_string: str, *args) -> None:
        print(f"[{self.log_date_time_string()}] {format_string % args}")


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the Music.Player local web app.")
    parser.add_argument("--host", default="127.0.0.1", help="Interface to bind (default: localhost only)")
    parser.add_argument("--port", type=int, default=0, help="Port to bind; 0 selects a free port")
    parser.add_argument("--media-dir", type=Path, help="Additional folder to scan for media")
    parser.add_argument("--no-browser", action="store_true", help="Run only the local server, without a desktop window")
    parser.add_argument("--browser", action="store_true", help="Open the player in an external browser instead of the desktop window")
    return parser.parse_args()


def main() -> None:
    arguments = parse_arguments()
    if not 0 <= arguments.port <= 65535:
        raise SystemExit("Port must be between 0 and 65535")

    root = application_root()
    upload_root = user_music_root().resolve()
    try:
        upload_root.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        raise SystemExit(f"Could not create music folder {upload_root}: {error}") from error
    roots = [upload_root, *media_roots(root)]
    if arguments.media_dir:
        extra_root = arguments.media_dir.expanduser().resolve()
        if not extra_root.is_dir():
            raise SystemExit(f"Media folder does not exist: {extra_root}")
        if extra_root not in roots:
            roots.insert(1, extra_root)

    web_root = bundled_root() / "web"
    if not (web_root / "index.html").is_file():
        raise SystemExit(f"Web app files not found: {web_root}")

    desktop_events = queue.Queue(maxsize=100)
    handler = partial(
        MusicRequestHandler,
        web_root=web_root,
        roots=roots,
        desktop_events=desktop_events,
    )
    try:
        server = ThreadingHTTPServer((arguments.host, arguments.port), handler)
    except OSError as error:
        raise SystemExit(f"Could not start server: {error}") from error

    address, port = server.server_address[:2]
    display_address = f"[{address}]" if ":" in address else address
    url = f"http://{display_address}:{port}/"
    print(f"Music.Player is running at {url}", flush=True)
    try:
        if arguments.no_browser:
            print("Press Ctrl+C to stop the server.", flush=True)
            server.serve_forever()
            return

        if arguments.browser:
            webbrowser.open(url)
            server.serve_forever()
            return

        if os.name != "nt" and sys.platform != "darwin" and not (
            os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")
        ):
            raise SystemExit(
                "Cannot open the pywebview desktop window: this Linux session has no graphical display. "
                "Run the Windows executable on your desktop, or use --browser explicitly."
            )

        try:
            from pywebview_gui import run_desktop_app
        except ImportError as error:
            raise SystemExit(
                f"The desktop UI is unavailable ({error}). Install requirements.txt or run with --browser."
            ) from error
        try:
            run_desktop_app(server, url, desktop_events)
        except Exception as error:
            raise SystemExit(
                f"Could not start the pywebview desktop window ({error}). "
                "On Linux, install requirements.txt and use a graphical session."
            ) from error
    except KeyboardInterrupt:
        print("\nStopping Music.Player.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()