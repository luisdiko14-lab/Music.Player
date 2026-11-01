const audioPlayer = document.querySelector("#audio-player");
const nextAudioPlayer = document.querySelector("#audio-player-next");
const videoPlayer = document.querySelector("#video-player");
const streamPlayer = new Audio();
streamPlayer.preload = "none";
const trackList = document.querySelector("#track-list");
const trackSearch = document.querySelector("#track-search");
const visualizer = document.querySelector("#visualizer");
const canvasContext = visualizer.getContext("2d");

const state = {
  tracks: [],
  currentIndex: -1,
  shuffle: false,
  repeat: false,
  activeMedia: audioPlayer,
  lastAudioMedia: audioPlayer,
  selectedTrack: null,
  objectUrls: new Set(),
  audioContext: null,
  analyser: null,
  source: null,
  eqFilters: [],
  eqGains: [0, 0, 0, 0, 0],
  animationFrame: 0,
  artworkRequest: 0,
  artworkObjectUrl: null,
  inspectorOpen: window.innerWidth > 860,
  lyrics: [],
  lyricsRequest: 0,
  activeLyricIndex: -1,
  lyricsFirstLineOnly: false,
  playlists: [],
  activePlaylistId: null,
  draggedPlaylistIndex: -1,
  crossfadeSeconds: 0,
  crossfadeTriggered: false,
  crossfadeTimer: null,
  audioSources: new WeakMap(),
  shortcuts: { play: "Space", next: "ArrowRight", previous: "ArrowLeft" },
};

const mediaExtensions = new Set([
  ".aac", ".aif", ".aiff", ".flac", ".m4a", ".mka", ".mkv", ".mov",
  ".mp3", ".mp4", ".oga", ".ogg", ".opus", ".wav", ".webm", ".wma",
]);
const textExtensions = new Set([".cue", ".json", ".lrc", ".md", ".txt"]);
const videoExtensions = new Set([".mkv", ".mov", ".mp4", ".webm"]);
const defaultYoutubeVideoId = "0mkhdIo2DGw";
const youtubeVideoIdPattern = /^[A-Za-z0-9_-]{11}$/;
const youtubePlaylistIdPattern = /^[A-Za-z0-9_-]{2,128}$/;

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "0:00";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unitIndex]}`;
}

function fileExtension(name) {
  const lastDot = name.lastIndexOf(".");
  return lastDot < 0 ? "" : name.slice(lastDot).toLowerCase();
}

function parseLyrics(raw) {
  const entries = [];
  const timestampPattern = /\[(\d+):(\d{2})(?:\.(\d{1,3}))?\]/g;
  for (const line of raw.split(/\r?\n/)) {
    const timestamps = [...line.matchAll(timestampPattern)];
    const text = line
      .replace(timestampPattern, "")
      .replace(/^\s*\[[a-z]{2,3}:[^\]]*\]\s*$/i, "")
      .trim();
    if (!text) continue;
    if (!timestamps.length) {
      entries.push({ time: null, text });
      continue;
    }
    for (const match of timestamps) {
      const milliseconds = Number((match[3] || "0").padEnd(3, "0"));
      entries.push({
        time: Number(match[1]) * 60 + Number(match[2]) + milliseconds / 1000,
        text,
      });
    }
  }
  return entries.sort((first, second) => (first.time ?? -1) - (second.time ?? -1));
}

function renderLyricsEntries() {
  const lines = document.querySelector("#lyrics-lines");
  lines.replaceChildren();
  if (!state.lyrics.length) {
    const empty = document.createElement("p");
    empty.className = "lyrics-empty";
    empty.textContent = "The selected lyrics file contains no readable lines.";
    lines.append(empty);
    return;
  }
  const entries = state.lyricsFirstLineOnly ? state.lyrics.slice(0, 1) : state.lyrics;
  entries.forEach((entry, index) => {
    const line = document.createElement("p");
    line.className = "lyric-line";
    line.dataset.index = String(state.lyricsFirstLineOnly ? 0 : index);
    line.textContent = entry.text;
    lines.append(line);
  });
  updateLyricHighlight(state.activeMedia.currentTime || 0);
}

function displayLyrics(raw, sourceName) {
  state.lyrics = parseLyrics(raw);
  state.activeLyricIndex = -1;
  document.querySelector("#lyrics-state").textContent = sourceName;
  renderLyricsEntries();
}

function setLyricsFirstLineOnly(enabled) {
  state.lyricsFirstLineOnly = enabled;
  state.activeLyricIndex = -1;
  renderLyricsEntries();
}

function updateLyricHighlight(currentTime) {
  let activeIndex = state.lyricsFirstLineOnly && state.lyrics.length ? 0 : -1;
  if (!state.lyricsFirstLineOnly) {
    for (let index = 0; index < state.lyrics.length; index += 1) {
      const lyric = state.lyrics[index];
      if (lyric.time === null) continue;
      if (lyric.time > currentTime) break;
      activeIndex = index;
    }
  }
  if (activeIndex === state.activeLyricIndex) return;
  state.activeLyricIndex = activeIndex;
  const lines = document.querySelectorAll(".lyric-line");
  lines.forEach((line) => {
    const active = Number(line.dataset.index) === activeIndex;
    line.classList.toggle("active", active);
    if (active) line.setAttribute("aria-current", "true");
    else line.removeAttribute("aria-current");
  });
  if (activeIndex >= 0 && !document.querySelector("#lyrics-panel").hidden) {
    lines[activeIndex]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

function clearTrackArtwork() {
  state.artworkRequest += 1;
  if (state.artworkObjectUrl) URL.revokeObjectURL(state.artworkObjectUrl);
  state.artworkObjectUrl = null;
  const image = document.querySelector("#album-artwork");
  image.removeAttribute("src");
  image.hidden = true;
  document.querySelector(".inspector-art").classList.remove("has-cover");
}

async function loadTrackArtwork(track) {
  clearTrackArtwork();
  if (!track?.id || track.objectUrl || track.kind === "text") return;
  const requestId = state.artworkRequest;
  try {
    const response = await fetch(`/api/artwork?id=${encodeURIComponent(track.id)}`, { cache: "force-cache" });
    if (!response.ok) return;
    const imageBlob = await response.blob();
    if (requestId !== state.artworkRequest || state.selectedTrack !== track) return;
    const imageUrl = URL.createObjectURL(imageBlob);
    const image = document.querySelector("#album-artwork");
    image.src = imageUrl;
    image.hidden = false;
    document.querySelector(".inspector-art").classList.add("has-cover");
    state.artworkObjectUrl = imageUrl;
  } catch {
    // Cover art is optional; keep the local graphic when the file has none.
  }
}

async function loadTrackLyrics(track) {
  const requestId = ++state.lyricsRequest;
  state.lyrics = [];
  state.activeLyricIndex = -1;
  document.querySelector("#lyrics-state").textContent = "Checking for local lyrics…";
  document.querySelector("#lyrics-lines").replaceChildren();
  try {
    const response = await fetch(`/api/lyrics?id=${encodeURIComponent(track.id)}`, { cache: "no-store" });
    const result = await response.json();
    if (requestId !== state.lyricsRequest) return;
    if (!response.ok) throw new Error(result.error || "Lyrics are unavailable.");
    displayLyrics(result.lyrics, `LOCAL FILE · ${result.name}`);
  } catch (error) {
    if (requestId !== state.lyricsRequest) return;
    document.querySelector("#lyrics-state").textContent = "NO LOCAL MATCH";
    const empty = document.createElement("p");
    empty.className = "lyrics-empty";
    empty.textContent = `${error.message}. Place a matching .lrc file next to the track or choose one with Upload files.`;
    document.querySelector("#lyrics-lines").replaceChildren(empty);
  }
}

function setLyricsPanel(open) {
  document.querySelector("#lyrics-panel").hidden = !open;
  const button = document.querySelector("#lyrics-toggle");
  button.setAttribute("aria-expanded", String(open));
  button.textContent = open ? "Hide lyrics" : "Show lyrics";
  if (open) updateLyricHighlight(state.activeMedia.currentTime || 0);
}

function setInspector(track) {
  state.selectedTrack = track;
  const extension = track ? fileExtension(track.name) : "";
  document.querySelector("#inspector-name").textContent = track?.name ?? "No file selected";
  document.querySelector("#inspector-type").textContent = track
    ? track.kind === "text"
      ? "Text file · read-only preview"
      : `${track.type === "video" ? "Video" : "Audio"} file · read-only media`
    : "Select a track or text file to inspect.";
  document.querySelector("#inspector-art-ext").textContent = extension ? extension.slice(1).toUpperCase() : "MP3";
  document.querySelector("#inspector-format").textContent = extension ? extension.slice(1).toUpperCase() : "—";
  document.querySelector("#inspector-size").textContent = track ? formatSize(track.size) : "—";
  document.querySelector("#inspector-duration").textContent = track?.duration ? formatTime(track.duration) : "—";
  document.querySelector("#inspector-modified").textContent = track?.modified
    ? new Date(track.modified * 1000).toLocaleDateString()
    : track?.file?.lastModified
      ? new Date(track.file.lastModified).toLocaleDateString()
      : "—";

  const preview = document.querySelector("#text-preview");
  if (track?.kind === "text") clearTrackArtwork();
  else loadTrackArtwork(track);
  if (track?.kind === "text") {
    track.file.text().then((text) => {
      if (state.selectedTrack === track) preview.value = text;
    });
  } else {
    preview.value = "";
  }
}

function updateCounts() {
  document.querySelector("#track-count").textContent = String(state.tracks.length).padStart(2, "0");
  document.querySelector("#visible-count").textContent = String(state.tracks.length).padStart(2, "0");
  document.querySelector("#empty-state").hidden = state.tracks.length > 0;
}

function renderTracks() {
  const query = trackSearch.value.trim().toLocaleLowerCase();
  const matches = state.tracks
    .map((track, index) => ({ track, index }))
    .filter(({ track }) => track.name.toLocaleLowerCase().includes(query));
  trackList.replaceChildren();

  for (const { track, index } of matches) {
    const row = document.createElement("li");
    row.className = "track-row";
    row.setAttribute("aria-current", index === state.currentIndex ? "true" : "false");

    const titleCell = document.createElement("button");
    titleCell.className = "track-name-cell track-select";
    titleCell.type = "button";
    titleCell.setAttribute("aria-label", `Play ${track.name}`);
    const number = document.createElement("span");
    number.className = "track-number";
    number.textContent = String(index + 1).padStart(2, "0");
    const name = document.createElement("span");
    name.className = "track-name";
    name.textContent = track.name;
    titleCell.append(number, name);

    const format = document.createElement("span");
    format.className = "track-format";
    format.textContent = fileExtension(track.name).slice(1) || "MEDIA";
    const size = document.createElement("span");
    size.className = "track-size";
    size.textContent = formatSize(track.size);
    const download = document.createElement("a");
    download.className = "track-download";
    download.href = `/api/download?id=${encodeURIComponent(track.id)}`;
    download.download = track.name;
    download.textContent = "↓";
    download.title = `Download ${track.name}`;
    download.setAttribute("aria-label", `Download ${track.name}`);
    const more = document.createElement("button");
    more.className = "track-more";
    more.type = "button";
    more.textContent = "···";
    more.setAttribute("aria-label", `Inspect ${track.name}`);
    more.addEventListener("click", () => {
      setInspector(track);
      if (window.innerWidth <= 860) toggleInspector(true);
    });

    row.append(titleCell, format, size, download, more);
    titleCell.addEventListener("click", () => playTrack(index));
    trackList.append(row);
  }

  document.querySelector("#visible-count").textContent = `${matches.length}/${state.tracks.length}`;
  document.querySelector("#empty-state").hidden = state.tracks.length > 0;
  if (state.tracks.length && matches.length === 0) {
    const noMatches = document.createElement("li");
    noMatches.className = "quiet-message";
    noMatches.textContent = "No tracks match that search.";
    trackList.append(noMatches);
  }
}

function readLocalPlaylists() {
  try {
    const stored = JSON.parse(localStorage.getItem("musicPlayer.localPlaylists") || "[]");
    if (!Array.isArray(stored)) return [];
    return stored.filter((playlist) => playlist
      && typeof playlist.id === "string"
      && typeof playlist.name === "string"
      && Array.isArray(playlist.trackIds))
      .slice(0, 100)
      .map((playlist) => ({
        id: playlist.id.slice(0, 80),
        name: playlist.name.slice(0, 60),
        trackIds: [...new Set(playlist.trackIds.filter((id) => typeof id === "string"))].slice(0, 1000),
      }));
  } catch {
    return [];
  }
}

function initializeLocalPlaylists() {
  state.playlists = readLocalPlaylists();
  try {
    const activeId = localStorage.getItem("musicPlayer.activePlaylistId");
    state.activePlaylistId = state.playlists.some((playlist) => playlist.id === activeId) ? activeId : null;
  } catch {
    state.activePlaylistId = null;
  }
  renderLocalPlaylists();
}

function saveLocalPlaylists() {
  try {
    localStorage.setItem("musicPlayer.localPlaylists", JSON.stringify(state.playlists));
    localStorage.setItem("musicPlayer.activePlaylistId", state.activePlaylistId || "");
  } catch {
    document.querySelector("#local-playlist-status").textContent = "Could not save playlists in local storage.";
    return false;
  }
  renderLocalPlaylists();
  return true;
}

function renderLocalPlaylists() {
  const select = document.querySelector("#local-playlist-select");
  const tracksList = document.querySelector("#local-playlist-tracks");
  const count = document.querySelector("#local-playlist-count");
  const active = state.playlists.find((playlist) => playlist.id === state.activePlaylistId);
  count.textContent = String(state.playlists.length).padStart(2, "0");
  select.replaceChildren(new Option("Select playlist", ""));
  for (const playlist of state.playlists) select.append(new Option(playlist.name, playlist.id));
  select.value = active?.id || "";
  tracksList.replaceChildren();
  document.querySelector("#local-playlist-delete").disabled = !active;
  document.querySelector("#local-playlist-add-current").disabled = !active || state.currentIndex < 0;
  if (!active) {
    const empty = document.createElement("li");
    empty.className = "task-empty";
    empty.textContent = "Choose or create a playlist.";
    tracksList.append(empty);
    return;
  }
  const playlistTracks = active.trackIds
    .map((id) => state.tracks.find((track) => track.id === id))
    .filter(Boolean);
  if (!playlistTracks.length) {
    const empty = document.createElement("li");
    empty.className = "task-empty";
    empty.textContent = "This playlist is empty. Play a track, then choose Add current.";
    tracksList.append(empty);
    return;
  }
  playlistTracks.forEach((track, index) => {
    const row = document.createElement("li");
    row.className = "local-playlist-track";
    row.draggable = true;
    row.dataset.trackId = track.id;
    row.addEventListener("dragstart", () => {
      state.draggedPlaylistIndex = index;
      row.classList.add("dragging");
    });
    row.addEventListener("dragend", () => {
      state.draggedPlaylistIndex = -1;
      row.classList.remove("dragging");
    });
    row.addEventListener("dragover", (event) => event.preventDefault());
    row.addEventListener("drop", (event) => {
      event.preventDefault();
      movePlaylistTrack(state.draggedPlaylistIndex, index);
    });

    const grip = document.createElement("span");
    grip.className = "playlist-grip";
    grip.textContent = "⋮⋮";
    grip.setAttribute("aria-hidden", "true");
    const play = document.createElement("button");
    play.className = "playlist-track-name";
    play.type = "button";
    play.textContent = track.name;
    play.addEventListener("click", () => {
      const currentIndex = state.tracks.findIndex((item) => item.id === track.id);
      if (currentIndex >= 0) playTrack(currentIndex);
    });
    const number = document.createElement("span");
    number.className = "playlist-track-index";
    number.textContent = String(index + 1).padStart(2, "0");
    const actions = document.createElement("div");
    actions.className = "playlist-track-actions";
    for (const [direction, label, title] of [[-1, "↑", "Move up"], [1, "↓", "Move down"]]) {
      const move = document.createElement("button");
      move.className = "playlist-track-move";
      move.type = "button";
      move.textContent = label;
      move.title = title;
      move.setAttribute("aria-label", `${title} ${track.name}`);
      move.disabled = direction < 0 ? index === 0 : index === playlistTracks.length - 1;
      move.addEventListener("click", () => movePlaylistTrack(index, index + direction));
      actions.append(move);
    }
    const remove = document.createElement("button");
    remove.className = "playlist-track-remove";
    remove.type = "button";
    remove.textContent = "×";
    remove.title = "Remove from playlist";
    remove.setAttribute("aria-label", `Remove ${track.name} from playlist`);
    remove.addEventListener("click", () => removePlaylistTrack(track.id));
    actions.append(remove);
    row.append(grip, play, number, actions);
    tracksList.append(row);
  });
}

function createLocalPlaylist() {
  const input = document.querySelector("#local-playlist-name");
  const name = input.value.trim().slice(0, 60);
  if (!name) {
    document.querySelector("#local-playlist-status").textContent = "Enter a playlist name.";
    return;
  }
  const playlist = { id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`, name, trackIds: [] };
  state.playlists.push(playlist);
  state.activePlaylistId = playlist.id;
  input.value = "";
  document.querySelector("#local-playlist-status").textContent = `Created ${name}.`;
  saveLocalPlaylists();
}

