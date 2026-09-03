const state = {
  allSongs: [],
  filteredSongs: [],
  selectedSongId: null,
  mode: "view",
  isEditing: false,
  typesenseConfig: null,
  typesenseUnavailable: false,
  loadedFromLocalStorage: false,
  searchRequestId: 0,
  mobileView: "list",
  visibleSongCount: 120,
  favoriteSongIds: new Set(),
  showFavoritesOnly: false,
};

const LOCAL_STORAGE_KEY = "tamil-song-swaras-library";
const EDITOR_PASSWORD = "tfm-notes-admin";
const THEME_STORAGE_KEY = "tamil-song-swaras-theme";
const FAVORITES_STORAGE_KEY = "tamil-song-swaras-favorites";
const TYPESENSE_CONFIG_STORAGE_KEY = "tamil-song-swaras-typesense-config";
const DEFAULT_TYPESENSE_QUERY_BY = "title,film_name,full_notes,raw_text,relative_path";
const DEFAULT_TYPESENSE_COLLECTION = "songs";
const MOBILE_BREAKPOINT = window.matchMedia("(max-width: 900px)");
const SONG_LIST_INCREMENT = 120;

const elements = {
  searchInput: document.getElementById("searchInput"),
  sortSelect: document.getElementById("sortSelect"),
  songList: document.getElementById("songList"),
  songTitle: document.getElementById("songTitle"),
  filmName: document.getElementById("filmName"),
  notesContent: document.getElementById("notesContent"),
  notesContentSecondary: document.getElementById("notesContentSecondary"),
  notesLayout: document.getElementById("notesLayout"),
  emptyState: document.getElementById("emptyState"),
  readerPane: document.getElementById("readerPane"),
  readerSection: document.getElementById("readerSection"),
  listPane: document.getElementById("listPane"),
  fileFallback: document.getElementById("fileFallback"),
  fileInput: document.getElementById("fileInput"),
  editPageLink: document.getElementById("editPageLink"),
  favoriteFilterButton: document.getElementById("favoriteFilterButton"),
  favoriteSongButton: document.getElementById("favoriteSongButton"),
  addSongButton: document.getElementById("addSongButton"),
  readerActions: document.getElementById("readerActions"),
  editSongButton: document.getElementById("editSongButton"),
  saveSongButton: document.getElementById("saveSongButton"),
  cancelEditButton: document.getElementById("cancelEditButton"),
  deleteSongButton: document.getElementById("deleteSongButton"),
  exportLibraryButton: document.getElementById("exportLibraryButton"),
  editForm: document.getElementById("editForm"),
  editTitleInput: document.getElementById("editTitleInput"),
  editFilmInput: document.getElementById("editFilmInput"),
  editSourceUrlInput: document.getElementById("editSourceUrlInput"),
  editNotesInput: document.getElementById("editNotesInput"),
  themeToggleButton: document.getElementById("themeToggleButton"),
  themeToggleIcon: document.getElementById("themeToggleIcon"),
  mobileBackButton: document.getElementById("mobileBackButton"),
};

function isMobileLayout() {
  return MOBILE_BREAKPOINT.matches;
}

function isReadOnlyDeployment() {
  return window.location.hostname.endsWith("github.io");
}

function getModeFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get("mode") === "edit" ? "edit" : "view";
}

function slugify(value) {
  return normalizeText(value)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || `song-${Date.now()}`;
}

function getSavedTheme() {
  return localStorage.getItem(THEME_STORAGE_KEY) || "light";
}

function setMobileView(view) {
  state.mobileView = view;
  document.body.dataset.mobileView = isMobileLayout() ? view : "desktop";
}

function applyTheme(theme) {
  document.body.dataset.theme = theme;
  const isDark = theme === "dark";
  elements.themeToggleIcon.innerHTML = isDark ? "&#9728;" : "&#9790;";
  elements.themeToggleButton.setAttribute("aria-label", isDark ? "Switch to light theme" : "Switch to dark theme");
  elements.themeToggleButton.title = isDark ? "Switch to light theme" : "Switch to dark theme";
}

function toggleTheme() {
  const nextTheme = document.body.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
  applyTheme(nextTheme);
}

