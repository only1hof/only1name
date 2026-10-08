
import io
import json
import re
import shutil
import sys
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
    """Convert a Google Sheets URL to a CSV export URL."""
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
    """Extract a Google Drive file ID from a URL or bare ID."""
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


def get_listing_value(item, key):
    """Read a field from a gdown listing object or dictionary."""
    if isinstance(item, dict):
        return item.get(key)

    return getattr(item, key, None)


def download_drive_folder(folder_url, cache_dir):
    """
    List the public Drive folder, then download its contents
    with one folder-level gdown call.

    Returns a mapping:
        Google Drive file ID -> local downloaded file path
    """
    print("\nReading Google Drive folder listing...")

    listing = gdown.download_folder(
        url=folder_url,
        output=str(cache_dir),
        quiet=True,
        use_cookies=False,
        skip_download=True,
    )

    if not listing:
        raise RuntimeError(
            "Could not list the Google Drive folder. "
            "Check the folder URL, sharing permissions, and gdown version."
        )

    file_paths = {}

    for item in listing:
        file_url = get_listing_value(item, "url")
        relative_path = get_listing_value(item, "path")

        file_id = extract_drive_file_id(file_url)

        if not file_id or not relative_path:
            continue

        file_paths[file_id] = cache_dir / relative_path

    if not file_paths:
        raise RuntimeError(
            "The Drive folder listing did not contain usable file IDs and paths."
        )

    print(f"Found {len(file_paths)} files in the Drive folder.")
    print("Downloading the folder contents...")

    downloaded = gdown.download_folder(
        url=folder_url,
        output=str(cache_dir),
        quiet=False,
        use_cookies=False,
    )

    if not downloaded:
        raise RuntimeError(
            "Google Drive folder download failed. "
            "Check folder permissions and the gdown output."
        )

    # Verify that the files listed by Drive actually exist locally.
    available_paths = {
        file_id: path
        for file_id, path in file_paths.items()
        if path.is_file() and path.stat().st_size > 0
    }

    print(
        f"Downloaded {len(available_paths)} of "
        f"{len(file_paths)} listed files."
    )

    return available_paths


# --------------------------------------------------
# Image validation and conversion
# --------------------------------------------------

def verify_image_readable(path):
    """Verify that an image can be fully decoded."""
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
    """Convert an image to JPEG and validate the output before publishing."""
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

            # JPEG does not support transparency. Use a white background.
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
                    background,
                    rgba,
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
            raise RuntimeError("JPEG conversion produced an empty file.")

        with Image.open(temp_jpeg) as check:
            if check.format != "JPEG":
                raise RuntimeError("Converted file is not a JPEG.")

            if check.mode != "RGB":
                raise RuntimeError("Converted JPEG is not in RGB mode.")

            check.load()

            if check.width <= 0 or check.height <= 0:
                raise RuntimeError("Converted JPEG has invalid dimensions.")

            converted_size = check.size

        with open(temp_jpeg, "rb") as file:
            if file.read(3) != b"\xff\xd8\xff":
                raise RuntimeError("Invalid JPEG file signature.")

        temp_jpeg.replace(final_path)

        print(
            f"  Verified: {final_path} "
            f"({original_size[0]}x{original_size[1]} -> "
            f"{converted_size[0]}x{converted_size[1]})"
        )

        return final_path

    except Exception:
        temp_jpeg.unlink(missing_ok=True)
        final_path.unlink(missing_ok=True)
        raise


# --------------------------------------------------
# Photos directory cleanup
# --------------------------------------------------

def clean_photos_directory(photos_dir, keep_paths):
    """
    Keep only the JPEGs referenced by the newly generated JSON.
    Remove old JPEGs, PNGs, HEICs, and other leftover files.
    """
    keep_paths = {
        Path(path).resolve()
        for path in keep_paths
    }

    for path in photos_dir.iterdir():
        if not path.is_file():
            continue

        if path.resolve() not in keep_paths:
            path.unlink()
            print(f"Removed old or unused file: {path}")


# --------------------------------------------------
# Main
# --------------------------------------------------

