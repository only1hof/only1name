
import io
import json
import re
import sys
import shutil
import tempfile
from pathlib import Path
from urllib.parse import urlparse, parse_qs

import gdown
import pandas as pd
import requests
from PIL import Image, ImageOps
from pillow_heif import register_heif_opener


# --------------------------------------------------
# Configuration
# --------------------------------------------------

PHOTOS_DIR = Path("photos")
JSON_PATH = Path("contestants.json")
MANIFEST_PATH = Path(".sync_manifest.json")

NAME_COLUMN = "First name"
PHOTO_COLUMN = (
    "Upload a picture of yourself. Please make sure you are "
    "the person in the picture and that you have the right "
    "to submit the photo."
)

JPEG_QUALITY = 95

register_heif_opener()


# --------------------------------------------------
# Google Sheets
# --------------------------------------------------

def get_sheet_csv_url(sheet_url):
    match = re.search(
        r"/spreadsheets/d/([a-zA-Z0-9_-]+)",
        sheet_url,
    )

    if not match:
        raise ValueError("Could not find the Google Sheets spreadsheet ID.")

    spreadsheet_id = match.group(1)
    parsed = urlparse(sheet_url)
    params = parse_qs(parsed.query)

    gid = params.get("gid", [None])[0]

    if not gid and parsed.fragment:
        gid = parse_qs(parsed.fragment).get("gid", [None])[0]

    csv_url = (
        f"https://docs.google.com/spreadsheets/d/"
        f"{spreadsheet_id}/export?format=csv"
    )

    if gid:
        csv_url += f"&gid={gid}"

    return csv_url


# --------------------------------------------------
# Google Drive
# --------------------------------------------------

def extract_drive_file_id(value):
    if not isinstance(value, str):
        return None

    value = value.strip()

    patterns = [
        r"drive\.google\.com/file/d/([a-zA-Z0-9_-]+)",
        r"drive\.google\.com/open\?id=([a-zA-Z0-9_-]+)",
        r"drive\.google\.com/uc\?(?:[^#]*&)?id=([a-zA-Z0-9_-]+)",
        r"docs\.google\.com/uc\?(?:[^#]*&)?id=([a-zA-Z0-9_-]+)",
    ]

    for pattern in patterns:
        match = re.search(pattern, value)
        if match:
            return match.group(1)

    if re.fullmatch(r"[a-zA-Z0-9_-]{20,}", value):
        return value

    return None


def download_photo(file_id, destination_without_extension):
    """Download one missing or changed image using cached browser cookies."""

    temp_path = destination_without_extension.with_suffix(".download")
    temp_path.unlink(missing_ok=True)

    print(f"  Downloading Drive file: {file_id}")

    result = gdown.download(
        id=file_id,
        output=str(temp_path),
        quiet=False,
        use_cookies=True,
        retries=3,
    )

    if not result or not temp_path.exists():
        temp_path.unlink(missing_ok=True)
        raise RuntimeError(
            f"Download failed for Drive file {file_id}"
        )

    if temp_path.stat().st_size == 0:
        temp_path.unlink(missing_ok=True)
        raise RuntimeError(
            f"Downloaded file {file_id} is empty"
        )

    return temp_path

# --------------------------------------------------
# Existing state and cache
# --------------------------------------------------

def load_json_if_exists(path, default):
    if not path.exists():
        return default

    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as error:
        raise RuntimeError(
            f"Could not read {path}: {error}. "
            "Fix or restore the file before syncing."
        ) from error


def is_valid_jpeg(path):
    """Return True only if the file is a fully readable JPEG."""
    try:
        with Image.open(path) as image:
            if image.format != "JPEG":
                return False
            image.verify()

        with Image.open(path) as image:
            image.load()
            return image.width > 0 and image.height > 0

    except Exception:
        return False


def build_legacy_name_index(old_contestants):
    """
    Index existing JSON entries by name for first-run migration.
    Duplicate names are kept as lists and consumed only once.
    """
    result = {}

    for contestant in old_contestants:
        if not isinstance(contestant, dict):
            continue

        name = str(contestant.get("name", "")).strip()
        photo = contestant.get("photo", "")

        if name and photo:
            result.setdefault(name, []).append(photo)

    return result


def find_legacy_photo(name, legacy_index, already_used):
    """Find a valid existing photo for a name during migration."""
    for photo in legacy_index.get(name, []):
        path = Path(photo)

        if not path.is_absolute():
            path = Path.cwd() / path

        resolved = path.resolve()

        if resolved in already_used:
            continue

        if path.is_file() and is_valid_jpeg(path):
            already_used.add(resolved)
            return path

    return None


# --------------------------------------------------
# Image conversion and validation
# --------------------------------------------------

def verify_image_readable(path):
    try:
        with Image.open(path) as image:
            image.verify()

        with Image.open(path) as image:
            image.load()

            if image.width <= 0 or image.height <= 0:
                raise ValueError("Image has invalid dimensions")

            return image.size

    except Exception as error:
        raise RuntimeError(
            f"Downloaded file is not a valid, readable image: {error}"
        ) from error


