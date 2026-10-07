
import io
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlparse, parse_qs

import gdown
import pandas as pd
import requests
from PIL import Image, ImageOps, UnidentifiedImageError
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

# Enable HEIC/HEIF decoding through Pillow.
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
        raise ValueError(
            "Could not find the Google Sheets spreadsheet ID. "
            "Use the normal Google Sheets viewer/edit URL."
        )

    spreadsheet_id = match.group(1)
    parsed = urlparse(sheet_url)

    params = parse_qs(parsed.query)
    gid = params.get("gid", [None])[0]

    if not gid and parsed.fragment:
        fragment_params = parse_qs(parsed.fragment)
        gid = fragment_params.get("gid", [None])[0]

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


def download_photo(file_id, destination_without_extension):
    """Download a public Drive file to a temporary path."""
    temp_path = destination_without_extension.with_suffix(".download")

    temp_path.unlink(missing_ok=True)

    result = gdown.download(
        id=file_id,
        output=str(temp_path),
        quiet=False,
        use_cookies=False,
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
# Image conversion and validation
# --------------------------------------------------

def verify_image_readable(path):
    """
    Verify that the downloaded file is a readable image.
    Reopen it and fully decode the image to detect corruption.
    """
    try:
        with Image.open(path) as image:
            image.verify()

        # verify() invalidates the image object, so reopen it.
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
    """
    Convert a downloaded image to JPEG, then verify the result.

    Handles HEIC/HEIF and other image formats supported by Pillow.
    Applies EXIF orientation and composites transparency onto white.
    Returns the verified JPEG path.
    """
    final_path = destination_without_extension.with_suffix(".jpg")

    # Write to a temporary JPEG first. The final file is replaced
    # only after conversion and validation both succeed.
    temp_jpeg = destination_without_extension.with_name(
        destination_without_extension.name + ".tmp.jpg"
    )

    temp_jpeg.unlink(missing_ok=True)

    try:
        # First check that the source can actually be decoded.
        original_size = verify_image_readable(source_path)

        with Image.open(source_path) as source:
            # Use the first frame for animated images.
            source.seek(0)

            # Correct phone-camera orientation from EXIF metadata.
            image = ImageOps.exif_transpose(source)

            # Convert transparency to a white background because
            # JPEG does not support an alpha channel.
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
                # Also handles grayscale, palette, CMYK, and
                # other modes that JPEG cannot store directly.
                image = image.convert("RGB")

            image.save(
                temp_jpeg,
                format="JPEG",
                quality=JPEG_QUALITY,
                optimize=True,
                progressive=True,
            )

        # Confirm that the output exists and is not empty.
        if (
            not temp_jpeg.exists()
            or temp_jpeg.stat().st_size == 0
        ):
            raise RuntimeError(
                "JPEG conversion produced an empty file"
            )

        # Validate the output's actual format and decoded contents.
        with Image.open(temp_jpeg) as check:
            if check.format != "JPEG":
                raise RuntimeError(
                    f"Expected JPEG, got {check.format!r}"
                )

            if check.mode != "RGB":
                raise RuntimeError(
                    f"Expected RGB mode, got {check.mode!r}"
                )

            check.load()

            if check.width <= 0 or check.height <= 0:
                raise RuntimeError(
                    "Converted JPEG has invalid dimensions"
                )

            converted_size = check.size

        # Check the JPEG signature as an additional format check.
        with open(temp_jpeg, "rb") as file:
            if not file.read(3) == b"\xff\xd8\xff":
                raise RuntimeError(
                    "Converted file does not have a JPEG signature"
                )

        # Publish the finished file only after all checks pass.
        temp_jpeg.replace(final_path)

        print(
            f"  Verified JPEG: {final_path} "
            f"({original_size[0]}x{original_size[1]} -> "
            f"{converted_size[0]}x{converted_size[1]})"
        )

        return final_path

    except Exception:
        temp_jpeg.unlink(missing_ok=True)
        final_path.unlink(missing_ok=True)
        raise


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

    # Fetch the public Google Sheet as CSV.
    csv_url = get_sheet_csv_url(sheet_url)

    response = requests.get(
        csv_url,
        timeout=30,
    )
    response.raise_for_status()

    df = pd.read_csv(
        io.StringIO(
            response.content.decode("utf-8-sig")
        )
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

        # Assign the next ID only after a contestant succeeds.
        contestant_number = len(contestants) + 1

        contestant_id = (
            f"contestant-{contestant_number:03d}"
        )

        base_path = (
            PHOTOS_DIR / contestant_id
        )

        downloaded_path = None

        try:
            print(
                f"\nProcessing row {row_number + 2}: {name}"
            )

            downloaded_path = download_photo(
                file_id,
                base_path,
            )

            photo_path = convert_to_jpeg(
                downloaded_path,
                base_path,
            )

            contestants.append(
                {
                    "id": contestant_id,
                    "name": name,
                    "photo": photo_path.as_posix(),
                }
            )

            print(
                f"  Success: {name} -> {photo_path}"
            )

        except Exception as error:
            failures.append(
                f"Row {row_number + 2}, {name!r}: {error}"
            )

            print(f"  FAILED: {error}")

        finally:
            if downloaded_path is not None:
                downloaded_path.unlink(missing_ok=True)

    # Never overwrite the existing JSON if no images succeeded.
    if not contestants:
        raise RuntimeError(
            "No contestants were generated. "
            "The existing contestants.json was not replaced. "
            "Check the sheet URL, column names, and Drive permissions."
        )

    # Build JSON in memory and write it only after processing.
    json_content = (
        json.dumps(
            contestants,
            indent=2,
            ensure_ascii=False,
        )
        + "\n"
    )

    temp_json_path = JSON_PATH.with_name(
        JSON_PATH.name + ".tmp"
    )

    try:
        temp_json_path.write_text(
            json_content,
            encoding="utf-8",
        )

        # Ensure the JSON itself is valid before replacing the old one.
        json.loads(
            temp_json_path.read_text(encoding="utf-8")
        )

        temp_json_path.replace(JSON_PATH)

    finally:
        temp_json_path.unlink(missing_ok=True)

    print(
        f"\nCreated {JSON_PATH} with "
        f"{len(contestants)} verified contestants."
    )

    if failures:
        print(
            f"\nWARNING: {len(failures)} row(s) failed:"
        )

        for failure in failures:
            print(f"  - {failure}")

        print(
            "\nThe JSON contains only successfully converted images. "
            "Review the failures before publishing."
        )


if __name__ == "__main__":
    main()