function selectLocalPlaylist(id) {
  state.activePlaylistId = state.playlists.some((playlist) => playlist.id === id) ? id : null;
  saveLocalPlaylists();
}

function addCurrentTrackToPlaylist() {
  const playlist = state.playlists.find((item) => item.id === state.activePlaylistId);
  const track = state.tracks[state.currentIndex];
  if (!playlist || !track) {
    document.querySelector("#local-playlist-status").textContent = "Choose a playlist and play a local track first.";
    return;
  }
  if (!playlist.trackIds.includes(track.id)) playlist.trackIds.push(track.id);
  document.querySelector("#local-playlist-status").textContent = `Added ${track.name}.`;
  saveLocalPlaylists();
}

function deleteLocalPlaylist() {
  const playlist = state.playlists.find((item) => item.id === state.activePlaylistId);
  if (!playlist || !window.confirm(`Delete playlist “${playlist.name}”? Your music files will not be deleted.`)) return;
  state.playlists = state.playlists.filter((item) => item.id !== playlist.id);
  state.activePlaylistId = null;
  document.querySelector("#local-playlist-status").textContent = `Deleted ${playlist.name}.`;
  saveLocalPlaylists();
}

function movePlaylistTrack(fromIndex, toIndex) {
  const playlist = state.playlists.find((item) => item.id === state.activePlaylistId);
  if (!playlist || fromIndex < 0 || toIndex < 0 || fromIndex >= playlist.trackIds.length || toIndex >= playlist.trackIds.length || fromIndex === toIndex) return;
  const [trackId] = playlist.trackIds.splice(fromIndex, 1);
  playlist.trackIds.splice(toIndex, 0, trackId);
  saveLocalPlaylists();
}

function removePlaylistTrack(trackId) {
  const playlist = state.playlists.find((item) => item.id === state.activePlaylistId);
  if (!playlist) return;
  playlist.trackIds = playlist.trackIds.filter((id) => id !== trackId);
  saveLocalPlaylists();
}

function trackUrl(track) {
  if (track.objectUrl) return track.objectUrl;
  return `/api/media?id=${encodeURIComponent(track.id)}`;
}

function sendDesktopEvent(event, track) {
  fetch("/api/desktop-event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event, track }),
  }).catch(() => {});
}

function selectMediaElement(track, { preservePrevious = false } = {}) {
  const nextMedia = track.type === "video"
    ? videoPlayer
    : state.lastAudioMedia === audioPlayer ? nextAudioPlayer : audioPlayer;
  const previousMedia = state.activeMedia;
  if (previousMedia !== nextMedia && !preservePrevious) {
    previousMedia.pause();
    previousMedia.removeAttribute("src");
    previousMedia.load();
    if (previousMedia === audioPlayer || previousMedia === nextAudioPlayer) previousMedia.volume = 1;
  }
  if (track.type !== "video") state.lastAudioMedia = nextMedia;
  state.activeMedia = nextMedia;
  videoPlayer.hidden = nextMedia !== videoPlayer;
  audioPlayer.hidden = nextMedia !== audioPlayer;
  nextAudioPlayer.hidden = nextMedia !== nextAudioPlayer;
  return nextMedia;
}

