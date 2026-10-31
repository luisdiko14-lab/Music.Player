# Music.Player

A local-first music player with a browser GUI, canvas audio visualizer, read-only media inspector, Google Drive preview, and community radio search.

## Run

Requires Python 3.10 or newer. Install the trusted CA bundle used for verified radio-directory connections:

```bash
python3 -m pip install -r requirements.txt
python3 music_player.py
```

On Windows, use `py -m pip install -r requirements.txt` followed by `py music_player.py` (the filename uses an underscore and a period).

The server binds to an available port on `127.0.0.1` and opens the interface in your browser. The existing audio files in this folder are detected automatically. To scan another folder:

```bash
python3 music_player.py --media-dir "$HOME/Music"
```

Use **Upload files** to copy supported audio or video into your per-user Music.Player library. Uploads are available in the Windows executable and survive restarts. On Windows they are stored under `%LOCALAPPDATA%\\MusicPlayer\\music`; on Linux and macOS they use the standard user data directory. Lyric and text files can still be opened as read-only previews without uploading them. Supported extensions include MP3, MP4, M4A, AAC, WAV, FLAC, OGG, OPUS, WMA, WebM, MOV, MKV, LRC, CUE, TXT, Markdown, and JSON. Actual playback support depends on the codecs available in your browser; uploads are limited to 500 MB per file.

## Online Playback

The **Online radio** view searches the Radio Browser community directory, defaults to German stations, and can filter across all countries. Search requests use verified HTTPS with a bundled CA certificate set and alternate directory hosts; certificate verification is never disabled. The player does not download songs. The **Drive player** embeds the configured Google Drive file; the file must be shared with permissions that allow preview playback.

## Windows Executable

In GitHub, run **Actions → Build Windows Player → Run workflow**. The workflow builds a one-file Windows executable, uploads a downloadable Actions artifact, and commits `builds/music-player-windows.zip` to the selected branch. The workflow requires permission to write to that branch. The zip contains the executable and a `music/` folder; uploaded tracks are stored in the user's Music.Player data folder.

The executable does not need Git or Python installed. To prepare a Windows machine for building from source, run `./setup-windows.ps1` in PowerShell; it installs Git and Python 3.12 through WinGet only when needed. WinGet validates its package sources and installer signatures. Python 3.12 is used because it matches the build workflow; Python 3.15.2 is not assumed to be compatible with the current PyInstaller build.

## Local Server Safety

The server listens on localhost by default and exposes the media files it discovers to the local browser without modifying them. Do not bind it to a public or shared network interface.