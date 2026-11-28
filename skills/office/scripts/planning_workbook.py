"""Fixed single-table XLSX operations for SoduWork's managed Planning bridge."""

from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import math
import os
import stat
import sys
from pathlib import Path
from zipfile import ZipFile

from lxml import etree
from openpyxl import Workbook, load_workbook
from openpyxl.utils.cell import range_boundaries

# -I omits the script directory. Load exactly the sibling installed with
# this managed Skill; the caller's workspace is never a Python search path.
spec = importlib.util.spec_from_file_location(
    "soduwork_office_inspector", Path(__file__).with_name("inspect_office.py")
)
inspector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inspector)

MAX_ROWS, MAX_COLUMNS = 1000, 64
MAX_DATA = 256 * 1024
MAX_FILE = 2 * 1024 * 1024
PARTS = frozenset(
    {
        "[Content_Types].xml",
        "_rels/.rels",
        "docProps/app.xml",
        "docProps/core.xml",
        "xl/workbook.xml",
        "xl/_rels/workbook.xml.rels",
        "xl/theme/theme1.xml",
        "xl/styles.xml",
        "xl/sharedStrings.xml",
        "xl/worksheets/sheet1.xml",
    }
)
ACTIVE = frozenset(
    {
        "f",
        "formula",
        "formula1",
        "formula2",
        "definedName",
        "hyperlink",
        "externalReference",
        "oleObject",
        "embeddedObject",
        "extLst",
        "AlternateContent",
    }
)


def validate_rows(rows):
    if not isinstance(rows, list) or not 1 <= len(rows) <= MAX_ROWS:
        raise ValueError("Expected 1–1000 rows")
    width = len(rows[0]) if isinstance(rows[0], list) else 0
    if not 1 <= width <= MAX_COLUMNS:
        raise ValueError("Expected 1–64 columns")
    for row in rows:
        if not isinstance(row, list) or len(row) != width:
            raise ValueError("Expected a rectangular table")
        for value in row:
            if type(value) in (float, int):
                if not math.isfinite(value) or abs(value) > 2**53 - 1:
                    raise ValueError("Number outside supported range")
            elif (
                not isinstance(value, str)
                or not value
                or len(value) > 32767
                or value.lstrip().startswith("=")
            ):
                raise ValueError("Expected plain text or finite numbers")
    if (
        len(json.dumps(rows, ensure_ascii=False, separators=(",", ":")).encode())
        > MAX_DATA
    ):
        raise ValueError("Table exceeds the size limit")
    return rows


def read_table(data):
    # Limit members and uncompressed bytes before using the Office reader.
    # The V1 skill accepts one plain worksheet and no active OOXML parts.
    with ZipFile(io.BytesIO(data)) as package:
        entries = package.infolist()
        if (
            not entries
            or len(entries) > len(PARTS)
            or len({item.filename for item in entries}) != len(entries)
            or sum(item.file_size for item in entries) > 4 * MAX_FILE
        ):
            raise ValueError("Unsupported workbook package")
        for item in entries:
            if item.filename not in PARTS or item.flag_bits & 1:
                raise ValueError("Unexpected workbook part")
            xml = etree.fromstring(
                package.read(item),
                etree.XMLParser(
                    resolve_entities=False,
                    load_dtd=False,
                    no_network=True,
                    huge_tree=False,
                ),
            )
            if xml.getroottree().docinfo.doctype:
                raise ValueError("Document types are unsupported")
            for el in xml.iter():
                if not isinstance(el.tag, str):
                    continue
                name = etree.QName(el.tag).localname
                if (
                    name in ACTIVE
                    or (
                        name == "Relationship"
                        and (
                            el.get("TargetMode", "").lower() == "external"
                            or ":" in el.get("Target", "")
                            or el.get("Target", "").startswith("//")
                        )
                    )
                    or "macroenabled" in el.get("ContentType", "").lower()
                ):
                    raise ValueError("Workbook contains unsupported active content")
    sheets = inspector.inspect_workbook(io.BytesIO(data))["sheets"]
    if (
        len(sheets) != 1
        or sheets[0]["formulaCount"]
        or sheets[0]["mergedRanges"]
        or not sheets[0]["range"]
    ):
        raise ValueError("Expected one plain table")
    left, top, right, bottom = range_boundaries(sheets[0]["range"])
    if (left, top) != (1, 1) or right > MAX_COLUMNS or bottom > MAX_ROWS:
        raise ValueError("Workbook exceeds table limits")
    book = load_workbook(
        io.BytesIO(data), read_only=True, data_only=False, keep_links=False
    )
    try:
        rows = [
            list(row)
            for row in book.active.iter_rows(
                min_row=1,
                min_col=1,
                max_row=bottom,
                max_col=right,
                values_only=True,
            )
        ]
    finally:
        book.close()
    return validate_rows(rows)


def execute(request):
    op = request.get("operation")
    fields = {"operation", "path", "rows"} if op == "write" else {"operation", "path"}
    if op not in ("read", "write") or set(request) != fields:
        raise ValueError("Unknown workbook operation or field")
    path = Path(request["path"])
    if not path.is_absolute() or path.suffix.lower() != ".xlsx" or path.is_symlink():
        raise ValueError("Expected a fixed local .xlsx file")
    expected = None
    if op == "write":
        expected = validate_rows(request["rows"])
        book = Workbook()
        try:
            for row in expected:
                book.active.append(row)
            buffer = io.BytesIO()
            book.save(buffer)
            data = buffer.getvalue()
        finally:
            book.close()
        if len(data) > MAX_FILE or read_table(data) != expected:
            raise ValueError("Generated workbook did not preserve the input")
        # The bridge supplies a private, previously absent staging path.
        with path.open("xb") as out:
            out.write(data)
    with path.open("rb") as source:
        if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
            raise ValueError("Expected a regular file")
        data = source.read(MAX_FILE + 1)
    if len(data) > MAX_FILE:
        raise ValueError("Workbook exceeds size limit")
    rows = read_table(data)
    if expected is not None and rows != expected:
        raise ValueError("Saved workbook failed read-back")
    return {"path": str(path), "sha256": hashlib.sha256(data).hexdigest(), "rows": rows}


def main():
    if sys.argv[1:] == ["--check"]:
        print(json.dumps({"ready": True}))
        return
    if len(sys.argv) != 1:
        raise ValueError("Expected one JSON request on stdin")
    raw = sys.stdin.buffer.readline(MAX_DATA * 2 + 1)
    if len(raw) > MAX_DATA * 2:
        raise ValueError("Workbook request exceeds size limit")
    result = execute(json.loads(raw))
    print(json.dumps(result, ensure_ascii=True, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"Workbook operation failed ({type(exc).__name__})", file=sys.stderr)
        sys.exit(1)
