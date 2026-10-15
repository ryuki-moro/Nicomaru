"""最終PPTXから出力した画像を、内容を変更せず閲覧用PDFへまとめる。"""
from pathlib import Path
import sys

from pypdf import PdfReader
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader

source = Path(sys.argv[1]).resolve()
output = Path(sys.argv[2]).resolve()
images = [source / f"final-{number:02d}.png" for number in range(1, 13)]
if not all(image.is_file() for image in images):
    raise RuntimeError("12枚の最終スライド画像が必要です")

pdf = canvas.Canvas(str(output), pagesize=(960, 540), pageCompression=1)
pdf.setTitle("にこまる 中間発表")
pdf.setSubject("学校発表用。編集用PowerPointは別ファイル。")
for image in images:
    reader = ImageReader(str(image))
    width, height = reader.getSize()
    if width * 9 != height * 16:
        raise RuntimeError(f"16:9ではない画像です: {image.name}")
    pdf.drawImage(reader, 0, 0, width=960, height=540)
    pdf.showPage()
pdf.save()
reader = PdfReader(str(output))
if len(reader.pages) != 12:
    raise RuntimeError("PDFのページ数が一致しません")
print(f"PDF pages: {len(reader.pages)}")