function loadFavorites() {
  try {
    const favorites = JSON.parse(localStorage.getItem(FAVORITES_STORAGE_KEY) || "[]");
    state.favoriteSongIds = new Set(Array.isArray(favorites) ? favorites : []);
  } catch (error) {
    console.warn("Failed to load favorite songs.", error);
    state.favoriteSongIds = new Set();
  }
}

function persistFavorites() {
  localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify([...state.favoriteSongIds]));
}

function isFavoriteSong(songId) {
  return state.favoriteSongIds.has(songId);
}

function updateFavoriteUi() {
  const hasSelection = Boolean(state.selectedSongId);
  const selectedIsFavorite = hasSelection && isFavoriteSong(state.selectedSongId);
  const favoriteCount = state.favoriteSongIds.size;
  const filterLabel = state.showFavoritesOnly ? "Show all songs" : "Show favorite songs";
  const songLabel = selectedIsFavorite ? "Remove song from favorites" : "Add song to favorites";

  elements.favoriteFilterButton.classList.toggle("active", state.showFavoritesOnly);
  elements.favoriteFilterButton.setAttribute("aria-pressed", state.showFavoritesOnly.toString());
  elements.favoriteFilterButton.setAttribute("aria-label", filterLabel);
  elements.favoriteFilterButton.title = favoriteCount > 0 ? `${filterLabel} (${favoriteCount})` : filterLabel;
  elements.favoriteFilterButton.querySelector("span").innerHTML = state.showFavoritesOnly ? "&#9733;" : "&#9734;";

  elements.favoriteSongButton.classList.toggle("active", selectedIsFavorite);
  elements.favoriteSongButton.classList.toggle("hidden", !hasSelection);
  elements.favoriteSongButton.setAttribute("aria-pressed", selectedIsFavorite.toString());
  elements.favoriteSongButton.setAttribute("aria-label", songLabel);
  elements.favoriteSongButton.title = songLabel;
  elements.favoriteSongButton.querySelector("span").innerHTML = selectedIsFavorite ? "&#9733;" : "&#9734;";
}

function persistSongs() {
  localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(state.allSongs));
}