def convert_to_jpeg(source_path, destination_without_extension):
    """Convert an image and validate the resulting JPEG."""
    final_path = destination_without_extension.with_suffix(".jpg")
    temp_jpeg = destination_without_extension.with_name(
        destination_without_extension.name + ".tmp.jpg"
    )

    temp_jpeg.unlink(missing_ok=True)

    try:
        original_size = verify_image_readable(source_path)

        with Image.open(source_path) as source:
            source.seek(0)
            image = ImageOps.exif_transpose(source)

            if (
                image.mode in ("RGBA", "LA")
                or (
                    image.mode == "P"
                    and "transparency" in image.info
                )
            ):
                rgba = image.convert("RGBA")
                background = Image.new(
                    "RGBA",
                    rgba.size,
                    (255, 255, 255, 255),
                )
                image = Image.alpha_composite(
                    background, rgba
                ).convert("RGB")
            else:
                image = image.convert("RGB")

            image.save(
                temp_jpeg,
                format="JPEG",
                quality=JPEG_QUALITY,
                optimize=True,
                progressive=True,
            )

        if not temp_jpeg.exists() or temp_jpeg.stat().st_size == 0:
            raise RuntimeError("JPEG conversion produced an empty file")

        with Image.open(temp_jpeg) as check:
            if check.format != "JPEG" or check.mode != "RGB":
                raise RuntimeError("Converted image is not an RGB JPEG")

            check.load()

            if check.width <= 0 or check.height <= 0:
                raise RuntimeError("Converted JPEG has invalid dimensions")

            converted_size = check.size

        with open(temp_jpeg, "rb") as file:
            if file.read(3) != b"\xff\xd8\xff":
                raise RuntimeError("Invalid JPEG file signature")

        temp_jpeg.replace(final_path)

        print(
            f"  Verified JPEG: {final_path.name} "
            f"({original_size[0]}x{original_size[1]} -> "
            f"{converted_size[0]}x{converted_size[1]})"
        )

        return final_path

    except Exception:
        temp_jpeg.unlink(missing_ok=True)
        final_path.unlink(missing_ok=True)
        raise


# --------------------------------------------------
# Safe file writing and cleanup
# --------------------------------------------------

