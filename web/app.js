const audioPlayer = document.querySelector("#audio-player");
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
  selectedTrack: null,
  objectUrls: new Set(),
  audioContext: null,
  analyser: null,
  source: null,
  animationFrame: 0,
  inspectorOpen: window.innerWidth > 860,
};

const mediaExtensions = new Set([
  ".aac", ".aif", ".aiff", ".flac", ".m4a", ".mka", ".mkv", ".mov",
  ".mp3", ".mp4", ".oga", ".ogg", ".opus", ".wav", ".webm", ".wma",
]);
const textExtensions = new Set([".cue", ".json", ".lrc", ".md", ".txt"]);
const videoExtensions = new Set([".mkv", ".mov", ".mp4", ".webm"]);

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
    const more = document.createElement("button");
    more.className = "track-more";
    more.type = "button";
    more.textContent = "···";
    more.setAttribute("aria-label", `Inspect ${track.name}`);
    more.addEventListener("click", () => {
      setInspector(track);
      if (window.innerWidth <= 860) toggleInspector(true);
    });

    row.append(titleCell, format, size, more);
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

function trackUrl(track) {
  if (track.objectUrl) return track.objectUrl;
  return `/api/media?id=${encodeURIComponent(track.id)}`;
}

function selectMediaElement(track) {
  const nextMedia = track.type === "video" ? videoPlayer : audioPlayer;
  const previousMedia = state.activeMedia;
  if (previousMedia !== nextMedia) {
    previousMedia.pause();
    previousMedia.removeAttribute("src");
    previousMedia.load();
  }
  state.activeMedia = nextMedia;
  videoPlayer.hidden = nextMedia !== videoPlayer;
  audioPlayer.hidden = nextMedia !== audioPlayer;
  return nextMedia;
}

function playTrack(index) {
  const track = state.tracks[index];
  if (!track) return;
  state.currentIndex = index;
  setInspector(track);
  const player = selectMediaElement(track);
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
  if (window.innerWidth <= 860) toggleInspector(false);
  player.play().then(ensureAudioGraph).catch(() => {
    document.querySelector("#playback-status").textContent = "READY · PRESS PLAY";
    document.querySelector("#play-button").innerHTML = 'PLAY <span aria-hidden="true">▶</span>';
  });
}

function currentPlaylistIndexStep(direction) {
  if (!state.tracks.length) return -1;
  if (state.shuffle && state.tracks.length > 1) {
    let next = state.currentIndex;
    while (next === state.currentIndex) next = Math.floor(Math.random() * state.tracks.length);
    return next;
  }
  return (state.currentIndex + direction + state.tracks.length) % state.tracks.length;
}

function playNext(direction = 1) {
  const index = currentPlaylistIndexStep(direction);
  if (index >= 0) playTrack(index);
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

function activateView(name) {
  for (const panel of document.querySelectorAll(".view-panel")) panel.hidden = panel.id !== `view-${name}`;
  for (const button of document.querySelectorAll(".nav-item")) {
    const active = button.dataset.view === name;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
}

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
  renderTracks();
}

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
    state.analyser.connect(state.audioContext.destination);
  }
  if (state.audioContext.state === "suspended") state.audioContext.resume();
  if (state.sourceMedia !== state.activeMedia) {
    try {
      state.source?.disconnect();
      state.source = state.audioContext.createMediaElementSource(state.activeMedia);
      state.source.connect(state.analyser);
      state.sourceMedia = state.activeMedia;
    } catch (error) {
      console.warn("Audio visualization is unavailable for this source.", error);
    }
  }
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
  for (const player of [audioPlayer, videoPlayer, streamPlayer]) {
    player.addEventListener("play", () => {
      if (player === state.activeMedia) {
        document.querySelector("#playback-status").textContent = "NOW PLAYING";
        document.querySelector("#play-button").innerHTML = 'PAUSE <span aria-hidden="true">Ⅱ</span>';
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
document.querySelector("#seek-slider").addEventListener("input", (event) => {
  const player = state.activeMedia;
  if (Number.isFinite(player.duration)) player.currentTime = Number(event.currentTarget.value) / 1000 * player.duration;
});
document.querySelector("#inspector-toggle").addEventListener("click", () => toggleInspector());
document.querySelector("#close-inspector").addEventListener("click", () => toggleInspector(false));
document.querySelector("#import-files").addEventListener("click", () => document.querySelector("#file-picker").click());
document.querySelector("#empty-import").addEventListener("click", () => document.querySelector("#file-picker").click());
document.querySelector("#file-picker").addEventListener("change", (event) => {
  addImportedFiles(event.currentTarget.files);
  event.currentTarget.value = "";
});
document.querySelector("#track-search").addEventListener("input", renderTracks);
document.querySelector("#station-form").addEventListener("submit", searchStations);
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
});

bindPlayerEvents();
toggleInspector(state.inspectorOpen);
drawVisualizer();
loadLibrary();