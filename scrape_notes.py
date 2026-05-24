#!/usr/bin/env python3
"""
Scrape and back up song-note pages from https://www.newtfmpage.com/notes/.

The scraper is designed to be practical rather than clever:
- Uses requests + BeautifulSoup
- Sleeps 1-2 seconds between requests by default
- Retries failures 3 times total
- Writes results incrementally so progress survives interruptions
- Resumes from a saved crawler state

Output structure:
    data/
        songs.json
        songs.jsonl
        failed_urls.txt
        crawl_state.json
        txt/
            <slug>.txt
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import re
import sys
import time
from collections import deque
from pathlib import Path
from typing import Deque, Dict, Iterable, List, Optional, Set
from urllib.parse import parse_qs, urljoin, urlparse, urlunparse

import requests
from bs4 import BeautifulSoup


BASE_URL = "https://www.newtfmpage.com"
START_URL = f"{BASE_URL}/notes/"
ALLOWED_HOSTS = {"newtfmpage.com", "www.newtfmpage.com", "notes.newtfmpage.com"}
STATE_VERSION = 1

ROOT_DIR = Path(__file__).resolve().parent
DATA_DIR = ROOT_DIR / "data"
TXT_DIR = DATA_DIR / "txt"
SONGS_JSON = DATA_DIR / "songs.json"
SONGS_JSONL = DATA_DIR / "songs.jsonl"
FAILED_URLS = DATA_DIR / "failed_urls.txt"
STATE_FILE = DATA_DIR / "crawl_state.json"


def ensure_dirs() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    TXT_DIR.mkdir(parents=True, exist_ok=True)


def canonicalize_url(url: str, base_url: Optional[str] = None) -> Optional[str]:
    """Normalize URLs so duplicate pages are visited only once."""
    if not url:
        return None

    joined = urljoin(base_url or BASE_URL, url.strip())
    parsed = urlparse(joined)

    if parsed.scheme not in {"http", "https"}:
        return None
    if not parsed.netloc:
        return None

    host = parsed.netloc.lower()
    if host not in ALLOWED_HOSTS:
        return None

    path = parsed.path or "/"
    if path != "/" and path.endswith("/index.html"):
        path = path[: -len("index.html")]
    if not path:
        path = "/"

    # Keep query strings because some notes database pages use them for discovery.
    normalized = parsed._replace(
        scheme="https",
        netloc="www.newtfmpage.com",
        path=path,
        fragment="",
    )
    return urlunparse(normalized)


def is_notes_discovery_url(url: str) -> bool:
    """Allow the narrow CGI database page that /notes/ uses for navigation."""
    parsed = urlparse(url)
    if parsed.path != "/cgi-bin/gendb.pl":
        return False

    query = parse_qs(parsed.query)
    dbpath = query.get("dbpath", [])
    return any(value == "notes" for value in dbpath)


def is_allowed_url(url: str) -> bool:
    parsed = urlparse(url)
    if parsed.path == "/notes" or parsed.path.startswith("/notes/"):
        return True
    return is_notes_discovery_url(url)


def looks_like_song_page(url: str, soup: BeautifulSoup, cleaned_text: str) -> bool:
    parsed = urlparse(url)
    path = parsed.path.lower()

    if path.endswith(".txt"):
        return True

    if soup.find("pre"):
        return True

    hints = ("song:", "film:", "notes:")
    lowered = cleaned_text.lower()
    return sum(hint in lowered for hint in hints) >= 2


def clean_whitespace(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = [line.rstrip() for line in text.split("\n")]
    collapsed: List[str] = []
    last_blank = False
    for line in lines:
        blank = not line.strip()
        if blank and last_blank:
            continue
        collapsed.append(line)
        last_blank = blank
    return "\n".join(collapsed).strip()


def extract_visible_text(soup: BeautifulSoup) -> str:
    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()

    pre_blocks = [block.get_text("\n", strip=False) for block in soup.find_all("pre")]
    if pre_blocks:
        joined = "\n\n".join(block for block in pre_blocks if block.strip())
        if joined.strip():
            return clean_whitespace(joined)

    body = soup.body or soup
    return clean_whitespace(body.get_text("\n", strip=False))


def extract_metadata_from_text(text: str) -> Dict[str, str]:
    title = ""
    film = ""
    notes = ""

    lines = text.splitlines()
    notes_start_index: Optional[int] = None
    title_pattern = re.compile(r"^\s*(song|title)\s*[:\-]\s*(.+?)\s*$", re.IGNORECASE)
    film_pattern = re.compile(r"^\s*(film|movie)\s*[:\-]\s*(.+?)\s*$", re.IGNORECASE)
    notes_pattern = re.compile(r"^\s*notes\s*[:\-]\s*(.*)$", re.IGNORECASE)

    for index, line in enumerate(lines):
        stripped = line.strip()
        if not stripped:
            continue

        title_match = title_pattern.match(stripped)
        if title_match and not title:
            title = title_match.group(2).strip()
            continue

        film_match = film_pattern.match(stripped)
        if film_match and not film:
            film = film_match.group(2).strip()
            continue

        notes_match = notes_pattern.match(stripped)
        if notes_match and notes_start_index is None:
            notes_start_index = index
            first_line = notes_match.group(1).strip()
            remaining = lines[index + 1 :]
            notes = clean_whitespace("\n".join([first_line] + remaining)).strip()
            break

    if not notes:
        notes = text.strip()

    return {
        "title": title,
        "film_name": film,
        "full_notes": notes,
    }


def slug_from_url(url: str) -> str:
    parsed = urlparse(url)
    relative = parsed.path.removeprefix("/notes/").strip("/") or "notes-root"
    stem = relative.rsplit(".", 1)[0]
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", stem).strip("-").lower()
    return slug or "song"


def song_id_from_url(url: str) -> str:
    return hashlib.sha1(url.encode("utf-8")).hexdigest()[:12]


def render_song_text(song: Dict[str, str]) -> str:
    parts = [
        f"Title: {song.get('title') or 'Unknown'}",
        f"Film: {song.get('film_name') or 'Unknown'}",
        f"Source URL: {song['source_url']}",
        "",
        song.get("full_notes") or song.get("raw_text") or "",
    ]
    return "\n".join(parts).strip() + "\n"


def write_json(path: Path, payload: object) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def parse_backup_txt_file(path: Path) -> Optional[Dict[str, str]]:
    """Parse one saved backup text file back into a song record."""
    text = path.read_text(encoding="utf-8").replace("\r\n", "\n").replace("\r", "\n")
    lines = text.split("\n")

    title = ""
    film = ""
    source_url = ""
    body_start = 0

    for index, line in enumerate(lines):
        stripped = line.strip()
        lower = stripped.lower()

        if lower.startswith("title:") and not title:
            title = stripped.split(":", 1)[1].strip()
            body_start = index + 1
            continue
        if lower.startswith("film:") and not film:
            film = stripped.split(":", 1)[1].strip()
            body_start = index + 1
            continue
        if lower.startswith("source url:") and not source_url:
            source_url = stripped.split(":", 1)[1].strip()
            body_start = index + 1
            continue

    notes = clean_whitespace("\n".join(lines[body_start:])).strip()
    if not source_url:
        return None

    slug = path.stem
    return {
        "id": song_id_from_url(source_url),
        "slug": slug,
        "title": "" if title == "Unknown" else title,
        "film_name": "" if film == "Unknown" else film,
        "full_notes": notes,
        "raw_text": notes,
        "source_url": source_url,
        "relative_path": urlparse(source_url).path.removeprefix("/notes/").lstrip("/"),
        "content_type": "text/plain",
    }


class NotesScraper:
    def __init__(self, delay_min: float = 1.0, delay_max: float = 2.0, max_pages: Optional[int] = None):
        self.delay_min = delay_min
        self.delay_max = delay_max
        self.max_pages = max_pages

        self.session = requests.Session()
        # Ignore broken or unwanted proxy settings inherited from the shell
        # so the scraper can connect directly unless the code is edited to do otherwise.
        self.session.trust_env = False
        self.session.headers.update(
            {
                "User-Agent": (
                    "TamilSongSwarasBackup/1.0 "
                    "(requests; respectful local archival script for offline browsing)"
                )
            }
        )

        self.queue: Deque[str] = deque()
        self.queued_urls: Set[str] = set()
        self.visited_urls: Set[str] = set()
        self.failed_url_set: Set[str] = set()
        self.songs_by_url: Dict[str, Dict[str, str]] = {}

    def load_existing_outputs(self) -> None:
        if SONGS_JSONL.exists():
            with SONGS_JSONL.open("r", encoding="utf-8") as handle:
                for line in handle:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        song = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    source_url = song.get("source_url")
                    if source_url:
                        self.songs_by_url[source_url] = song

        # Backfill or rebuild from the plain-text backups since those files are
        # meant to be durable local copies and can restore metadata for the viewer.
        if TXT_DIR.exists():
            for txt_path in sorted(TXT_DIR.glob("*.txt")):
                backup_song = parse_backup_txt_file(txt_path)
                if not backup_song:
                    continue

                source_url = backup_song["source_url"]
                existing = self.songs_by_url.get(source_url)
                if not existing:
                    self.songs_by_url[source_url] = backup_song
                    continue

                if not existing.get("title") and backup_song.get("title"):
                    existing["title"] = backup_song["title"]
                if not existing.get("film_name") and backup_song.get("film_name"):
                    existing["film_name"] = backup_song["film_name"]
                if not existing.get("full_notes") and backup_song.get("full_notes"):
                    existing["full_notes"] = backup_song["full_notes"]
                if not existing.get("raw_text") and backup_song.get("raw_text"):
                    existing["raw_text"] = backup_song["raw_text"]

        if STATE_FILE.exists():
            try:
                state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                state = {}
            self.visited_urls = set(state.get("visited_urls", []))
            self.failed_url_set = set(state.get("failed_urls", []))
            pending_urls = state.get("pending_urls", [])
            for url in pending_urls:
                self.enqueue(url)

        if not self.queue:
            self.enqueue(START_URL)

    def save_state(self) -> None:
        state = {
            "version": STATE_VERSION,
            "visited_urls": sorted(self.visited_urls),
            "pending_urls": list(self.queue),
            "failed_urls": sorted(self.failed_url_set),
            "song_count": len(self.songs_by_url),
        }
        write_json(STATE_FILE, state)
        FAILED_URLS.write_text("\n".join(sorted(self.failed_url_set)) + ("\n" if self.failed_url_set else ""), encoding="utf-8")

    def rebuild_songs_json(self) -> None:
        songs = sorted(
            self.songs_by_url.values(),
            key=lambda item: (
                (item.get("title") or "").lower(),
                (item.get("film_name") or "").lower(),
                item.get("source_url") or "",
            ),
        )
        write_json(SONGS_JSON, songs)

    def enqueue(self, url: Optional[str]) -> None:
        if not url:
            return
        normalized = canonicalize_url(url)
        if not normalized or not is_allowed_url(normalized):
            return
        if normalized in self.visited_urls or normalized in self.queued_urls:
            return
        self.queue.append(normalized)
        self.queued_urls.add(normalized)

    def fetch(self, url: str) -> Optional[requests.Response]:
        attempts = 3
        for attempt in range(1, attempts + 1):
            try:
                response = self.session.get(url, timeout=45)
                response.raise_for_status()
                response.encoding = response.encoding or "utf-8"
                return response
            except requests.RequestException as exc:
                print(f"[warn] Attempt {attempt}/{attempts} failed for {url}: {exc}", file=sys.stderr)
                if attempt == attempts:
                    return None
                time.sleep(2)
        return None

    def extract_links(self, url: str, soup: BeautifulSoup) -> Iterable[str]:
        for tag in soup.find_all(["a", "frame", "iframe"]):
            href = tag.get("href") or tag.get("src")
            normalized = canonicalize_url(href, base_url=url)
            if normalized and is_allowed_url(normalized):
                yield normalized

    def parse_song(self, url: str, response: requests.Response, soup: BeautifulSoup) -> Optional[Dict[str, str]]:
        cleaned_text = extract_visible_text(soup)
        if not cleaned_text:
            return None
        if not looks_like_song_page(url, soup, cleaned_text):
            return None

        metadata = extract_metadata_from_text(cleaned_text)
        relative_path = urlparse(url).path.removeprefix("/notes/").lstrip("/")

        song = {
            "id": song_id_from_url(url),
            "slug": slug_from_url(url),
            "title": metadata["title"],
            "film_name": metadata["film_name"],
            "full_notes": metadata["full_notes"],
            "raw_text": cleaned_text,
            "source_url": url,
            "relative_path": relative_path,
            "content_type": response.headers.get("Content-Type", ""),
        }
        return song

    def save_song(self, song: Dict[str, str]) -> None:
        source_url = song["source_url"]
        if source_url in self.songs_by_url:
            return

        self.songs_by_url[source_url] = song

        with SONGS_JSONL.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(song, ensure_ascii=False) + "\n")

        txt_path = TXT_DIR / f"{song['slug']}.txt"
        txt_path.write_text(render_song_text(song), encoding="utf-8")

        self.rebuild_songs_json()

    def enrich_existing_songs(self) -> None:
        """Repair missing metadata from stored raw text and refresh TXT backups."""
        changed = False

        for song in self.songs_by_url.values():
            raw_text = song.get("raw_text") or ""
            if raw_text:
                metadata = extract_metadata_from_text(raw_text)
                if not song.get("title") and metadata.get("title"):
                    song["title"] = metadata["title"]
                    changed = True
                if not song.get("film_name") and metadata.get("film_name"):
                    song["film_name"] = metadata["film_name"]
                    changed = True
                if not song.get("full_notes") and metadata.get("full_notes"):
                    song["full_notes"] = metadata["full_notes"]
                    changed = True

            txt_path = TXT_DIR / f"{song['slug']}.txt"
            txt_path.write_text(render_song_text(song), encoding="utf-8")

        if changed:
            with SONGS_JSONL.open("w", encoding="utf-8") as handle:
                for song in self.songs_by_url.values():
                    handle.write(json.dumps(song, ensure_ascii=False) + "\n")

    def crawl(self) -> None:
        processed = 0

        while self.queue:
            if self.max_pages is not None and processed >= self.max_pages:
                print(f"[info] Reached --max-pages limit ({self.max_pages}).")
                break

            url = self.queue.popleft()
            self.queued_urls.discard(url)

            if url in self.visited_urls:
                continue

            print(f"[fetch] {url}")
            response = self.fetch(url)
            self.visited_urls.add(url)
            processed += 1

            if response is None:
                self.failed_url_set.add(url)
                self.save_state()
                self.sleep_between_requests()
                continue

            soup = BeautifulSoup(response.text, "html.parser")

            for link in self.extract_links(url, soup):
                self.enqueue(link)

            # Save only true /notes/ content pages, not the navigation CGI pages.
            if urlparse(url).path.startswith("/notes"):
                song = self.parse_song(url, response, soup)
                if song:
                    self.save_song(song)

            self.save_state()
            self.sleep_between_requests()

        self.save_state()
        self.rebuild_songs_json()
        print(
            f"[done] Visited {len(self.visited_urls)} pages, "
            f"saved {len(self.songs_by_url)} songs, "
            f"failed {len(self.failed_url_set)} URLs."
        )

    def sleep_between_requests(self) -> None:
        delay = random.uniform(self.delay_min, self.delay_max)
        time.sleep(delay)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Scrape and locally back up newtfmpage notes.")
    parser.add_argument("--delay-min", type=float, default=1.0, help="Minimum delay between requests in seconds.")
    parser.add_argument("--delay-max", type=float, default=2.0, help="Maximum delay between requests in seconds.")
    parser.add_argument("--max-pages", type=int, default=None, help="Optional limit for testing.")
    parser.add_argument(
        "--rebuild-json-only",
        action="store_true",
        help="Rebuild songs.json from existing JSONL and TXT backups without crawling.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    if args.delay_min <= 0 or args.delay_max <= 0:
        print("Delay values must be positive.", file=sys.stderr)
        return 1
    if args.delay_min > args.delay_max:
        print("--delay-min cannot be greater than --delay-max.", file=sys.stderr)
        return 1

    ensure_dirs()
    scraper = NotesScraper(delay_min=args.delay_min, delay_max=args.delay_max, max_pages=args.max_pages)
    scraper.load_existing_outputs()
    scraper.enrich_existing_songs()

    if args.rebuild_json_only:
        scraper.rebuild_songs_json()
        print(f"[done] Rebuilt {SONGS_JSON} from existing backup files.")
        return 0

    scraper.crawl()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