def write_json_atomically(path, data):
    temp_path = path.with_name(path.name + ".tmp")

    try:
        temp_path.write_text(
            json.dumps(data, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )

        # Validate before replacing the existing file.
        json.loads(temp_path.read_text(encoding="utf-8"))
        temp_path.replace(path)

    finally:
        temp_path.unlink(missing_ok=True)


def clean_photos_directory(keep_paths):
    """Keep only the JPEGs referenced by the current contestants.json."""
    keep = {
        Path(path).resolve()
        for path in keep_paths
    }

    for path in PHOTOS_DIR.iterdir():
        if not path.is_file():
            continue

        if path.resolve() not in keep:
            path.unlink()
            print(f"Removed obsolete file: {path}")


# --------------------------------------------------
# Main
# --------------------------------------------------

def main():
    if len(sys.argv) != 3:
        print(
            'Usage: python3 sync.py "GOOGLE_SHEET_URL" '
            '"GOOGLE_DRIVE_FOLDER_URL"'
        )
        sys.exit(1)

    sheet_url = sys.argv[1]
    folder_url = sys.argv[2]

    if not re.search(
        r"drive\.google\.com/drive/(?:u/\d+/)?folders/",
        folder_url,
    ):
        raise ValueError("The second URL must be a Google Drive folder URL.")

    PHOTOS_DIR.mkdir(parents=True, exist_ok=True)

    # Fetch the current Sheet.
    response = requests.get(
        get_sheet_csv_url(sheet_url),
        timeout=30,
    )
    response.raise_for_status()

    df = pd.read_csv(
        io.StringIO(response.content.decode("utf-8-sig"))
    )
    df.columns = df.columns.str.strip()

    for column in (NAME_COLUMN, PHOTO_COLUMN):
        if column not in df.columns:
            raise ValueError(
                f"Column not found: {column!r}\n"
                f"Available columns: {list(df.columns)}"
            )

    old_contestants = load_json_if_exists(JSON_PATH, [])
    manifest_exists = MANIFEST_PATH.exists()
    manifest = load_json_if_exists(MANIFEST_PATH, {})

    if not isinstance(old_contestants, list):
        raise RuntimeError(f"{JSON_PATH} must contain a JSON list.")

    if not isinstance(manifest, dict):
        raise RuntimeError(f"{MANIFEST_PATH} must contain a JSON object.")

    legacy_index = build_legacy_name_index(old_contestants)
    used_legacy_photos = set()

    new_contestants = []
    new_manifest = {}
    pending_files = []
    failures = []
    reused_count = 0
    downloaded_count = 0

    # Keep temporary downloads and conversions outside photos/.
    with tempfile.TemporaryDirectory(
        prefix="only1name_sync_"
    ) as temp_directory:

        temp_dir = Path(temp_directory)

        for row_number, row in df.iterrows():
            name = (
                str(row[NAME_COLUMN]).strip()
                if pd.notna(row[NAME_COLUMN])
                else ""
            )

            photo_cell = (
                str(row[PHOTO_COLUMN]).strip()
                if pd.notna(row[PHOTO_COLUMN])
                else ""
            )

            if not name:
                continue

            file_id = extract_drive_file_id(photo_cell)

            if not file_id:
                failures.append(
                    f"Row {row_number + 2}, {name!r}: "
                    "could not extract Drive file ID"
                )
                continue

            try:
                cached_record = manifest.get(file_id)
                photo_path = None

                # Preferred path: reuse the photo previously mapped
                # to this exact Drive file ID.
                if isinstance(cached_record, dict):
                    cached_photo = cached_record.get("photo")

                    if cached_photo:
                        candidate = Path(cached_photo)

                        if not candidate.is_absolute():
                            candidate = Path.cwd() / candidate

                        if candidate.is_file() and is_valid_jpeg(candidate):
                            photo_path = candidate
                            reused_count += 1
                            print(f"Reusing: {name} ({candidate.name})")

                # First-run migration: reuse existing photos by name.
                # Do not use this fallback once a manifest exists,
                # because a changed Drive file ID should trigger a download.
                if photo_path is None and not manifest_exists:
                    legacy_photo = find_legacy_photo(
                        name,
                        legacy_index,
                        used_legacy_photos,
                    )

                    if legacy_photo is not None:
                        photo_path = legacy_photo
                        reused_count += 1
                        print(
                            f"Migrating existing photo for {name}: "
                            f"{legacy_photo.name}"
                        )

                # Only download if we could not reuse a valid JPEG.
                if photo_path is None:
                    print(f"\nDownloading new or changed photo: {name}")

                    downloaded_path = None

                    try:
                        downloaded_path = download_photo(
                            file_id,
                            temp_dir / f"download-{file_id}",
                        )

                        converted_path = convert_to_jpeg(
                            downloaded_path,
                            temp_dir / f"drive-{file_id}",
                        )

                    finally:
                        if downloaded_path is not None:
                            downloaded_path.unlink(missing_ok=True)

                    # Stable filename based on the Drive file ID.
                    # Commit this file to photos/ only after every
                    # Sheet entry has been processed successfully.
                    final_path = PHOTOS_DIR / f"drive-{file_id}.jpg"

                    pending_files.append(
                        (converted_path, final_path)
                    )

                    photo_path = final_path
                    downloaded_count += 1

                new_contestants.append(
                    {
                        "id": f"contestant-{len(new_contestants) + 1:03d}",
                        "name": name,
                        "photo": photo_path.as_posix(),
                    }
                )

                new_manifest[file_id] = {
                    "name": name,
                    "photo": photo_path.as_posix(),
                }

            except Exception as error:
                failures.append(
                    f"Row {row_number + 2}, {name!r}: {error}"
                )
                print(f"  FAILED: {error}")

        # Fail safely. Do not replace the JSON or delete existing photos
        # if any row failed.
        if failures:
            print(f"\nSync aborted: {len(failures)} row(s) failed.")

            for failure in failures:
                print(f"  - {failure}")

            raise RuntimeError(
                "Sync was incomplete. Existing contestants.json, "
                "manifest, and photos were preserved. Fix the failures "
                "and run the script again."
            )

        if not new_contestants:
            raise RuntimeError(
                "No contestants found. Existing files were preserved."
            )

        # Commit newly converted photos after all rows succeeded.
        for temp_photo, final_photo in pending_files:
            staging_path = final_photo.with_name(
                final_photo.stem + ".tmp.jpg"
            )

            try:
                shutil.copy2(temp_photo, staging_path)

                if not is_valid_jpeg(staging_path):
                    raise RuntimeError(
                        f"Staged JPEG failed validation: {staging_path}"
                    )

                staging_path.replace(final_photo)

            finally:
                staging_path.unlink(missing_ok=True)

        # Update JSON and manifest only after processing succeeds.
        write_json_atomically(JSON_PATH, new_contestants)
        write_json_atomically(MANIFEST_PATH, new_manifest)

    # Remove old photos only after the successful sync.
    clean_photos_directory(
        [contestant["photo"] for contestant in new_contestants]
    )

    print("\nSync completed successfully.")
    print(f"Contestants in Sheet: {len(new_contestants)}")
    print(f"Existing photos reused: {reused_count}")
    print(f"Photos downloaded and converted: {downloaded_count}")
    print(f"Updated: {JSON_PATH}")
    print(f"Updated: {MANIFEST_PATH}")


if __name__ == "__main__":
    main()