function exportSongs() {
  const blob = new Blob([JSON.stringify(state.allSongs, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "songs.edited.json";
  link.click();
  URL.revokeObjectURL(url);
}

function isEditorMode() {
  return state.mode === "edit";
}

function updateModeUi() {
  const editingEnabled = isEditorMode() && !isReadOnlyDeployment();
  const hasSelection = Boolean(state.selectedSongId);

  elements.addSongButton.classList.toggle("hidden", !editingEnabled);
  elements.readerActions.classList.toggle("hidden", !editingEnabled || !hasSelection);
  elements.exportLibraryButton.classList.toggle("hidden", !editingEnabled);
  elements.editSongButton.classList.toggle("hidden", !editingEnabled || state.isEditing);
  elements.saveSongButton.classList.toggle("hidden", !editingEnabled || !state.isEditing);
  elements.cancelEditButton.classList.toggle("hidden", !editingEnabled || !state.isEditing);
  elements.deleteSongButton.classList.toggle("hidden", !editingEnabled || !state.isEditing);
  elements.notesContent.classList.toggle("hidden", state.isEditing);
  elements.notesContentSecondary.classList.toggle(
    "hidden",
    state.isEditing ||
      !elements.notesLayout.classList.contains("notes-layout-dual") ||
      elements.notesContentSecondary.textContent.trim() === ""
  );
  elements.editForm.classList.toggle("hidden", !state.isEditing);
  elements.editPageLink.classList.toggle("hidden", isReadOnlyDeployment());
  elements.editPageLink.href = editingEnabled ? "index.html" : "index.html?mode=edit";
  elements.editPageLink.setAttribute("aria-label", editingEnabled ? "Open viewer page" : "Open edit page");
  elements.editPageLink.title = editingEnabled ? "Open viewer page" : "Open edit page";
  updateFavoriteUi();
}

function normalizeText(value) {
  return (value || "").toString().toLowerCase();
}

function toTitleCase(value) {
  const normalized = (value || "").toString().trim().toLowerCase();
  if (!normalized) {
    return "";
  }

  return normalized.replace(/\b([a-z])([a-z']*)/g, (_, first, rest) => `${first.toUpperCase()}${rest}`);
}

function splitNotesForDisplay(notesText) {
  const text = (notesText || "").trim();
  if (!text) {
    return { primary: "", secondary: "", useSecondary: false };
  }

  const lines = text.split(/\r?\n/);
  if (lines.length < 14 || text.length > 1800) {
    return { primary: text, secondary: "", useSecondary: false };
  }

  let splitIndex = Math.ceil(lines.length / 2);
  while (splitIndex < lines.length && lines[splitIndex].trim() !== "") {
    splitIndex += 1;
  }

  if (splitIndex >= lines.length - 2) {
    splitIndex = Math.ceil(lines.length / 2);
  }

  const primary = lines.slice(0, splitIndex).join("\n").trim();
  const secondary = lines.slice(splitIndex).join("\n").trim();

  if (!secondary) {
    return { primary: text, secondary: "", useSecondary: false };
  }

  return { primary, secondary, useSecondary: true };
}

function normalizeTypesenseConfig(config) {
  if (!config || typeof config !== "object") {
    return null;
  }

  let protocol = (config.protocol || "http").toString().replace(/:$/, "");
  let host = (config.host || "").toString().trim();
  let port = (config.port || "").toString().trim();
  const apiKey = (config.apiKey || "").toString().trim();

  if (host.includes("://")) {
    try {
      const parsedHost = new URL(host);
      protocol = parsedHost.protocol.replace(/:$/, "") || protocol;
      host = parsedHost.hostname;
      port = parsedHost.port || port;
    } catch (error) {
      console.warn("Invalid Typesense host URL.", error);
    }
  }

  if (!host || !apiKey) {
    return null;
  }

  return {
    protocol,
    host,
    port,
    apiKey,
    collectionName: (config.collectionName || DEFAULT_TYPESENSE_COLLECTION).toString().trim(),
    queryBy: (config.queryBy || DEFAULT_TYPESENSE_QUERY_BY).toString().trim(),
    perPage: Number(config.perPage) > 0 ? Number(config.perPage) : 250,
  };
}

function getTypesenseConfig() {
  const params = new URLSearchParams(window.location.search);
  const urlConfig = {
    protocol: params.get("typesenseProtocol"),
    host: params.get("typesenseHost"),
    port: params.get("typesensePort"),
    apiKey: params.get("typesenseApiKey"),
    collectionName: params.get("typesenseCollection"),
    queryBy: params.get("typesenseQueryBy"),
  };

  const urlTypesenseConfig = normalizeTypesenseConfig(urlConfig);
  if (urlTypesenseConfig) {
    return urlTypesenseConfig;
  }

  try {
    const storedConfig = JSON.parse(localStorage.getItem(TYPESENSE_CONFIG_STORAGE_KEY) || "null");
    const localTypesenseConfig = normalizeTypesenseConfig(storedConfig);
    if (localTypesenseConfig) {
      return localTypesenseConfig;
    }
  } catch (error) {
    console.warn("Failed to read Typesense config from local storage.", error);
  }

  return normalizeTypesenseConfig(window.TYPESENSE_CONFIG);
}

function typesenseBaseUrl(config) {
  const port = config.port ? `:${config.port}` : "";
  return `${config.protocol}://${config.host}${port}`;
}

function isTypesenseEnabled() {
  return Boolean(state.typesenseConfig) &&
    !state.typesenseUnavailable &&
    !state.loadedFromLocalStorage &&
    !isEditorMode();
}

async function searchTypesense(rawQuery) {
  const config = state.typesenseConfig;
  const url = new URL(
    `/collections/${encodeURIComponent(config.collectionName)}/documents/search`,
    `${typesenseBaseUrl(config)}/`
  );

  url.searchParams.set("q", rawQuery);
  url.searchParams.set("query_by", config.queryBy);
  url.searchParams.set("per_page", config.perPage.toString());
  url.searchParams.set(
    "include_fields",
    "id,slug,title,film_name,full_notes,raw_text,source_url,relative_path,content_type"
  );

  const response = await fetch(url.toString(), {
    headers: {
      "X-TYPESENSE-API-KEY": config.apiKey,
    },
  });

  if (!response.ok) {
    throw new Error(`Typesense HTTP ${response.status}`);
  }

  const payload = await response.json();
  const localSongsById = new Map(state.allSongs.map((song) => [song.id, song]));

  return (payload.hits || [])
    .map((hit) => hit.document)
    .filter(Boolean)
    .map((document) => localSongsById.get(document.id) || document);
}

function songSearchBlob(song) {
  return [
    song.title,
    song.film_name,
    song.full_notes,
    song.raw_text,
    song.relative_path,
  ]
    .map(normalizeText)
    .join("\n");
}

function sortSongs(songs, sortValue) {
  const sorted = [...songs];
  const compareText = (a, b, key) => normalizeText(a[key]).localeCompare(normalizeText(b[key]));
  const compareFavorites = (a, b) => Number(isFavoriteSong(b.id)) - Number(isFavoriteSong(a.id));

  switch (sortValue) {
    case "title-desc":
      sorted.sort((a, b) => compareFavorites(a, b) || compareText(b, a, "title") || compareText(b, a, "film_name"));
      break;
    case "film-asc":
      sorted.sort((a, b) => compareFavorites(a, b) || compareText(a, b, "film_name") || compareText(a, b, "title"));
      break;
    case "film-desc":
      sorted.sort((a, b) => compareFavorites(a, b) || compareText(b, a, "film_name") || compareText(b, a, "title"));
      break;
    case "title-asc":
    default:
      sorted.sort((a, b) => compareFavorites(a, b) || compareText(a, b, "title") || compareText(a, b, "film_name"));
      break;
  }

  return sorted;
}

function renderSongList() {
  elements.songList.innerHTML = "";

  if (state.filteredSongs.length === 0) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = state.showFavoritesOnly ? "No favorite songs matched your search." : "No songs matched your search.";
    elements.songList.appendChild(empty);
    return;
  }

  const selectedIndex = state.filteredSongs.findIndex((song) => song.id === state.selectedSongId);
  const visibleCount = Math.min(
    state.filteredSongs.length,
    Math.max(state.visibleSongCount, selectedIndex + 1)
  );
  const visibleSongs = state.filteredSongs.slice(0, visibleCount);

  for (const song of visibleSongs) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "song-item";
    if (song.id === state.selectedSongId) {
      button.classList.add("active");
    }
    if (isFavoriteSong(song.id)) {
      button.classList.add("favorite");
    }

    button.innerHTML = `
      <div class="song-title-row">
        <div class="song-title">${escapeHtml(toTitleCase(song.title) || "Untitled Song")}</div>
        <span class="song-favorite-marker" aria-hidden="true">&#9733;</span>
      </div>
      <div class="song-film-wrap">
        <span class="song-film-label">Film:</span>
        <span class="song-film">${escapeHtml(toTitleCase(song.film_name) || "Unknown Film")}</span>
      </div>
    `;

    button.addEventListener("click", () => selectSong(song.id, { revealMobile: true }));
    elements.songList.appendChild(button);
  }

  if (visibleCount < state.filteredSongs.length) {
    const footer = document.createElement("div");
    footer.className = "song-list-footer";

    const count = document.createElement("p");
    count.className = "hint";
    count.textContent = `Showing ${visibleCount} of ${state.filteredSongs.length} songs`;

    const showMore = document.createElement("button");
    showMore.type = "button";
    showMore.className = "action-button load-more-button";
    showMore.textContent = "Show more";
    showMore.addEventListener("click", () => {
      state.visibleSongCount += SONG_LIST_INCREMENT;
      renderSongList();
    });

    footer.append(count, showMore);
    elements.songList.appendChild(footer);
  }
}

function selectSong(songId, options = {}) {
  const { revealMobile = true } = options;
  state.selectedSongId = songId;
  const song = state.filteredSongs.find((item) => item.id === songId) ||
    state.allSongs.find((item) => item.id === songId);

  if (!song) {
    return;
  }

  const notesText = song.full_notes || song.raw_text || "";
  const splitNotes = splitNotesForDisplay(notesText);
  elements.songTitle.textContent = toTitleCase(song.title) || "Untitled Song";
  elements.filmName.textContent = toTitleCase(song.film_name) || "Unknown Film";
  elements.notesContent.textContent = splitNotes.primary;
  elements.notesContentSecondary.textContent = splitNotes.secondary;
  elements.editTitleInput.value = toTitleCase(song.title) || "";
  elements.editFilmInput.value = toTitleCase(song.film_name) || "";
  elements.editSourceUrlInput.value = song.source_url || "";
  elements.editNotesInput.value = notesText;
  const useSecondaryPane = splitNotes.useSecondary && !isMobileLayout() && !state.isEditing;
  elements.notesLayout.classList.toggle("notes-layout-dual", useSecondaryPane);
  elements.notesContentSecondary.classList.toggle("hidden", !useSecondaryPane);

  elements.emptyState.classList.add("hidden");
  elements.readerPane.classList.remove("hidden");
  updateModeUi();
  renderSongList();

  if (revealMobile && isMobileLayout()) {
    setMobileView("reader");
  }
}

async function applyFilters() {
  const requestId = ++state.searchRequestId;
  const query = normalizeText(elements.searchInput.value.trim());
  const rawQuery = elements.searchInput.value.trim();
  const sortValue = elements.sortSelect.value;

  let songs = state.allSongs;
  if (query) {
    if (isTypesenseEnabled()) {
      try {
        songs = await searchTypesense(rawQuery);
        if (requestId !== state.searchRequestId) {
          return;
        }
      } catch (error) {
        console.warn("Typesense search failed, using local search.", error);
        state.typesenseUnavailable = true;
        songs = state.allSongs.filter((song) => songSearchBlob(song).includes(query));
      }
    } else {
      songs = songs.filter((song) => songSearchBlob(song).includes(query));
    }
  }

  if (state.showFavoritesOnly) {
    songs = songs.filter((song) => isFavoriteSong(song.id));
  }

  if (requestId !== state.searchRequestId) {
    return;
  }

  state.filteredSongs = sortSongs(songs, sortValue);

  const selectedStillVisible = state.filteredSongs.some((song) => song.id === state.selectedSongId);
  if (!selectedStillVisible) {
    state.selectedSongId = state.filteredSongs[0]?.id || null;
  }

  renderSongList();

  if (state.selectedSongId) {
    selectSong(state.selectedSongId, { revealMobile: false });
  } else {
    elements.readerPane.classList.add("hidden");
    elements.emptyState.classList.remove("hidden");
    if (isMobileLayout()) {
      setMobileView("list");
    }
    updateModeUi();
  }
}

function resetListAndApplyFilters() {
  state.visibleSongCount = SONG_LIST_INCREMENT;
  state.selectedSongId = null;
  applyFilters();
}

function toggleFavoritesFilter() {
  state.showFavoritesOnly = !state.showFavoritesOnly;
  resetListAndApplyFilters();
}

function toggleSelectedSongFavorite() {
  if (!state.selectedSongId) {
    return;
  }

  if (isFavoriteSong(state.selectedSongId)) {
    state.favoriteSongIds.delete(state.selectedSongId);
  } else {
    state.favoriteSongIds.add(state.selectedSongId);
  }

  persistFavorites();
  applyFilters();
}

function setSongs(songs) {
  state.allSongs = Array.isArray(songs) ? songs : [];
  state.selectedSongId = null;
  applyFilters();
}

function loadLocalLibrary() {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const songs = JSON.parse(raw);
    return Array.isArray(songs) ? songs : null;
  } catch (error) {
    console.warn("Failed to load local edited library.", error);
    return null;
  }
}

async function loadSongs() {
  state.mode = getModeFromUrl();
  const localSongs = loadLocalLibrary();
  if (localSongs) {
    state.loadedFromLocalStorage = true;
    setSongs(localSongs);
    updateModeUi();
    return;
  }

  try {
    const response = await fetch("data/songs.json");
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const songs = await response.json();
    state.loadedFromLocalStorage = false;
    setSongs(songs);
    updateModeUi();
  } catch (error) {
    console.warn("Local fetch failed, showing file fallback.", error);
    elements.fileFallback.classList.remove("hidden");
  }
}

function promptForEditorAccess() {
  const password = window.prompt("Enter the editor password:");
  if (password !== EDITOR_PASSWORD) {
    window.alert("Incorrect password.");
    window.location.href = "index.html";
    return false;
  }
  return true;
}

function beginEdit() {
  state.isEditing = true;
  updateModeUi();
}

function cancelEdit() {
  state.isEditing = false;
  if (state.selectedSongId) {
    selectSong(state.selectedSongId, { revealMobile: false });
  } else {
    updateModeUi();
  }
}

function saveCurrentSong() {
  const title = toTitleCase(elements.editTitleInput.value.trim());
  const film = toTitleCase(elements.editFilmInput.value.trim());
  const sourceUrl = elements.editSourceUrlInput.value.trim();
  const notes = elements.editNotesInput.value.trim();

  if (!title || !notes) {
    window.alert("Title and notes are required.");
    return;
  }

  const current = state.allSongs.find((song) => song.id === state.selectedSongId);
  if (!current) {
    return;
  }

  current.title = title;
  current.film_name = film;
  current.source_url = sourceUrl;
  current.full_notes = notes;
  current.raw_text = notes;
  current.slug = current.slug || slugify(title);

  persistSongs();
  state.isEditing = false;
  applyFilters();
  selectSong(current.id, { revealMobile: false });
}

function addNewSong() {
  const title = toTitleCase(window.prompt("Song title:"));
  if (!title) {
    return;
  }

  const newSong = {
    id: `manual-${Date.now()}`,
    slug: slugify(title),
    title,
    film_name: "",
    full_notes: "",
    raw_text: "",
    source_url: "",
    relative_path: "",
    content_type: "manual-entry",
  };

  state.allSongs.unshift(newSong);
  persistSongs();
  state.selectedSongId = newSong.id;
  applyFilters();
  beginEdit();
  selectSong(newSong.id, { revealMobile: true });
}

function deleteCurrentSong() {
  const current = state.allSongs.find((song) => song.id === state.selectedSongId);
  if (!current) {
    return;
  }

  const confirmed = window.confirm(`Delete "${current.title || "Untitled song"}"?`);
  if (!confirmed) {
    return;
  }

  state.allSongs = state.allSongs.filter((song) => song.id !== current.id);
  persistSongs();
  state.selectedSongId = state.allSongs[0]?.id || null;
  state.isEditing = false;
  applyFilters();

  if (state.selectedSongId) {
    selectSong(state.selectedSongId, { revealMobile: false });
  } else {
    elements.readerPane.classList.add("hidden");
    elements.emptyState.classList.remove("hidden");
    if (isMobileLayout()) {
      setMobileView("list");
    }
    updateModeUi();
  }
}

function escapeHtml(value) {
  return (value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function syncResponsiveLayout() {
  if (isMobileLayout()) {
    elements.notesLayout.classList.remove("notes-layout-dual");
    elements.notesContentSecondary.classList.add("hidden");

    if (state.selectedSongId) {
      selectSong(state.selectedSongId, { revealMobile: false });
    }

    if (state.mobileView !== "reader" || !state.selectedSongId) {
      setMobileView("list");
    } else {
      setMobileView("reader");
    }
  } else {
    if (state.selectedSongId) {
      selectSong(state.selectedSongId, { revealMobile: false });
    }
    document.body.dataset.mobileView = "desktop";
  }
}

elements.searchInput.addEventListener("input", resetListAndApplyFilters);
elements.sortSelect.addEventListener("change", resetListAndApplyFilters);
elements.fileInput.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }

  const text = await file.text();
  const songs = JSON.parse(text);
  state.loadedFromLocalStorage = false;
  elements.fileFallback.classList.add("hidden");
  setSongs(songs);
});

elements.editSongButton.addEventListener("click", beginEdit);
elements.saveSongButton.addEventListener("click", saveCurrentSong);
elements.cancelEditButton.addEventListener("click", cancelEdit);
elements.deleteSongButton.addEventListener("click", deleteCurrentSong);
elements.exportLibraryButton.addEventListener("click", exportSongs);
elements.addSongButton.addEventListener("click", addNewSong);
elements.favoriteFilterButton.addEventListener("click", toggleFavoritesFilter);
elements.favoriteSongButton.addEventListener("click", toggleSelectedSongFavorite);
elements.themeToggleButton.addEventListener("click", toggleTheme);
elements.mobileBackButton.addEventListener("click", () => setMobileView("list"));

if (typeof MOBILE_BREAKPOINT.addEventListener === "function") {
  MOBILE_BREAKPOINT.addEventListener("change", syncResponsiveLayout);
} else if (typeof MOBILE_BREAKPOINT.addListener === "function") {
  MOBILE_BREAKPOINT.addListener(syncResponsiveLayout);
}

if (getModeFromUrl() === "edit" && isReadOnlyDeployment()) {
  window.location.replace("index.html");
} else if (getModeFromUrl() === "edit" && !promptForEditorAccess()) {
  // promptForEditorAccess handles redirect on failure.
} else {
  applyTheme(getSavedTheme());
  loadFavorites();
  state.typesenseConfig = getTypesenseConfig();
  syncResponsiveLayout();
  loadSongs();
}
