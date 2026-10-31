# Music.Player
A local-first music player with a browser GUI, canvas audio visualizer, read-only media inspector, Google Drive preview, and community radio search.

## Run

Requires Python 3.10 or newer. Install the desktop shell and trusted CA bundle used for verified radio-directory connections:

```bash
python3 -m pip install -r requirements.txt
python3 music_player.py
```

On Windows, use `py -m pip install -r requirements.txt` followed by `py music_player.py` (the filename uses an underscore and a period). The player opens in its own pywebview window using the Microsoft Edge WebView2 runtime; install the Evergreen WebView2 Runtime if it is missing. Use `--no-browser` to run only the local server or `--browser` to explicitly use an external browser.

On Linux, pywebview uses the PySide6/Qt backend from `requirements.txt` and needs an active X11 or Wayland display. A headless Codespace cannot show a native window; run the Windows executable on a Windows desktop or explicitly use `--browser` there.

The server binds to an available port on `127.0.0.1` and serves the interface inside the desktop window. The existing audio files in this folder are detected automatically. To scan another folder:

```bash
python3 music_player.py --media-dir "$HOME/Music"
```

Use **Upload files** to copy supported audio or video into your per-user Music.Player library. Uploads are available in the Windows executable and survive restarts. On Windows they are stored under `%LOCALAPPDATA%\\MusicPlayer\\music`; on Linux and macOS they use the standard user data directory. Select **Lyrics** to check beside the current track for a same-name `.lrc` sidecar and sync its timestamps to playback; you can also choose a local `.lrc` file to display it. Lyrics stay local; no external lyrics service or API key is used. Other lyric and text files remain available as read-only previews. Supported extensions include MP3, MP4, M4A, AAC, WAV, FLAC, OGG, OPUS, WMA, WebM, MOV, MKV, LRC, CUE, TXT, Markdown, and JSON. Actual playback support depends on the codecs available in the embedded player; uploads are limited to 500 MB per file.

## Online Playback

The **Online radio** view searches the Radio Browser community directory, defaults to German stations, and can filter across all countries. Search requests use verified HTTPS with a bundled CA certificate set and alternate directory hosts; certificate verification is never disabled. The player does not download songs. The **Drive player** embeds the configured Google Drive file; the file must be shared with permissions that allow preview playback.

## Windows Executable

In GitHub, run **Actions → Build Windows Player → Run workflow**. The workflow builds a one-file Windows executable, uploads a downloadable Actions artifact, and commits `builds/music-player-windows.zip` to the selected branch. The workflow requires permission to write to that branch. The zip contains the executable and a `music/` folder; uploaded tracks are stored in the user's Music.Player data folder.

The executable does not need Git or Python installed. To prepare a Windows machine for building from source, run `./setup-windows.ps1` in PowerShell; it installs Git and Python 3.12 through WinGet only when needed. WinGet validates its package sources and installer signatures. Python 3.12 is used because it matches the build workflow; Python 3.15.2 is not assumed to be compatible with the current PyInstaller build.

The desktop toolbar opens a small task manager and notification settings. The task manager starts a named executable found on `PATH` or an `.exe` selected through the file picker. It can end only processes it started, after confirmation. Notification title and message are customizable; `{track}` inserts the track or station name, and `{app}` inserts `Music.Player`. Closing the window hides it to the system tray; choose **Quit** from the tray menu to exit.

## Local Server Safety

The server listens on localhost by default and exposes the media files it discovers to the local browser without modifying them. Do not bind it to a public or shared network interface.