import csv
import io
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlparse, parse_qs

import gdown
import pandas as pd
import requests

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

# The script accepts your public Google Sheet URL and Drive
# folder URL as command-line arguments.


def get_sheet_csv_url(sheet_url):
    """Convert a standard Google Sheets URL into a CSV export URL."""
    match = re.search(r"/spreadsheets/d/([a-zA-Z0-9_-]+)", sheet_url)

    if not match:
        raise ValueError(
            "Could not find the Google Sheets spreadsheet ID. "
            "Use the normal Google Sheets viewer/edit URL."
        )

    spreadsheet_id = match.group(1)
    parsed = urlparse(sheet_url)

    # Preserve the selected sheet tab when a gid is present.
    params = parse_qs(parsed.query)
    gid = params.get("gid", [None])[0]

    if not gid and parsed.fragment:
        fragment_params = parse_qs(parsed.fragment)
        gid = fragment_params.get("gid", [None])[0]

    csv_url = (
        f"https://docs.google.com/spreadsheets/d/" f"{spreadsheet_id}/export?format=csv"
    )

    if gid:
        csv_url += f"&gid={gid}"

    return csv_url


def extract_drive_file_id(value):
    """Extract a Google Drive file ID from a response cell."""
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

    # Some cells contain a bare file ID.
    if re.fullmatch(r"[a-zA-Z0-9_-]{20,}", value):
        return value

    return None


def image_extension(path):
    """Identify common image types from their file signatures."""
    with open(path, "rb") as file:
        header = file.read(16)

    if header.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if header.startswith((b"GIF87a", b"GIF89a")):
        return ".gif"
    if header.startswith(b"RIFF") and header[8:12] == b"WEBP":
        return ".webp"
    if header.startswith(b"BM"):
        return ".bmp"
    if header.startswith(b"II*\x00") or header.startswith(b"MM\x00*"):
        return ".tiff"

    return None


def download_photo(file_id, destination_without_extension):
    """Download a public Drive image and detect its real extension."""
    temp_path = destination_without_extension.with_suffix(".download")

    result = gdown.download(
        id=file_id,
        output=str(temp_path),
        quiet=False,
        use_cookies=False,
    )

    if not result or not temp_path.exists():
        raise RuntimeError(f"Download failed for Drive file {file_id}")

    extension = image_extension(temp_path)

    if extension is None:
        temp_path.unlink(missing_ok=True)
        raise RuntimeError(
            f"Downloaded file {file_id} is not a recognized image. "
            "Check its Drive permissions and file type."
        )

    final_path = destination_without_extension.with_suffix(extension)
    temp_path.replace(final_path)

    return final_path


def main():
    if len(sys.argv) != 3:
        print(
            "Usage:\n"
            "  python3 build_contestants.py "
            '"GOOGLE_SHEET_URL" "GOOGLE_DRIVE_FOLDER_URL"'
        )
        sys.exit(1)

    sheet_url = sys.argv[1]
    folder_url = sys.argv[2]

    # Check that a Drive folder URL was supplied.
    if not re.search(r"drive\.google\.com/drive/(?:u/\d+/)?folders/", folder_url):
        raise ValueError("The second URL does not look like a Google Drive folder URL.")

    PHOTOS_DIR.mkdir(parents=True, exist_ok=True)

    # Fetch the public sheet as CSV.
    csv_url = get_sheet_csv_url(sheet_url)
    response = requests.get(csv_url, timeout=30)
    response.raise_for_status()

    # Read directly from the downloaded CSV.
    df = pd.read_csv(io.StringIO(response.content.decode("utf-8-sig")))
    df.columns = df.columns.str.strip()

    for required_column in (NAME_COLUMN, PHOTO_COLUMN):
        if required_column not in df.columns:
            raise ValueError(
                f"Column not found: {required_column!r}\n"
                f"Available columns: {list(df.columns)}"
            )

    contestants = []
    failures = []

    for row_number, row in df.iterrows():
        name = str(row[NAME_COLUMN]).strip()
        photo_cell = str(row[PHOTO_COLUMN]).strip()

        if not name or name.lower() == "nan":
            continue

        file_id = extract_drive_file_id(photo_cell)

        if not file_id:
            failures.append(
                f"Row {row_number + 2}: could not extract a Drive file ID "
                f"for {name!r}. Check the photo cell."
            )
            continue

        # Keep filenames stable and independent of the submitted name.
        contestant_number = len(contestants) + 1
        base_path = PHOTOS_DIR / f"contestant-{contestant_number:03d}"

        try:
            photo_path = download_photo(file_id, base_path)
        except Exception as error:
            failures.append(f"Row {row_number + 2}, {name!r}: {error}")
            continue

        contestants.append(
            {
                "id": f"contestant-{contestant_number:03d}",
                "name": name,
                "photo": photo_path.as_posix(),
            }
        )

        print(f"Downloaded: {name} -> {photo_path}")

    # Do not silently replace the JSON with an empty or incomplete list.
    if not contestants:
        raise RuntimeError(
            "No contestants were generated. Check the sheet URL, "
            "column names, and Drive permissions."
        )

    JSON_PATH.write_text(
        json.dumps(contestants, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    print(f"\nCreated {JSON_PATH} with {len(contestants)} contestants.")

    if failures:
        print(f"\n{len(failures)} row(s) could not be processed:")
        for failure in failures:
            print(f"  - {failure}")
        print(
            "\nReview these rows before publishing. The JSON currently "
            "contains only successfully downloaded contestants."
        )


if __name__ == "__main__":
    main()
