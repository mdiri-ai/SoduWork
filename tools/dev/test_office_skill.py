"""Exercise the bundled Office inspector through its documented command line."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

from docx import Document
from docx.enum.style import WD_STYLE_TYPE
from openpyxl import Workbook
from PIL import Image


SCRIPT = Path(__file__).resolve().parents[2] / "skills/office/scripts/inspect_office.py"


class OfficeSkillTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.work = Path(temp.name)

    def run_inspector(self, path):
        return subprocess.run([sys.executable, str(SCRIPT), path.name], cwd=self.work,
                              capture_output=True, timeout=15)

    def report(self, path):
        original = hashlib.sha256(path.read_bytes()).digest()
        before = set(self.work.iterdir())
        result = self.run_inspector(path)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(hashlib.sha256(path.read_bytes()).digest(), original)
        self.assertEqual(set(self.work.iterdir()), before)
        data = json.loads(result.stdout)
        self.assertIs(data["rendered"], False)
        return data

    def planning(self, operation, target, **extra):
        return subprocess.run([sys.executable, "-I", "-B", str(SCRIPT.with_name("planning_workbook.py"))],
                              input=json.dumps({"operation": operation, "path": str(target), **extra}).encode(),
                              cwd=self.work, capture_output=True, timeout=15)

    def test_planning_single_table_roundtrip_and_exclusive_creation(self):
        rows = [["Description", "Amount"], ["A", 120], ["B", 80], ["Total", 200]]
        target = self.work / "月报.xlsx"
        saved = self.planning("write", target, rows=rows)
        self.assertEqual(saved.returncode, 0, saved.stderr)
        ref = json.loads(saved.stdout)
        self.assertEqual(ref["rows"], rows)
        self.assertEqual(ref["sha256"], hashlib.sha256(target.read_bytes()).hexdigest())
        self.assertNotEqual(self.planning("write", target, rows=[["replacement"]]).returncode, 0)
        self.assertEqual(json.loads(self.planning("read", target).stdout), ref)

    def test_planning_rejects_formulas_non_table_parts_and_limits(self):
        target = self.work / "active.xlsx"
        for rows in ([["=SUM(1,2)"]], [[True]], [[1], [2,3]], [["x"]]*1001):
            with self.subTest(rows=str(rows)[:50]):
                self.assertNotEqual(self.planning("write", target, rows=rows).returncode, 0)
                self.assertFalse(target.exists())
        book = Workbook()
        book.active["A1"] = "=SUM(1,2)"
        book.save(target)
        self.assertNotEqual(self.planning("read", target).returncode, 0)
        book.active["A1"] = 120
        book.active["A1"].hyperlink = "https://example.invalid/reference"
        book.save(target)
        self.assertNotEqual(self.planning("read", target).returncode, 0)

    def test_document_counts_body_including_cells_and_reused_images(self):
        path = self.work / "季度报告.docx"
        picture = self.work / "picture.png"
        Image.new("RGB", (2, 2)).save(picture)
        document = Document()
        style = document.styles.add_style("Report section", WD_STYLE_TYPE.PARAGRAPH)
        style.base_style = document.styles["Heading 2"]
        document.add_paragraph("Summary", style=style)
        document.add_paragraph("Results")
        document.add_table(rows=1, cols=1).cell(0, 0).text = "Total"
        for _ in range(2):
            document.add_picture(str(picture))
        document.sections[0].header.paragraphs[0].text = "Header"
        document.save(path)
        report = self.report(path)
        self.assertEqual([report[key] for key in ("paragraphCount", "headingCount",
                                                  "tableCount", "imageCount")], [5, 1, 1, 2])

    def test_sparse_workbook_formulas_merges_and_empty_sheet(self):
        path = self.work / "预算.xlsx"
        book = Workbook()
        sheet = book.active
        sheet.title = "预算"
        sheet["B2"] = "=1+1"
        sheet["XFD1048576"] = 42
        sheet.merge_cells("C3:E3")
        book.create_sheet("空白")
        book.save(path)
        sheets = self.report(path)["sheets"]
        self.assertEqual(sheets, [
            {"name": "预算", "range": "B2:XFD1048576", "formulaCount": 1, "mergedRanges": ["C3:E3"]},
            {"name": "空白", "range": None, "formulaCount": 0, "mergedRanges": []},
        ])

    def test_valid_empty_document(self):
        path = self.work / "empty.docx"
        Document().save(path)
        self.assertEqual(self.report(path)["paragraphCount"], 0)

    def test_builtin_heading_without_outline_metadata_and_explicit_body_override(self):
        from docx.oxml import OxmlElement
        from docx.oxml.ns import qn

        path = self.work / "headings.docx"
        document = Document()
        for level in (1, 2):
            style = document.styles[f"Heading {level}"]
            outline = style.element.xpath("./w:pPr/w:outlineLvl")[0]
            outline.getparent().remove(outline)
            document.add_paragraph("Section", style=style)
        custom = document.styles.add_style("Report subsection", WD_STYLE_TYPE.PARAGRAPH)
        custom.base_style = document.styles["Heading 2"]
        document.add_paragraph("Subsection", style=custom)
        body = document.add_paragraph("Body", style=custom)
        override = OxmlElement("w:outlineLvl")
        override.set(qn("w:val"), "9")
        body._p.get_or_add_pPr().append(override)
        document.add_paragraph("Heading 1").runs[0].bold = True
        document.save(path)
        self.assertEqual(self.report(path)["headingCount"], 3)

    def test_missing_worksheet_or_wrong_workbook_type(self):
        source = self.work / "source.xlsx"
        book = Workbook()
        book.create_sheet("Second")
        book.save(source)
        incomplete = self.work / "missing.xlsx"
        with zipfile.ZipFile(source) as src, zipfile.ZipFile(incomplete, "w") as dst:
            for name in src.namelist():
                if name != "xl/worksheets/sheet2.xml":
                    dst.writestr(name, src.read(name))
        template = self.work / "template-as-workbook.xlsx"
        book.template = True
        book.save(template)
        for path in (incomplete, template):
            with self.subTest(path=path):
                result = self.run_inspector(path)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(result.stdout)

    def test_invalid_inputs_have_no_success_report(self):
        bad = self.work / "bad.docx"
        bad.write_bytes(b"broken archive")
        empty = self.work / "shell.xlsx"
        with zipfile.ZipFile(empty, "w"):
            pass
        wrong = self.work / "renamed.xlsx"
        Document().save(wrong)
        unsupported = self.work / "wrong.pptx"
        Document().save(unsupported)
        for path in (bad, empty, wrong, unsupported):
            with self.subTest(path=path):
                result = self.run_inspector(path)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(result.stdout)
                self.assertTrue(result.stderr)
                self.assertNotIn(b"Traceback", result.stderr)


if __name__ == "__main__":
    unittest.main()