def main():
    if len(sys.argv) != 3:
        print(
            "Usage:\n"
            '  python3 sync.py "GOOGLE_SHEET_URL" '
            '"GOOGLE_DRIVE_FOLDER_URL"'
        )
        sys.exit(1)

    sheet_url = sys.argv[1]
    folder_url = sys.argv[2]

    if not re.search(
        r"drive\.google\.com/drive/(?:u/\d+/)?folders/",
        folder_url,
    ):
        raise ValueError(
            "The second URL does not look like a Google Drive folder URL."
        )

    PHOTOS_DIR.mkdir(parents=True, exist_ok=True)

    # Fetch the public Google Sheet.
    csv_url = get_sheet_csv_url(sheet_url)

    response = requests.get(csv_url, timeout=30)
    response.raise_for_status()

    df = pd.read_csv(
        io.StringIO(response.content.decode("utf-8-sig"))
    )
    df.columns = df.columns.str.strip()

    for required_column in (NAME_COLUMN, PHOTO_COLUMN):
        if required_column not in df.columns:
            raise ValueError(
                f"Column not found: {required_column!r}\n"
                f"Available columns: {list(df.columns)}"
            )

    contestants = []
    failures = []

    # The temporary directory is removed when processing finishes.
    with tempfile.TemporaryDirectory(
        prefix="only1name_drive_"
    ) as temp_directory:

        cache_dir = Path(temp_directory)

        # Download the folder contents before processing contestants.
        drive_files = download_drive_folder(folder_url, cache_dir)

        for row_number, row in df.iterrows():
            name_value = row[NAME_COLUMN]
            photo_value = row[PHOTO_COLUMN]

            name = (
                str(name_value).strip()
                if pd.notna(name_value)
                else ""
            )

            photo_cell = (
                str(photo_value).strip()
                if pd.notna(photo_value)
                else ""
            )

            if not name:
                continue

            file_id = extract_drive_file_id(photo_cell)

            if not file_id:
                failures.append(
                    f"Row {row_number + 2}, {name!r}: "
                    "could not extract a Drive file ID"
                )
                continue

            source_path = drive_files.get(file_id)

            if source_path is None or not source_path.is_file():
                failures.append(
                    f"Row {row_number + 2}, {name!r}: "
                    "photo was not found in the downloaded Drive folder"
                )
                continue

            contestant_number = len(contestants) + 1
            contestant_id = f"contestant-{contestant_number:03d}"
            base_path = PHOTOS_DIR / contestant_id

            try:
                print(f"\nProcessing row {row_number + 2}: {name}")

                photo_path = convert_to_jpeg(
                    source_path,
                    base_path,
                )

                contestants.append(
                    {
                        "id": contestant_id,
                        "name": name,
                        "photo": photo_path.as_posix(),
                    }
                )

                print(f"  Success: {name} -> {photo_path}")

            except Exception as error:
                failures.append(
                    f"Row {row_number + 2}, {name!r}: {error}"
                )
                print(f"  FAILED: {error}")

    # Do not replace the JSON if no contestants were processed.
    if not contestants:
        raise RuntimeError(
            "No contestants were generated. "
            "The existing contestants.json was not replaced. "
            "Check the Sheet, folder permissions, and image files."
        )

    json_content = (
        json.dumps(
            contestants,
            indent=2,
            ensure_ascii=False,
        )
        + "\n"
    )

    temp_json_path = JSON_PATH.with_name(JSON_PATH.name + ".tmp")

    try:
        temp_json_path.write_text(
            json_content,
            encoding="utf-8",
        )

        # Validate the JSON before replacing the existing file.
        json.loads(temp_json_path.read_text(encoding="utf-8"))
        temp_json_path.replace(JSON_PATH)

    finally:
        temp_json_path.unlink(missing_ok=True)

    # Keep only the JPEGs referenced by the newly written JSON.
    clean_photos_directory(
        PHOTOS_DIR,
        [contestant["photo"] for contestant in contestants],
    )

    print(
        f"\nCreated {JSON_PATH} with "
        f"{len(contestants)} verified contestants."
    )

    if failures:
        print(f"\nWARNING: {len(failures)} row(s) failed:")

        for failure in failures:
            print(f"  - {failure}")

        print(
            "\nThe JSON contains only successful conversions. "
            "Review the failures before publishing."
        )


if __name__ == "__main__":
    main()