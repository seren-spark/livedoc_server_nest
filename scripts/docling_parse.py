from __future__ import annotations

import argparse
import base64
import io
import json
import os
import sys
from pathlib import Path

# BLAS libraries otherwise derive their thread count from all logical CPUs and
# can reserve a large amount of memory before Docling parses even a tiny file.
_threads = os.environ.get("DOCLING_NUM_THREADS", "1")
os.environ.setdefault("OPENBLAS_NUM_THREADS", _threads)
os.environ.setdefault("OMP_NUM_THREADS", _threads)
os.environ.setdefault("MKL_NUM_THREADS", _threads)
os.environ.setdefault("NUMEXPR_NUM_THREADS", _threads)


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Parse one PDF/DOCX for the LiveDoc Nest import worker")
    parser.add_argument("--input")
    parser.add_argument("--filename")
    parser.add_argument("--output")
    parser.add_argument("--probe", action="store_true")
    return parser.parse_args()


def local_ocr(data: bytes) -> tuple[str, str | None]:
    try:
        from rapidocr_onnxruntime import RapidOCR

        result, _ = RapidOCR()(data)
        return "\n".join(str(item[1]) for item in (result or []) if len(item) > 1).strip(), None
    except Exception as exc:
        return "", f"Local OCR failed: {exc}"


def main() -> None:
    args = arguments()
    # This executable is intentionally named docling_parse.py for the worker
    # contract, but Docling itself depends on a package named `docling_parse`.
    # Python prepends this script's directory to sys.path, which would shadow
    # that installed package unless the directory is removed before imports.
    script_directory = Path(__file__).resolve().parent
    sys.path = [
        entry
        for entry in sys.path
        if Path(entry or ".").resolve() != script_directory
    ]
    try:
        import docling
        from docling.datamodel.base_models import InputFormat
        from docling.datamodel.pipeline_options import PdfPipelineOptions
        from docling.document_converter import DocumentConverter, PdfFormatOption
        from docling_core.types.doc import ImageRefMode, PictureItem
        from rapidocr_onnxruntime import RapidOCR
    except ImportError as exc:
        raise SystemExit(
            "Docling is unavailable; install requirements-docling.txt with "
            f"Python 3.10-3.13. Import error: {exc}"
        ) from exc

    if args.probe:
        import tempfile
        import zipfile
        with tempfile.TemporaryDirectory() as directory:
            probe = Path(directory) / "probe.docx"
            with zipfile.ZipFile(probe, "w") as archive:
                archive.writestr("[Content_Types].xml", "<?xml version='1.0'?><Types xmlns='http://schemas.openxmlformats.org/package/2006/content-types'><Default Extension='rels' ContentType='application/vnd.openxmlformats-package.relationships+xml'/><Default Extension='xml' ContentType='application/xml'/><Override PartName='/word/document.xml' ContentType='application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'/></Types>")
                archive.writestr("_rels/.rels", "<?xml version='1.0'?><Relationships xmlns='http://schemas.openxmlformats.org/package/2006/relationships'><Relationship Id='rId1' Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument' Target='word/document.xml'/></Relationships>")
                archive.writestr("word/document.xml", "<?xml version='1.0'?><w:document xmlns:w='http://schemas.openxmlformats.org/wordprocessingml/2006/main'><w:body><w:p><w:r><w:t>LiveDoc Docling probe</w:t></w:r></w:p></w:body></w:document>")
            DocumentConverter(allowed_formats=[InputFormat.DOCX]).convert(probe)
            RapidOCR()
        print("Docling and RapidOCR imports plus minimal DOCX parse succeeded")
        return

    if not args.input or not args.filename or not args.output:
        raise SystemExit("--input, --filename and --output are required unless --probe is used")

    options = PdfPipelineOptions()
    options.do_ocr = True
    options.generate_picture_images = True
    options.images_scale = 2.0
    converter = DocumentConverter(
        allowed_formats=[InputFormat.PDF, InputFormat.DOCX],
        format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)},
    )
    document = converter.convert(Path(args.input)).document
    markdown = document.export_to_markdown(
        image_mode=ImageRefMode.PLACEHOLDER,
        image_placeholder="<!-- livedoc-image -->",
    )
    images: list[dict[str, object]] = []
    for item, _level in document.iterate_items():
        if not isinstance(item, PictureItem):
            continue
        image = item.get_image(document)
        if image is None:
            continue
        output = io.BytesIO()
        image.convert("RGB").save(output, format="PNG", optimize=True)
        data = output.getvalue()
        ordinal = len(images) + 1
        provenance = getattr(item, "prov", None) or []
        page_number = int(getattr(provenance[0], "page_no", 0) or 0) or None if provenance else None
        ocr_text, ocr_error = local_ocr(data)
        images.append({
            "filename": f"{Path(args.filename).stem}-image-{ordinal}.png",
            "mime_type": "image/png",
            "data_base64": base64.b64encode(data).decode("ascii"),
            "ordinal": ordinal,
            "page_number": page_number,
            "width": image.width,
            "height": image.height,
            "ocr_text": ocr_text,
            "ocr_error": ocr_error,
        })
        markdown = markdown.replace(
            "<!-- livedoc-image -->",
            f"![图片 {ordinal}](asset://pending/{ordinal})",
            1,
        )
    markdown = markdown.replace("<!-- livedoc-image -->", "").strip()
    title = next((line[2:].strip() for line in markdown.splitlines() if line.startswith("# ")), Path(args.filename).stem)
    payload = {"title": title[:512], "markdown": markdown, "images": images, "parser_version": f"docling/{getattr(docling, '__version__', 'unknown')}"}
    destination = Path(args.output)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()