function isLocalAudioPlayer(player) {
  return player === audioPlayer || player === nextAudioPlayer;
}

function cancelCrossfade() {
  if (state.crossfadeTimer) window.clearInterval(state.crossfadeTimer);
  state.crossfadeTimer = null;
  const fadingFrom = state.crossfadeFrom;
  state.crossfadeFrom = null;
  state.crossfadeTriggered = false;
  if (fadingFrom && fadingFrom !== state.activeMedia) {
    fadingFrom.pause();
    fadingFrom.removeAttribute("src");
    fadingFrom.load();
    fadingFrom.volume = 1;
  }
  if (isLocalAudioPlayer(state.activeMedia)) state.activeMedia.volume = 1;
}

function startCrossfade(fromPlayer, toPlayer, durationSeconds) {
  const startedAt = performance.now();
  const durationMs = Math.max(150, durationSeconds * 1000);
  state.crossfadeFrom = fromPlayer;
  state.crossfadeTimer = window.setInterval(() => {
    if (state.activeMedia !== toPlayer) {
      cancelCrossfade();
      return;
    }
    const progress = Math.min((performance.now() - startedAt) / durationMs, 1);
    fromPlayer.volume = 1 - progress;
    toPlayer.volume = progress;
    if (progress >= 1) {
      window.clearInterval(state.crossfadeTimer);
      state.crossfadeTimer = null;
      fromPlayer.pause();
      fromPlayer.removeAttribute("src");
      fromPlayer.load();
      fromPlayer.volume = 1;
      toPlayer.volume = 1;
      state.crossfadeFrom = null;
      state.crossfadeTriggered = false;
    }
  }, 40);
}

function playTrack(index, options = {}) {
  const track = state.tracks[index];
  if (!track) return;
  if (state.crossfadeTimer) cancelCrossfade();
  let crossfadeFrom = options.crossfadeFrom;
  const fadeSeconds = Math.max(0, Number(options.fadeSeconds) || state.crossfadeSeconds);
  if (track.type !== "audio" || !isLocalAudioPlayer(crossfadeFrom) || crossfadeFrom.paused || fadeSeconds <= 0) {
    crossfadeFrom = null;
  }
  state.currentIndex = index;
  state.crossfadeTriggered = Boolean(crossfadeFrom);
  setInspector(track);
  const player = selectMediaElement(track, { preservePrevious: Boolean(crossfadeFrom) });
  player.volume = crossfadeFrom ? 0 : 1;
  player.src = trackUrl(track);
  player.load();
  document.querySelector("#current-title").textContent = track.name;
  document.querySelector("#current-subtitle").textContent = `${track.type === "video" ? "VIDEO" : "LOCAL FILE"} · ${formatSize(track.size)}`;
  document.querySelector("#track-extension").textContent = fileExtension(track.name).slice(1).toUpperCase();
  document.querySelector("#playback-status").textContent = "LOADING YOUR TRACK";
  document.querySelector("#seek-slider").value = "0";
  document.querySelector("#elapsed-time").textContent = "0:00";
  document.querySelector("#duration-time").textContent = "0:00";
  renderTracks();
  loadTrackLyrics(track);
  if (window.innerWidth <= 860) toggleInspector(false);
  player.play().then(() => {
    ensureAudioGraph();
    if (crossfadeFrom && state.activeMedia === player) startCrossfade(crossfadeFrom, player, fadeSeconds);
  }).catch(() => {
    if (crossfadeFrom) {
      crossfadeFrom.volume = 1;
      crossfadeFrom.play().catch(() => {});
    }
    player.volume = 1;
    document.querySelector("#playback-status").textContent = "READY · PRESS PLAY";
    document.querySelector("#play-button").innerHTML = 'PLAY <span aria-hidden="true">▶</span>';
  });
}

function currentPlaylistIndexStep(direction) {
  const activePlaylist = state.playlists.find((playlist) => playlist.id === state.activePlaylistId);
  const playlistIndices = activePlaylist
    ? activePlaylist.trackIds.map((id) => state.tracks.findIndex((track) => track.id === id)).filter((index) => index >= 0)
    : [];
  const order = playlistIndices.length ? playlistIndices : state.tracks.map((_, index) => index);
  if (!order.length) return -1;
  const currentOrderIndex = order.indexOf(state.currentIndex);
  if (state.shuffle && order.length > 1) {
    let nextOrderIndex = currentOrderIndex;
    while (nextOrderIndex === currentOrderIndex) nextOrderIndex = Math.floor(Math.random() * order.length);
    return order[nextOrderIndex];
  }
  if (currentOrderIndex < 0) return direction > 0 ? order[0] : order[order.length - 1];
  return order[(currentOrderIndex + direction + order.length) % order.length];
}

function playNext(direction = 1) {
  const index = currentPlaylistIndexStep(direction);
  if (index < 0) return;
  const currentPlayer = state.activeMedia;
  const duration = Number.isFinite(currentPlayer.duration) ? Math.min(state.crossfadeSeconds, currentPlayer.duration / 2) : state.crossfadeSeconds;
  const crossfadeFrom = direction > 0 && state.crossfadeSeconds > 0 && isLocalAudioPlayer(currentPlayer) && !currentPlayer.paused
    ? currentPlayer
    : null;
  playTrack(index, { crossfadeFrom, fadeSeconds: duration });
}

function initializeCrossfadeSettings() {
  const control = document.querySelector("#crossfade-seconds");
  try {
    const savedSeconds = Number(localStorage.getItem("musicPlayer.crossfadeSeconds"));
    if ([0, 2, 4, 6, 8].includes(savedSeconds)) state.crossfadeSeconds = savedSeconds;
  } catch {
    state.crossfadeSeconds = 0;
  }
  control.value = String(state.crossfadeSeconds);
}

function setCrossfadeDuration() {
  state.crossfadeSeconds = Number(document.querySelector("#crossfade-seconds").value) || 0;
  try {
    localStorage.setItem("musicPlayer.crossfadeSeconds", String(state.crossfadeSeconds));
  } catch {
    // Crossfade remains enabled for this session if storage is unavailable.
  }
}

const allowedShortcutCodes = {
  play: ["Space", "KeyK", "KeyL"],
  next: ["ArrowRight", "KeyN", "KeyJ"],
  previous: ["ArrowLeft", "KeyP", "KeyH"],
};

function initializePlayerShortcuts() {
  try {
    const saved = JSON.parse(localStorage.getItem("musicPlayer.shortcuts") || "null");
    if (saved && Object.entries(allowedShortcutCodes).every(([action, options]) => options.includes(saved[action]))) {
      state.shortcuts = { play: saved.play, next: saved.next, previous: saved.previous };
    }
  } catch {
    // Keep default shortcuts when saved data is invalid.
  }
  for (const action of Object.keys(allowedShortcutCodes)) {
    document.querySelector(`#shortcut-${action}`).value = state.shortcuts[action];
  }
}

function setPlayerShortcuts() {
  const nextShortcuts = Object.fromEntries(Object.keys(allowedShortcutCodes).map((action) => [
    action,
    document.querySelector(`#shortcut-${action}`).value,
  ]));
  const values = Object.values(nextShortcuts);
  const unique = new Set(values);
  const status = document.querySelector("#shortcut-status");
  if (unique.size !== values.length || Object.entries(nextShortcuts).some(([action, code]) => !allowedShortcutCodes[action].includes(code))) {
    status.textContent = "Each action needs a different valid key.";
    for (const action of Object.keys(state.shortcuts)) document.querySelector(`#shortcut-${action}`).value = state.shortcuts[action];
    return;
  }
  state.shortcuts = nextShortcuts;
  try {
    localStorage.setItem("musicPlayer.shortcuts", JSON.stringify(state.shortcuts));
  } catch {
    status.textContent = "Shortcuts apply for this session but could not be saved.";
    return;
  }
  status.textContent = "Shortcuts saved.";
}

const equalizerPresetValues = {
  flat: [0, 0, 0, 0, 0],
  bass: [6, 4, 1, 0, -1],
  vocal: [-2, 0, 4, 3, 0],
  treble: [-2, -1, 0, 4, 6],
};
const equalizerControlIds = ["eq-60", "eq-250", "eq-1000", "eq-4000", "eq-12000"];

function saveEqualizerSettings() {
  try {
    localStorage.setItem("musicPlayer.equalizer", JSON.stringify({ preset: state.eqPreset, gains: state.eqGains }));
  } catch {
    // Equalizer changes remain active for this session if storage is unavailable.
  }
}

function renderEqualizerControls() {
  equalizerControlIds.forEach((id, index) => {
    const control = document.querySelector(`#${id}`);
    control.value = String(state.eqGains[index]);
    control.parentElement.querySelector("output").textContent = `${state.eqGains[index]} dB`;
  });
  document.querySelector("#equalizer-preset").value = state.eqPreset;
  state.eqFilters.forEach((filter, index) => {
    filter.gain.value = state.eqGains[index];
  });
}

function initializeEqualizerSettings() {
  try {
    const settings = JSON.parse(localStorage.getItem("musicPlayer.equalizer") || "null");
    if (settings && Array.isArray(settings.gains) && settings.gains.length === 5
      && settings.gains.every((gain) => Number.isFinite(gain) && gain >= -12 && gain <= 12)) {
      state.eqGains = settings.gains.map((gain) => Math.round(gain));
      state.eqPreset = ["flat", "bass", "vocal", "treble", "custom"].includes(settings.preset) ? settings.preset : "custom";
    }
  } catch {
    // Use the flat equalizer when saved settings are invalid or unavailable.
  }
  renderEqualizerControls();
}

function setEqualizerBand(index, value) {
  state.eqGains[index] = Math.max(-12, Math.min(12, Number(value) || 0));
  state.eqPreset = "custom";
  renderEqualizerControls();
  saveEqualizerSettings();
}

function setEqualizerPreset(preset) {
  if (preset === "custom") return;
  state.eqGains = [...(equalizerPresetValues[preset] || equalizerPresetValues.flat)];
  state.eqPreset = preset in equalizerPresetValues ? preset : "flat";
  renderEqualizerControls();
  saveEqualizerSettings();
}

