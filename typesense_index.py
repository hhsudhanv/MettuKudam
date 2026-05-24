#!/usr/bin/env python3
"""Index data/songs.json into a Typesense collection."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Dict, Iterable

import requests


ROOT_DIR = Path(__file__).resolve().parent
SONGS_JSON = ROOT_DIR / "data" / "songs.json"
SCHEMA_JSON = ROOT_DIR / "typesense_schema.json"


def load_json(path: Path):
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def typesense_url(path: str) -> str:
    protocol = os.environ.get("TYPESENSE_PROTOCOL", "http").rstrip(":")
    host = os.environ.get("TYPESENSE_HOST", "localhost")
    port = os.environ.get("TYPESENSE_PORT", "8108")
    base_url = f"{protocol}://{host}"
    if port:
        base_url = f"{base_url}:{port}"
    return f"{base_url}{path}"


def headers() -> Dict[str, str]:
    api_key = os.environ.get("TYPESENSE_API_KEY", "")
    if not api_key:
        raise SystemExit("Set TYPESENSE_API_KEY to an admin key before indexing.")

    return {
        "Content-Type": "application/json",
        "X-TYPESENSE-API-KEY": api_key,
    }


def collection_name() -> str:
    return os.environ.get("TYPESENSE_COLLECTION", "songs")


def ensure_collection(recreate: bool) -> None:
    schema = load_json(SCHEMA_JSON)
    schema["name"] = collection_name()

    if recreate:
        response = requests.delete(
            typesense_url(f"/collections/{collection_name()}"),
            headers=headers(),
            timeout=30,
        )
        if response.status_code not in {200, 404}:
            response.raise_for_status()

    response = requests.post(
        typesense_url("/collections"),
        headers=headers(),
        data=json.dumps(schema),
        timeout=30,
    )

    if response.status_code == 409:
        return

    response.raise_for_status()


def documents() -> Iterable[Dict[str, str]]:
    songs = load_json(SONGS_JSON)
    for song in songs:
        yield {
            "id": str(song.get("id", "")),
            "slug": str(song.get("slug", "")),
            "title": str(song.get("title", "")),
            "film_name": str(song.get("film_name", "")),
            "full_notes": str(song.get("full_notes", "")),
            "raw_text": str(song.get("raw_text", "")),
            "source_url": str(song.get("source_url", "")),
            "relative_path": str(song.get("relative_path", "")),
            "content_type": str(song.get("content_type", "")),
        }


def import_documents() -> None:
    payload = "\n".join(json.dumps(document) for document in documents())
    response = requests.post(
        typesense_url(f"/collections/{collection_name()}/documents/import"),
        params={"action": "upsert"},
        headers={**headers(), "Content-Type": "text/plain"},
        data=payload.encode("utf-8"),
        timeout=120,
    )
    response.raise_for_status()

    failed = []
    for line in response.text.splitlines():
        result = json.loads(line)
        if not result.get("success"):
            failed.append(result)

    if failed:
        preview = json.dumps(failed[:3], indent=2)
        raise SystemExit(f"Typesense import had {len(failed)} failures:\n{preview}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--recreate",
        action="store_true",
        help="Delete and recreate the collection before importing.",
    )
    args = parser.parse_args()

    ensure_collection(args.recreate)
    import_documents()
    print(f"Indexed {len(load_json(SONGS_JSON))} songs into {collection_name()}.")


if __name__ == "__main__":
    main()