function togglePlayback() {
  const player = state.activeMedia;
  if (!player.src) {
    if (state.tracks.length) playTrack(0);
    return;
  }
  if (player.paused) {
    player.play().then(ensureAudioGraph).catch(() => {
      document.querySelector("#playback-status").textContent = "CANNOT PLAY THIS FORMAT";
    });
  } else {
    player.pause();
  }
}

function toggleInspector(open = !state.inspectorOpen) {
  state.inspectorOpen = open;
  const narrowLayout = window.innerWidth <= 860;
  const panel = document.querySelector("#inspector-panel");
  const layout = document.querySelector(".layout");
  panel.classList.toggle("open", open && narrowLayout);
  panel.classList.toggle("closed", !open && !narrowLayout);
  layout.classList.toggle("inspector-closed", !open && !narrowLayout);
  document.querySelector("#inspector-toggle").setAttribute("aria-pressed", String(open));
}

function uploadMediaFile(file, progressElement) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", `/api/upload?name=${encodeURIComponent(file.name)}`);
    request.setRequestHeader("Content-Type", "application/octet-stream");
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) progressElement.value = Math.round(event.loaded / event.total * 100);
    });
    request.addEventListener("load", () => {
      let result;
      try {
        result = JSON.parse(request.responseText);
      } catch {
        reject(new Error("The server returned an invalid upload response."));
        return;
      }
      if (request.status !== 201) {
        reject(new Error(result.error || "Upload failed."));
        return;
      }
      resolve(result.track);
    });
    request.addEventListener("error", () => reject(new Error("Upload failed. Check that the player is still running.")));
    request.send(file);
  });
}

async function addImportedFiles(files) {
  const selectedFiles = Array.from(files);
  const progress = document.querySelector("#upload-progress");
  let uploadedCount = 0;
  const failures = [];

  for (const file of selectedFiles) {
    const extension = fileExtension(file.name);
    if (textExtensions.has(extension)) {
      setInspector({ name: file.name, size: file.size, file, kind: "text" });
      if (extension === ".lrc") {
        const requestId = ++state.lyricsRequest;
        const lyrics = await file.text();
        if (requestId === state.lyricsRequest) {
          displayLyrics(lyrics, `LOCAL FILE · ${file.name}`);
          setLyricsPanel(true);
        }
      }
      if (window.innerWidth <= 860) toggleInspector(true);
      continue;
    }
    if (!mediaExtensions.has(extension)) {
      failures.push(`${file.name}: unsupported format`);
      continue;
    }

    progress.hidden = false;
    progress.value = 0;
    document.querySelector("#library-note").textContent = `Uploading ${file.name}…`;
    try {
      await uploadMediaFile(file, progress);
      uploadedCount += 1;
    } catch (error) {
      failures.push(`${file.name}: ${error.message}`);
    }
  }

  progress.hidden = true;
  progress.value = 0;
  if (uploadedCount) await loadLibrary();
  const summary = `${uploadedCount} file${uploadedCount === 1 ? "" : "s"} saved to your Music.Player library.`;
  document.querySelector("#library-note").textContent = failures.length
    ? `${summary} ${failures.join("; ")}`
    : uploadedCount
      ? summary
      : "Choose audio or video files to add them to your library.";
}

async function loadLibrary() {
  try {
    const currentTrackId = state.tracks[state.currentIndex]?.id;
    const response = await fetch("/api/tracks", { cache: "no-store" });
    if (!response.ok) throw new Error("Could not read the local library");
    const result = await response.json();
    state.tracks = result.tracks;
    state.currentIndex = currentTrackId ? state.tracks.findIndex((track) => track.id === currentTrackId) : -1;
    updateCounts();
    renderTracks();
    renderLocalPlaylists();
    document.querySelector("#library-note").textContent = state.tracks.length
      ? `${state.tracks.length} media file${state.tracks.length === 1 ? "" : "s"} found.`
      : "No media yet. Add files or open a media folder.";
    document.querySelector("#port-label").textContent = window.location.port ? `PORT ${window.location.port}` : "LOCALHOST";
    document.querySelector("#library-path").textContent = "LOCAL FILES · READ ONLY";
  } catch (error) {
    document.querySelector("#library-note").textContent = error.message;
    document.querySelector("#playback-status").textContent = "LIBRARY UNAVAILABLE";
  }
}

function startDevAutoRefresh() {
  let version = null;
  let checking = false;
  const checkVersion = async () => {
    if (checking || document.visibilityState === "hidden") return;
    checking = true;
    try {
      const response = await fetch("/api/dev-version", { cache: "no-store" });
      if (!response.ok) return;
      const result = await response.json();
      if (!result.enabled) {
        window.clearInterval(timer);
        return;
      }
      if (version === null) {
        version = result.version;
      } else if (result.version !== version) {
        document.querySelector("#playback-status").textContent = "Code changed · refreshing player";
        window.location.reload();
      }
    } catch {
      // The local server may restart while a source change is being applied.
    } finally {
      checking = false;
    }
  };
  const timer = window.setInterval(checkVersion, 1200);
  const initialCheck = checkVersion();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") checkVersion();
  });
  return { checkVersion, initialCheck };
}

async function findDuplicateFiles() {
  const button = document.querySelector("#find-duplicates");
  const panel = document.querySelector("#duplicate-panel");
  const status = document.querySelector("#duplicate-status");
  const results = document.querySelector("#duplicate-results");
  panel.hidden = false;
  button.disabled = true;
  status.textContent = "Checking local files for identical content…";
  results.replaceChildren();
  try {
    const response = await fetch("/api/duplicates", { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Duplicate scan failed.");
    if (!payload.groups.length) {
      status.textContent = "No identical files found.";
      return;
    }
    status.textContent = `Found ${payload.groups.length} groups of identical files.`;
    for (const group of payload.groups) {
      const section = document.createElement("article");
      section.className = "duplicate-group";
      const heading = document.createElement("div");
      heading.className = "duplicate-group-title";
      heading.textContent = `${group.tracks.length} identical files · ${formatSize(group.size)} each`;
      section.append(heading);
      for (const track of group.tracks) {
        const row = document.createElement("div");
        row.className = "duplicate-file-row";
        const name = document.createElement("span");
        name.className = "duplicate-file-name";
        name.textContent = track.name;
        const size = document.createElement("span");
        size.className = "duplicate-file-size";
        size.textContent = formatSize(track.size);
        const play = document.createElement("button");
        play.className = "duplicate-play";
        play.type = "button";
        play.textContent = "▶";
        play.title = `Play ${track.name}`;
        play.setAttribute("aria-label", `Play ${track.name}`);
        play.addEventListener("click", () => {
          const index = state.tracks.findIndex((item) => item.id === track.id);
          if (index >= 0) playTrack(index);
        });
        row.append(name, size, play);
        section.append(row);
      }
      results.append(section);
    }
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

function activateView(name) {
  for (const panel of document.querySelectorAll(".view-panel")) panel.hidden = panel.id !== `view-${name}`;
  if (name === "youtube") initializeYoutubePlayer();
  for (const button of document.querySelectorAll(".nav-item")) {
    const active = button.dataset.view === name;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
}

function parseYoutubeSelection(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  if (!["https:", "http:"].includes(url.protocol)) return null;

  const host = url.hostname.toLowerCase();
  let videoId = null;
  let playlistId = null;
  if (host === "youtu.be") {
    videoId = url.pathname.split("/").filter(Boolean)[0];
  } else if (["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com"].includes(host)) {
    if (url.pathname === "/watch") videoId = url.searchParams.get("v");
    else if (/^\/(embed|shorts|live)\//.test(url.pathname)) videoId = url.pathname.split("/")[2];
  }
  if (["youtu.be", "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com"].includes(host)) {
    playlistId = url.searchParams.get("list");
  }
  const validVideoId = videoId && youtubeVideoIdPattern.test(videoId) ? videoId : null;
  const validPlaylistId = playlistId && youtubePlaylistIdPattern.test(playlistId) ? playlistId : null;
  if ((videoId && !validVideoId) || (playlistId && !validPlaylistId) || (!validVideoId && !validPlaylistId)) return null;
  return { videoId: validVideoId, playlistId: validPlaylistId };
}

function isValidYoutubeSelection(selection) {
  return Boolean(
    selection
    && ((selection.videoId && youtubeVideoIdPattern.test(selection.videoId))
      || (selection.playlistId && youtubePlaylistIdPattern.test(selection.playlistId)))
    && (!selection.videoId || youtubeVideoIdPattern.test(selection.videoId))
    && (!selection.playlistId || youtubePlaylistIdPattern.test(selection.playlistId)),
  );
}

let currentYoutubeSelection = { videoId: defaultYoutubeVideoId, playlistId: null };
let youtubePlayer = null;
let youtubePlayerReady = false;
let youtubeApiLoading = null;
let youtubeQueueAutoplayRequested = false;
let youtubePipWindow = null;
let youtubePipPlaceholder = null;

function youtubeEmbedUrl(selection) {
  const path = selection.videoId ? `/embed/${selection.videoId}` : "/embed/videoseries";
  const parameters = new URLSearchParams({
    rel: "0",
    enablejsapi: "1",
    origin: window.location.origin,
    widget_referrer: window.location.href,
  });
  if (selection.playlistId) parameters.set("list", selection.playlistId);
  return `https://www.youtube-nocookie.com${path}?${parameters}`;
}

function youtubeCanonicalUrl(selection) {
  if (!selection.videoId) return `https://www.youtube.com/playlist?list=${encodeURIComponent(selection.playlistId)}`;
  const url = new URL("https://www.youtube.com/watch");
  url.searchParams.set("v", selection.videoId);
  if (selection.playlistId) url.searchParams.set("list", selection.playlistId);
  return url.toString();
}

function loadYoutubeIframeApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (youtubeApiLoading) return youtubeApiLoading;
  youtubeApiLoading = new Promise((resolve, reject) => {
    const previousCallback = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof previousCallback === "function") previousCallback();
      resolve(window.YT);
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.async = true;
    script.onerror = () => reject(new Error("YouTube player controls are unavailable."));
    document.head.append(script);
  });
  return youtubeApiLoading;
}

function applyYoutubePlaybackSpeed() {
  if (!youtubePlayerReady) return;
  const requestedSpeed = Number(document.querySelector("#youtube-playback-speed").value);
  try {
    const rates = youtubePlayer.getAvailablePlaybackRates();
    if (rates.includes(requestedSpeed)) youtubePlayer.setPlaybackRate(requestedSpeed);
    else document.querySelector("#youtube-status").textContent = "This video does not support that playback speed.";
  } catch {
    document.querySelector("#youtube-status").textContent = "Playback speed is not available for this video.";
  }
}

function initializeYoutubePlayer() {
  loadYoutubeIframeApi().then((youtubeApi) => {
    if (youtubePlayer) return;
    youtubePlayer = new youtubeApi.Player("youtube-embed", {
      events: {
        onReady: () => {
          youtubePlayerReady = true;
          applyYoutubePlaybackSpeed();
          if (youtubeQueueAutoplayRequested) {
            youtubeQueueAutoplayRequested = false;
            updateYoutubeEmbed(currentYoutubeSelection, true, true);
          }
        },
        onStateChange: (event) => {
          if (event.data === youtubeApi.PlayerState.PLAYING) applyYoutubePlaybackSpeed();
          else if (event.data === youtubeApi.PlayerState.ENDED) advanceYoutubeQueue();
        },
        onError: (event) => {
          const messages = {
            2: "The YouTube video or playlist ID is invalid.",
            5: "The embedded HTML5 player could not play this video.",
            100: "This YouTube video is unavailable or private.",
            101: "The video owner does not allow embedded playback.",
            150: "The video owner does not allow embedded playback.",
            153: "YouTube did not receive a valid referrer. Restart Music.Player and update WebView2, or open the video directly on YouTube.",
          };
          const status = document.querySelector("#youtube-status");
          status.dataset.state = "error";
          status.textContent = `YouTube player error ${event.data}: ${messages[event.data] || "Playback is unavailable for this video."}`;
        },
      },
    });
  }).catch((error) => {
    document.querySelector("#youtube-status").textContent = error.message;
  });
}

function setYoutubePlaybackSpeed() {
  const speed = Number(document.querySelector("#youtube-playback-speed").value);
  try {
    localStorage.setItem("musicPlayer.youtubePlaybackSpeed", String(speed));
  } catch {
    // Speed changes still apply for this session if storage is unavailable.
  }
  applyYoutubePlaybackSpeed();
}

function updateYoutubeEmbed(selection, persist = true, playNow = false) {
  if (!isValidYoutubeSelection(selection)) return false;
  currentYoutubeSelection = { videoId: selection.videoId || null, playlistId: selection.playlistId || null };
  if (youtubePlayerReady) {
    if (currentYoutubeSelection.playlistId) {
      const method = playNow ? "loadPlaylist" : "cuePlaylist";
      youtubePlayer[method]({ list: currentYoutubeSelection.playlistId, listType: "playlist", index: 0 });
    } else if (currentYoutubeSelection.videoId) {
      const method = playNow ? "loadVideoById" : "cueVideoById";
      youtubePlayer[method](currentYoutubeSelection.videoId);
    }
  } else {
    document.querySelector("#youtube-embed").src = youtubeEmbedUrl(currentYoutubeSelection);
  }
  document.querySelector("#youtube-open-link").href = youtubeCanonicalUrl(currentYoutubeSelection);
  if (persist) {
    try {
      localStorage.setItem("musicPlayer.youtubeSelection", JSON.stringify(currentYoutubeSelection));
    } catch {
      // Storage can be disabled by the embedded runtime.
    }
  }
  return true;
}

function initializeYoutubeEmbed() {
  let selection = { videoId: defaultYoutubeVideoId, playlistId: null };
  try {
    const savedSelection = JSON.parse(localStorage.getItem("musicPlayer.youtubeSelection"));
    if (isValidYoutubeSelection(savedSelection)) selection = savedSelection;
    else {
      const savedVideoId = localStorage.getItem("musicPlayer.youtubeVideoId");
      if (savedVideoId && youtubeVideoIdPattern.test(savedVideoId)) selection = { videoId: savedVideoId, playlistId: null };
    }
  } catch {
    // Keep the configured default when storage is unavailable.
  }
  try {
    const savedSpeed = Number(localStorage.getItem("musicPlayer.youtubePlaybackSpeed"));
    const speedSelect = document.querySelector("#youtube-playback-speed");
    if ([...speedSelect.options].some((option) => Number(option.value) === savedSpeed)) speedSelect.value = String(savedSpeed);
  } catch {
    // Keep normal speed when storage is unavailable.
  }
  updateYoutubeEmbed(selection, false);
  renderYoutubeFavorites();
  renderYoutubeQueue();
  document.querySelector("#youtube-status").textContent = selection.videoId === defaultYoutubeVideoId && !selection.playlistId
    ? "Showing your default video."
    : "Showing your saved selection.";
}

function handleYoutubeSubmit(event) {
  event.preventDefault();
  const input = document.querySelector("#youtube-url");
  const status = document.querySelector("#youtube-status");
  const selection = parseYoutubeSelection(input.value);
  if (!selection) {
    status.dataset.state = "error";
    status.textContent = "Enter a valid YouTube video, Shorts, embed, or playlist link.";
    return;
  }
  currentYoutubeQueueItemId = null;
  youtubeQueueAutoplayRequested = false;
  updateYoutubeEmbed(selection);
  renderYoutubeQueue();
  status.dataset.state = "success";
  status.textContent = "Embedded. Playback follows YouTube availability and settings.";
}

function resetYoutubeEmbed() {
  try {
    localStorage.removeItem("musicPlayer.youtubeVideoId");
    localStorage.removeItem("musicPlayer.youtubeSelection");
  } catch {
    // The configured default is still restored for this session.
  }
  document.querySelector("#youtube-url").value = "";
  currentYoutubeQueueItemId = null;
  youtubeQueueAutoplayRequested = false;
  updateYoutubeEmbed({ videoId: defaultYoutubeVideoId, playlistId: null }, false);
  renderYoutubeQueue();
  const status = document.querySelector("#youtube-status");
  status.dataset.state = "";
  status.textContent = "Showing your default video.";
}

function readYoutubeFavorites() {
  try {
    const favorites = JSON.parse(localStorage.getItem("musicPlayer.youtubeFavorites") || "[]");
    if (!Array.isArray(favorites)) return [];
    return favorites
      .filter((favorite) => favorite && isValidYoutubeSelection(favorite.selection) && typeof favorite.name === "string")
      .slice(0, 40)
      .map((favorite) => ({
        name: favorite.name.slice(0, 80),
        tag: typeof favorite.tag === "string" ? favorite.tag.slice(0, 32) : "",
        selection: { videoId: favorite.selection.videoId || null, playlistId: favorite.selection.playlistId || null },
      }));
  } catch {
    return [];
  }
}

function renderYoutubeFavorites() {
  const favorites = readYoutubeFavorites();
  const list = document.querySelector("#youtube-favorite-list");
  const filter = document.querySelector("#youtube-favorite-filter");
  const selectedTag = filter.value;
  const tags = [...new Set(favorites.map((favorite) => favorite.tag).filter(Boolean))].sort((first, second) => first.localeCompare(second));
  filter.replaceChildren(new Option("All tags", ""));
  for (const tag of tags) filter.append(new Option(tag, tag));
  filter.value = tags.includes(selectedTag) ? selectedTag : "";
  const visibleFavorites = filter.value ? favorites.filter((favorite) => favorite.tag === filter.value) : favorites;
  document.querySelector("#youtube-favorite-count").textContent = String(visibleFavorites.length).padStart(2, "0");
  list.replaceChildren();
  if (!favorites.length || !visibleFavorites.length) {
    const empty = document.createElement("p");
    empty.className = "quiet-message";
    empty.textContent = favorites.length ? "No favorites use this tag." : "No saved videos or playlists.";
    list.append(empty);
    return;
  }
  visibleFavorites.forEach((favorite) => {
    const row = document.createElement("div");
    row.className = "youtube-favorite-row";
    const open = document.createElement("button");
    open.className = "youtube-favorite-open";
    open.type = "button";
    open.textContent = favorite.name;
    open.addEventListener("click", () => {
      currentYoutubeQueueItemId = null;
      updateYoutubeEmbed(favorite.selection);
      document.querySelector("#youtube-url").value = youtubeCanonicalUrl(favorite.selection);
      document.querySelector("#youtube-status").textContent = `Showing ${favorite.name}.`;
      renderYoutubeQueue();
    });
    const kind = document.createElement("span");
    kind.className = "youtube-favorite-kind";
    kind.textContent = favorite.selection.playlistId ? "PLAYLIST" : "VIDEO";
    const tag = document.createElement("span");
    tag.className = "youtube-favorite-tag";
    tag.textContent = favorite.tag || "UNTAGGED";
    const queue = document.createElement("button");
    queue.className = "youtube-favorite-queue";
    queue.type = "button";
    queue.textContent = "Queue";
    queue.addEventListener("click", () => addYoutubeQueueItem(favorite.selection, favorite.name));
    const remove = document.createElement("button");
    remove.className = "youtube-favorite-remove";
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove ${favorite.name}`);
    remove.title = "Remove saved item";
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      const next = readYoutubeFavorites().filter((item) => item.name !== favorite.name
        || item.selection.videoId !== favorite.selection.videoId
        || item.selection.playlistId !== favorite.selection.playlistId);
      try {
        localStorage.setItem("musicPlayer.youtubeFavorites", JSON.stringify(next));
        renderYoutubeFavorites();
      } catch {
        document.querySelector("#youtube-status").textContent = "Could not update saved favorites.";
      }
    });
    row.append(open, tag, kind, queue, remove);
    list.append(row);
  });
}

function saveYoutubeFavorite() {
  const nameInput = document.querySelector("#youtube-favorite-name");
  const tagInput = document.querySelector("#youtube-favorite-tag");
  const selection = currentYoutubeSelection;
  const defaultName = selection.playlistId ? "YouTube playlist" : "YouTube video";
  const name = nameInput.value.trim() || defaultName;
  const tag = tagInput.value.trim().slice(0, 32);
  const favorites = readYoutubeFavorites();
  const existingIndex = favorites.findIndex((favorite) => favorite.selection.videoId === selection.videoId && favorite.selection.playlistId === selection.playlistId);
  const favorite = { name: name.slice(0, 80), tag, selection: { ...selection } };
  if (existingIndex >= 0) favorites[existingIndex] = favorite;
  else favorites.unshift(favorite);
  try {
    localStorage.setItem("musicPlayer.youtubeFavorites", JSON.stringify(favorites.slice(0, 40)));
    nameInput.value = "";
    tagInput.value = "";
    document.querySelector("#youtube-status").textContent = `Saved ${favorite.name}.`;
    renderYoutubeFavorites();
  } catch {
    document.querySelector("#youtube-status").textContent = "Could not save this item in local storage.";
  }
}

function exportYoutubeFavorites() {
  const backup = {
    format: "music-player-youtube-favorites",
    version: 1,
    favorites: readYoutubeFavorites(),
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "music-player-youtube-favorites.json";
  link.click();
  URL.revokeObjectURL(link.href);
}

async function importYoutubeFavorites(file) {
  try {
    if (file.size > 1024 * 1024) throw new Error("Backup files are limited to 1 MB.");
    const backup = JSON.parse(await file.text());
    if (backup.format !== "music-player-youtube-favorites" || backup.version !== 1 || !Array.isArray(backup.favorites)) {
      throw new Error("This is not a Music.Player favorites backup.");
    }
    const merged = new Map();
    for (const favorite of [...readYoutubeFavorites(), ...backup.favorites]) {
      if (!favorite || !isValidYoutubeSelection(favorite.selection) || typeof favorite.name !== "string") continue;
      const selection = { videoId: favorite.selection.videoId || null, playlistId: favorite.selection.playlistId || null };
      const key = `${selection.videoId || ""}|${selection.playlistId || ""}`;
      merged.set(key, {
        name: favorite.name.trim().slice(0, 80) || "YouTube favorite",
        tag: typeof favorite.tag === "string" ? favorite.tag.trim().slice(0, 32) : "",
        selection,
      });
    }
    const favorites = [...merged.values()].slice(0, 40);
    localStorage.setItem("musicPlayer.youtubeFavorites", JSON.stringify(favorites));
    renderYoutubeFavorites();
    document.querySelector("#youtube-status").textContent = `Imported ${favorites.length} saved items.`;
  } catch (error) {
    document.querySelector("#youtube-status").textContent = `Could not import favorites: ${error.message}`;
  }
}

let currentYoutubeQueueItemId = null;

function readYoutubeQueue() {
  try {
    const storedQueue = JSON.parse(localStorage.getItem("musicPlayer.youtubeQueue") || "[]");
    if (!Array.isArray(storedQueue)) return [];
    return storedQueue
      .filter((item) => item && isValidYoutubeSelection(item.selection) && typeof item.name === "string")
      .slice(0, 50)
      .map((item) => ({
        id: typeof item.id === "string" ? item.id : `${item.selection.videoId || ""}|${item.selection.playlistId || ""}`,
        name: item.name.slice(0, 80),
        selection: { videoId: item.selection.videoId || null, playlistId: item.selection.playlistId || null },
      }));
  } catch {
    return [];
  }
}

function saveYoutubeQueue(queue) {
  try {
    localStorage.setItem("musicPlayer.youtubeQueue", JSON.stringify(queue.slice(0, 50)));
    renderYoutubeQueue();
    return true;
  } catch {
    document.querySelector("#youtube-status").textContent = "Could not save the YouTube queue.";
    return false;
  }
}

function addYoutubeQueueItem(selection, name) {
  const queue = readYoutubeQueue();
  if (queue.length >= 50) {
    document.querySelector("#youtube-status").textContent = "The YouTube queue is full (50 items).";
    return;
  }
  const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  queue.push({ id, name: name.slice(0, 80), selection: { ...selection } });
  if (saveYoutubeQueue(queue)) document.querySelector("#youtube-status").textContent = `Queued ${name}.`;
}

function renderYoutubeQueue() {
  const queue = readYoutubeQueue();
  const list = document.querySelector("#youtube-queue-list");
  document.querySelector("#youtube-queue-count").textContent = String(queue.length).padStart(2, "0");
  list.replaceChildren();
  if (!queue.length) {
    const empty = document.createElement("p");
    empty.className = "quiet-message";
    empty.textContent = "Add saved videos or playlists to build a queue.";
    list.append(empty);
    return;
  }
  queue.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "youtube-queue-row";
    const play = document.createElement("button");
    play.className = "youtube-queue-play";
    play.type = "button";
    play.textContent = item.name;
    play.addEventListener("click", () => playYoutubeQueueItem(item.id));
    const kind = document.createElement("span");
    kind.className = "youtube-queue-state";
    kind.textContent = currentYoutubeQueueItemId === item.id ? "NOW PLAYING" : item.selection.playlistId ? "PLAYLIST" : "VIDEO";
    const controls = document.createElement("div");
    controls.className = "youtube-queue-controls";
    for (const [direction, label, title] of [[-1, "↑", "Move up"], [1, "↓", "Move down"]]) {
      const move = document.createElement("button");
      move.className = "youtube-queue-move";
      move.type = "button";
      move.textContent = label;
      move.title = title;
      move.setAttribute("aria-label", `${title} ${item.name}`);
      move.disabled = direction < 0 ? index === 0 : index === queue.length - 1;
      move.addEventListener("click", () => moveYoutubeQueueItem(item.id, direction));
      controls.append(move);
    }
    const remove = document.createElement("button");
    remove.className = "youtube-favorite-remove";
    remove.type = "button";
    remove.textContent = "×";
    remove.title = "Remove from queue";
    remove.setAttribute("aria-label", `Remove ${item.name} from queue`);
    remove.addEventListener("click", () => removeYoutubeQueueItem(item.id));
    controls.append(remove);
    row.append(play, kind, controls);
    list.append(row);
  });
}

function moveYoutubeQueueItem(id, direction) {
  const queue = readYoutubeQueue();
  const index = queue.findIndex((item) => item.id === id);
  const targetIndex = index + direction;
  if (index < 0 || targetIndex < 0 || targetIndex >= queue.length) return;
  [queue[index], queue[targetIndex]] = [queue[targetIndex], queue[index]];
  saveYoutubeQueue(queue);
}

function removeYoutubeQueueItem(id) {
  const queue = readYoutubeQueue().filter((item) => item.id !== id);
  if (currentYoutubeQueueItemId === id) currentYoutubeQueueItemId = null;
  saveYoutubeQueue(queue);
}

function playYoutubeQueueItem(id) {
  const item = readYoutubeQueue().find((entry) => entry.id === id);
  if (!item) return;
  currentYoutubeQueueItemId = id;
  youtubeQueueAutoplayRequested = !youtubePlayerReady;
  updateYoutubeEmbed(item.selection, true, true);
  document.querySelector("#youtube-url").value = youtubeCanonicalUrl(item.selection);
  document.querySelector("#youtube-status").textContent = `Playing queue item: ${item.name}.`;
  renderYoutubeQueue();
}

function advanceYoutubeQueue() {
  const queue = readYoutubeQueue();
  const currentIndex = queue.findIndex((item) => item.id === currentYoutubeQueueItemId);
  if (currentIndex < 0 || currentIndex + 1 >= queue.length) {
    currentYoutubeQueueItemId = null;
    renderYoutubeQueue();
    return;
  }
  playYoutubeQueueItem(queue[currentIndex + 1].id);
}

async function toggleYoutubePictureInPicture() {
  const button = document.querySelector("#youtube-pip");
  if (youtubePipWindow) {
    youtubePipWindow.close();
    return;
  }
  if (!window.documentPictureInPicture?.requestWindow) {
    document.querySelector("#youtube-status").textContent = "Picture-in-picture is not supported by this embedded runtime.";
    return;
  }
  try {
    youtubePipWindow = await window.documentPictureInPicture.requestWindow({ width: 520, height: 300 });
    const frame = document.querySelector("#youtube-embed");
    youtubePipPlaceholder = document.createElement("span");
    frame.parentNode.insertBefore(youtubePipPlaceholder, frame);
    youtubePipWindow.document.body.style.cssText = "margin:0;width:100vw;height:100vh;background:#000;overflow:hidden";
    frame.style.cssText = "width:100%;height:100%;border:0;display:block";
    youtubePipWindow.document.body.append(frame);
    button.textContent = "Exit picture-in-picture";
    button.setAttribute("aria-pressed", "true");
    youtubePipWindow.addEventListener("pagehide", () => {
      youtubePipPlaceholder?.parentNode?.insertBefore(frame, youtubePipPlaceholder);
      youtubePipPlaceholder?.remove();
      youtubePipPlaceholder = null;
      youtubePipWindow = null;
      frame.removeAttribute("style");
      button.textContent = "Picture-in-picture";
      button.setAttribute("aria-pressed", "false");
    }, { once: true });
  } catch {
    document.querySelector("#youtube-status").textContent = "Picture-in-picture could not be opened.";
    youtubePipWindow = null;
  }
}

function toggleYoutubeTheater() {
  const view = document.querySelector("#view-youtube");
  const button = document.querySelector("#youtube-theater");
  const active = view.classList.toggle("youtube-theater");
  button.setAttribute("aria-pressed", String(active));
  button.textContent = active ? "Exit theater" : "Theater";
}

async function toggleYoutubeFullscreen() {
  const frame = document.querySelector("#youtube-frame");
  const button = document.querySelector("#youtube-fullscreen");
  if (document.fullscreenElement === frame) {
    await document.exitFullscreen();
    return;
  }
  if (!frame.requestFullscreen) {
    document.querySelector("#youtube-status").textContent = "Full screen is unavailable; use Theater instead.";
    return;
  }
  try {
    await frame.requestFullscreen();
  } catch {
    document.querySelector("#youtube-status").textContent = "Full screen was blocked; use Theater instead.";
  }
  button.setAttribute("aria-pressed", String(document.fullscreenElement === frame));
}

document.addEventListener("fullscreenchange", () => {
  const active = document.fullscreenElement === document.querySelector("#youtube-frame");
  const button = document.querySelector("#youtube-fullscreen");
  button.setAttribute("aria-pressed", String(active));
  button.textContent = active ? "Exit full screen" : "Full screen";
});

async function searchStations(event) {
  event.preventDefault();
  const query = document.querySelector("#station-query").value.trim();
  const results = document.querySelector("#station-results");
  results.replaceChildren(Object.assign(document.createElement("p"), {
    className: "quiet-message",
    textContent: "Searching community stations…",
  }));
  try {
    const countryCode = document.querySelector("#station-country").value;
    const searches = query ? [{ name: query }, { tag: query }] : [{ tag: "music" }];
    const stationGroups = await Promise.all(searches.map(async (criteria) => {
      const parameters = new URLSearchParams({
        ...criteria,
        countrycode: countryCode,
      });
      const response = await fetch(`/api/stations?${parameters}`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Station directory is unavailable right now.");
      return result.stations;
    }));
    const stations = [...new Map(stationGroups.flat().map((station) => [station.stationuuid, station])).values()];
    results.replaceChildren();
    if (!stations.length) {
      results.innerHTML = '<p class="quiet-message">No stations found. Try a broader search.</p>';
      return;
    }
    for (const station of stations) {
      if (!station.url_resolved) continue;
      const card = document.createElement("article");
      card.className = "station-card";
      const text = document.createElement("div");
      const title = document.createElement("div");
      title.className = "station-title";
      title.textContent = station.name || "Untitled station";
      const meta = document.createElement("div");
      meta.className = "station-meta";
      meta.textContent = [station.country, station.codec, station.bitrate ? `${station.bitrate} KBPS` : ""].filter(Boolean).join(" · ");
      text.append(title, meta);
      const play = document.createElement("button");
      play.className = "station-play";
      play.type = "button";
      play.textContent = "PLAY LIVE";
      play.addEventListener("click", () => playStation(station));
      card.append(text, play);
      results.append(card);
    }
  } catch (error) {
    results.replaceChildren(Object.assign(document.createElement("p"), {
      className: "quiet-message",
      textContent: `${error.message} Check your internet connection and try again.`,
    }));
  }
}

function playStation(station) {
  if (!/^https?:\/\//i.test(station.url_resolved)) return;
  clearTrackArtwork();
  state.activeMedia.pause();
  state.activeMedia.removeAttribute("src");
  state.activeMedia.load();
  state.activeMedia = streamPlayer;
  audioPlayer.hidden = true;
  videoPlayer.hidden = true;
  streamPlayer.src = station.url_resolved;
  streamPlayer.load();
  streamPlayer.play().then(ensureAudioGraph).catch(() => {
    document.querySelector("#playback-status").textContent = "STREAM BLOCKED · TRY ANOTHER STATION";
  });
  document.querySelector("#current-title").textContent = station.name || "Live radio";
  document.querySelector("#current-subtitle").textContent = [station.country, station.codec, "ONLINE STREAM"].filter(Boolean).join(" · ");
  document.querySelector("#playback-status").textContent = "TUNING IN LIVE";
  document.querySelector("#track-extension").textContent = "LIVE STREAM";
  document.querySelector("#inspector-name").textContent = station.name || "Live radio";
  document.querySelector("#inspector-type").textContent = "Online station · live stream";
  document.querySelector("#inspector-format").textContent = station.codec || "STREAM";
  document.querySelector("#inspector-size").textContent = station.bitrate ? `${station.bitrate} KBPS` : "LIVE";
  document.querySelector("#inspector-duration").textContent = "LIVE";
  document.querySelector("#inspector-modified").textContent = "—";
  document.querySelector("#text-preview").value = "";
  state.currentIndex = -1;
  state.lyricsRequest += 1;
  state.lyrics = [];
  state.activeLyricIndex = -1;
  document.querySelector("#lyrics-state").textContent = "LIVE STREAM · NO LOCAL LYRICS";
  const lyricsMessage = document.createElement("p");
  lyricsMessage.className = "lyrics-empty";
  lyricsMessage.textContent = "Local LRC lyrics are available for files in your library.";
  document.querySelector("#lyrics-lines").replaceChildren(lyricsMessage);
  renderTracks();
}

const taskDialog = document.querySelector("#task-manager-dialog");
let taskRefreshTimer = 0;

function showDialog(id) {
  document.querySelector("#desktop-tools-dialog").close();
  const dialog = document.querySelector(`#${id}`);
  if (!dialog.open) dialog.showModal();
}

function setTaskStatus(message) {
  document.querySelector("#task-manager-status").textContent = message;
}

async function refreshManagedTasks() {
  const api = window.pywebview?.api;
  const list = document.querySelector("#managed-task-list");
  if (!api) {
    list.replaceChildren();
    setTaskStatus("Open this player in the desktop app to manage processes.");
    return;
  }
  try {
    const tasks = await api.list_tasks();
    list.replaceChildren();
    if (!tasks.length) {
      const empty = document.createElement("div");
      empty.className = "task-empty";
      empty.textContent = "No apps started by this manager.";
      list.append(empty);
      return;
    }
    for (const task of tasks) {
      const row = document.createElement("div");
      row.className = "managed-task-row";
      const name = document.createElement("span");
      name.className = "managed-task-name";
      name.textContent = task.name;
      const status = document.createElement("span");
      status.className = "managed-task-state";
      status.textContent = task.running ? `RUNNING · ${task.pid}` : `EXITED · ${task.pid}`;
      const end = document.createElement("button");
      end.className = "task-end-button";
      end.type = "button";
      end.textContent = "End task";
      end.disabled = !task.running;
      end.addEventListener("click", async () => {
        if (!window.confirm(`End ${task.name}? This only stops an app started from this manager.`)) return;
        const result = await api.end_task(task.pid);
        setTaskStatus(result.ok ? `End requested for ${task.name}.` : result.error);
        await refreshManagedTasks();
      });
      row.append(name, status, end);
      list.append(row);
    }
  } catch (error) {
    setTaskStatus(`Task list unavailable: ${error.message}`);
  }
}

async function openTaskManager() {
  showDialog("task-manager-dialog");
  await refreshManagedTasks();
  window.clearInterval(taskRefreshTimer);
  taskRefreshTimer = window.setInterval(refreshManagedTasks, 1500);
}

async function openNotificationSettings() {
  showDialog("notification-dialog");
  const api = window.pywebview?.api;
  if (!api) {
    document.querySelector("#notification-status").textContent = "Open this player in the desktop app to configure notifications.";
    return;
  }
  try {
    const settings = await api.load_notification_settings();
    document.querySelector("#notifications-enabled").checked = settings.enabled;
    document.querySelector("#notification-heading").value = settings.title;
    document.querySelector("#notification-template").value = settings.message;
    document.querySelector("#notification-status").textContent = "";
  } catch (error) {
    document.querySelector("#notification-status").textContent = `Settings unavailable: ${error.message}`;
  }
}

async function browseTaskExecutable() {
  const api = window.pywebview?.api;
  if (!api) {
    setTaskStatus("Browse is available in the desktop app.");
    return;
  }
  const selected = await api.choose_executable();
  if (selected) document.querySelector("#task-app-input").value = selected;
}

async function startManagedTask() {
  const api = window.pywebview?.api;
  if (!api) {
    setTaskStatus("Start task is available in the desktop app.");
    return;
  }
  const input = document.querySelector("#task-app-input");
  const result = await api.start_task(input.value);
  if (!result.ok) {
    setTaskStatus(result.error);
    return;
  }
  input.value = "";
  setTaskStatus(`Started ${result.task.name}.`);
  await refreshManagedTasks();
}

async function saveNotificationSettings() {
  const api = window.pywebview?.api;
  if (!api) {
    document.querySelector("#notification-status").textContent = "Settings can only be saved in the desktop app.";
    return;
  }
  const result = await api.save_notification_settings(
    document.querySelector("#notifications-enabled").checked,
    document.querySelector("#notification-heading").value,
    document.querySelector("#notification-template").value,
  );
  document.querySelector("#notification-status").textContent = result.ok ? "Notification settings saved." : result.error;
}

async function testNotificationSettings() {
  const api = window.pywebview?.api;
  if (!api) {
    document.querySelector("#notification-status").textContent = "Test notifications are available in the desktop app.";
    return;
  }
  const result = await api.test_notification(
    "Sample track",
    document.querySelector("#notification-heading").value,
    document.querySelector("#notification-template").value,
  );
  document.querySelector("#notification-status").textContent = result.ok
    ? "Test notification sent."
    : "Tray notifications are unavailable or disabled.";
}

window.openTaskManager = openTaskManager;
window.openNotificationSettings = openNotificationSettings;

function ensureAudioGraph() {
  if (state.activeMedia === streamPlayer) {
    drawVisualizer();
    return;
  }
  if (!state.audioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    state.audioContext = new AudioContextClass();
    state.analyser = state.audioContext.createAnalyser();
    state.analyser.fftSize = 128;
    state.analyser.smoothingTimeConstant = 0.78;
    state.eqFilters = [60, 250, 1000, 4000, 12000].map((frequency, index) => {
      const filter = state.audioContext.createBiquadFilter();
      filter.type = "peaking";
      filter.frequency.value = frequency;
      filter.Q.value = 1;
      filter.gain.value = state.eqGains[index];
      if (index > 0) state.eqFilters[index - 1].connect(filter);
      return filter;
    });
    state.eqFilters.at(-1).connect(state.analyser);
    state.analyser.connect(state.audioContext.destination);
  }
  if (state.audioContext.state === "suspended") state.audioContext.resume();
  let source = state.audioSources.get(state.activeMedia);
  if (!source) {
    try {
      source = state.audioContext.createMediaElementSource(state.activeMedia);
      state.audioSources.set(state.activeMedia, source);
      source.connect(state.eqFilters[0] || state.analyser);
    } catch (error) {
      console.warn("Audio visualization is unavailable for this source.", error);
    }
  }
  state.source = source || null;
  state.sourceMedia = source ? state.activeMedia : null;
  drawVisualizer();
}

function drawVisualizer() {
  cancelAnimationFrame(state.animationFrame);
  const bounds = visualizer.getBoundingClientRect();
  const pixelRatio = window.devicePixelRatio || 1;
  visualizer.width = Math.max(1, Math.floor(bounds.width * pixelRatio));
  visualizer.height = Math.max(1, Math.floor(bounds.height * pixelRatio));
  canvasContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  const width = bounds.width;
  const height = bounds.height;
  const values = new Uint8Array(state.analyser?.frequencyBinCount ?? 48);

  const draw = () => {
    canvasContext.clearRect(0, 0, width, height);
    if (state.analyser && !state.activeMedia.paused) state.analyser.getByteFrequencyData(values);
    const count = 36;
    const gap = 3;
    const barWidth = Math.max(2, (width - gap * (count - 1)) / count);
    const active = !state.activeMedia.paused;
    for (let index = 0; index < count; index += 1) {
      const sample = values[Math.floor(index * values.length / count)] / 255;
      const idle = 0.08 + Math.abs(Math.sin(index * 0.73)) * 0.14;
      const energy = active ? Math.max(sample, idle * 0.45) : idle;
      const barHeight = Math.max(3, energy * (height - 15));
      const x = index * (barWidth + gap);
      const y = (height - barHeight) / 2;
      const color = index % 9 === 0 ? "#ff765f" : index % 4 === 0 ? "#88d9bb" : "#d7ff69";
      canvasContext.fillStyle = color;
      canvasContext.globalAlpha = active ? 0.55 + energy * 0.45 : 0.42;
      canvasContext.fillRect(x, y, barWidth, barHeight);
    }
    canvasContext.globalAlpha = 1;
    state.animationFrame = requestAnimationFrame(draw);
  };
  draw();
}

function bindPlayerEvents() {
  for (const player of [audioPlayer, nextAudioPlayer, videoPlayer, streamPlayer]) {
    player.addEventListener("play", () => {
      if (player === state.activeMedia) {
        document.querySelector("#playback-status").textContent = "NOW PLAYING";
        document.querySelector("#play-button").innerHTML = 'PAUSE <span aria-hidden="true">Ⅱ</span>';
        const trackName = state.tracks[state.currentIndex]?.name || document.querySelector("#current-title").textContent;
        sendDesktopEvent(state.currentIndex >= 0 ? "track-started" : "station-started", trackName);
      }
    });
    player.addEventListener("pause", () => {
      if (player === state.activeMedia) {
        document.querySelector("#playback-status").textContent = "PLAYBACK PAUSED";
        document.querySelector("#play-button").innerHTML = 'PLAY <span aria-hidden="true">▶</span>';
      }
    });
    player.addEventListener("timeupdate", () => {
      if (player !== state.activeMedia) return;
      document.querySelector("#elapsed-time").textContent = formatTime(player.currentTime);
      document.querySelector("#duration-time").textContent = formatTime(player.duration);
      document.querySelector("#seek-slider").value = player.duration ? String(Math.round(player.currentTime / player.duration * 1000)) : "0";
      updateLyricHighlight(player.currentTime);
      if (isLocalAudioPlayer(player) && state.crossfadeSeconds > 0 && !state.crossfadeTriggered && Number.isFinite(player.duration) && player.duration > 0) {
        const nextIndex = currentPlaylistIndexStep(1);
        const nextTrack = state.tracks[nextIndex];
        const fadeSeconds = Math.min(state.crossfadeSeconds, player.duration / 2);
        if (nextTrack?.type === "audio" && player.duration - player.currentTime <= fadeSeconds) {
          playTrack(nextIndex, { crossfadeFrom: player, fadeSeconds });
          return;
        }
      }
      if (state.selectedTrack && state.selectedTrack === state.tracks[state.currentIndex]) {
        state.selectedTrack.duration = player.duration;
        document.querySelector("#inspector-duration").textContent = formatTime(player.duration);
      }
    });
    player.addEventListener("ended", () => {
      if (player !== state.activeMedia) return;
      if (state.repeat && state.currentIndex >= 0) {
        player.currentTime = 0;
        player.play();
      } else if (state.currentIndex >= 0) {
        playNext();
      }
    });
    player.addEventListener("error", () => {
      if (player === state.activeMedia && player.src) {
        document.querySelector("#playback-status").textContent = "FORMAT NOT SUPPORTED BY THIS BROWSER";
      }
    });
  }
}

document.querySelector("#play-button").addEventListener("click", togglePlayback);
document.querySelector("#previous-button").addEventListener("click", () => playNext(-1));
document.querySelector("#next-button").addEventListener("click", () => playNext(1));
document.querySelector("#shuffle-button").addEventListener("click", (event) => {
  state.shuffle = !state.shuffle;
  event.currentTarget.setAttribute("aria-pressed", String(state.shuffle));
});
document.querySelector("#repeat-button").addEventListener("click", (event) => {
  state.repeat = !state.repeat;
  event.currentTarget.setAttribute("aria-pressed", String(state.repeat));
});
document.querySelector("#crossfade-seconds").addEventListener("change", setCrossfadeDuration);
equalizerControlIds.forEach((id, index) => {
  document.querySelector(`#${id}`).addEventListener("input", (event) => setEqualizerBand(index, event.currentTarget.value));
});
document.querySelector("#equalizer-preset").addEventListener("change", (event) => setEqualizerPreset(event.currentTarget.value));
document.querySelector("#seek-slider").addEventListener("input", (event) => {
  const player = state.activeMedia;
  if (Number.isFinite(player.duration)) player.currentTime = Number(event.currentTarget.value) / 1000 * player.duration;
});
document.querySelector("#inspector-toggle").addEventListener("click", () => toggleInspector());
document.querySelector("#close-inspector").addEventListener("click", () => toggleInspector(false));
document.querySelector("#lyrics-toggle").addEventListener("click", () => {
  setLyricsPanel(document.querySelector("#lyrics-panel").hidden);
});
document.querySelector("#lyrics-first-line").addEventListener("change", (event) => {
  setLyricsFirstLineOnly(event.currentTarget.checked);
});
document.querySelector("#lyrics-import").addEventListener("click", () => document.querySelector("#file-picker").click());
document.querySelector("#local-playlist-create").addEventListener("click", createLocalPlaylist);
document.querySelector("#local-playlist-select").addEventListener("change", (event) => selectLocalPlaylist(event.currentTarget.value));
document.querySelector("#local-playlist-add-current").addEventListener("click", addCurrentTrackToPlaylist);
document.querySelector("#local-playlist-delete").addEventListener("click", deleteLocalPlaylist);
document.querySelector("#local-playlist-name").addEventListener("keydown", (event) => {
  if (event.key === "Enter") createLocalPlaylist();
});
document.querySelector("#desktop-tools-toggle").addEventListener("click", () => document.querySelector("#desktop-tools-dialog").showModal());
document.querySelector("#open-task-manager").addEventListener("click", openTaskManager);
document.querySelector("#open-notification-settings").addEventListener("click", openNotificationSettings);
document.querySelectorAll("[data-close-dialog]").forEach((button) => {
  button.addEventListener("click", () => document.querySelector(`#${button.dataset.closeDialog}`).close());
});
document.querySelector("#task-browse").addEventListener("click", browseTaskExecutable);
document.querySelector("#task-start").addEventListener("click", startManagedTask);
document.querySelector("#task-app-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter") startManagedTask();
});
document.querySelector("#task-manager-dialog").addEventListener("close", () => window.clearInterval(taskRefreshTimer));
document.querySelector("#notification-save").addEventListener("click", saveNotificationSettings);
document.querySelector("#notification-test").addEventListener("click", testNotificationSettings);
document.querySelector("#import-files").addEventListener("click", () => document.querySelector("#file-picker").click());
document.querySelector("#empty-import").addEventListener("click", () => document.querySelector("#file-picker").click());
document.querySelector("#file-picker").addEventListener("change", (event) => {
  addImportedFiles(event.currentTarget.files);
  event.currentTarget.value = "";
});
document.querySelector("#track-search").addEventListener("input", renderTracks);
document.querySelector("#find-duplicates").addEventListener("click", findDuplicateFiles);
document.querySelector("#close-duplicates").addEventListener("click", () => {
  document.querySelector("#duplicate-panel").hidden = true;
});
document.querySelector("#station-form").addEventListener("submit", searchStations);
document.querySelector("#youtube-form").addEventListener("submit", handleYoutubeSubmit);
document.querySelector("#youtube-default").addEventListener("click", resetYoutubeEmbed);
document.querySelector("#youtube-save-favorite").addEventListener("click", saveYoutubeFavorite);
document.querySelector("#youtube-export-favorites").addEventListener("click", exportYoutubeFavorites);
document.querySelector("#youtube-import-favorites").addEventListener("click", () => document.querySelector("#youtube-favorite-file").click());
document.querySelector("#youtube-favorite-file").addEventListener("change", async (event) => {
  const [file] = event.currentTarget.files;
  if (file) await importYoutubeFavorites(file);
  event.currentTarget.value = "";
});
document.querySelector("#youtube-favorite-filter").addEventListener("change", renderYoutubeFavorites);
document.querySelector("#youtube-playback-speed").addEventListener("change", setYoutubePlaybackSpeed);
document.querySelector("#youtube-pip").addEventListener("click", toggleYoutubePictureInPicture);
document.querySelector("#youtube-theater").addEventListener("click", toggleYoutubeTheater);
document.querySelector("#youtube-fullscreen").addEventListener("click", toggleYoutubeFullscreen);
document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => activateView(button.dataset.view));
});
document.addEventListener("keydown", (event) => {
  if (event.code === "Space" && !["INPUT", "TEXTAREA", "BUTTON"].includes(document.activeElement.tagName)) {
    event.preventDefault();
    togglePlayback();
  }
  if (event.code === "ArrowRight" && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) {
    state.activeMedia.currentTime += 5;
  }
  if (event.code === "ArrowLeft" && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) {
    state.activeMedia.currentTime = Math.max(0, state.activeMedia.currentTime - 5);
  }
});
window.addEventListener("resize", () => {
  toggleInspector(state.inspectorOpen);
  drawVisualizer();
});
window.addEventListener("beforeunload", () => {
  for (const objectUrl of state.objectUrls) URL.revokeObjectURL(objectUrl);
  if (state.artworkObjectUrl) URL.revokeObjectURL(state.artworkObjectUrl);
});

bindPlayerEvents();
toggleInspector(state.inspectorOpen);
initializeLocalPlaylists();
initializeCrossfadeSettings();
initializeEqualizerSettings();
initializeYoutubeEmbed();
drawVisualizer();
loadLibrary();
startDevAutoRefresh();