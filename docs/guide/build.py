"""Build inbox-dispatcher.docx from inbox-dispatcher.md, both next to this script.

    python build.py

Needs python-docx, pillow and pywin32, plus Word (it fills the contents list),
Chrome and the Mermaid bundle of the VS Code extension Markdown Preview Enhanced.
"""
import glob
import html
import json
import re
import subprocess
import tempfile
from pathlib import Path

from docx import Document
from docx.enum.style import WD_STYLE_TYPE
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_TAB_ALIGNMENT, WD_TAB_LEADER
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt, RGBColor, Twips
from PIL import Image, ImageChops

HERE = Path(__file__).resolve().parent
SRC = HERE / "inbox-dispatcher.md"
OUT = SRC.with_suffix(".docx")
COMPANY = "inbox-dispatcher"

NAVY, ACCENT, GRAY, LIGHT_GRAY = "1F3864", "2E75B6", "555555", "8C8C8C"
ROW_BLUE, SEPARATOR, WHITE = "E8EDF5", "BFBFBF", "FFFFFF"
CONTENT_DXA = 9026
CONTENT_PT = CONTENT_DXA / 20
MAX_PICTURE_PT = 560

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
MERMAID_JS = sorted(glob.glob(str(Path.home() / ".vscode/extensions/shd101wyy.markdown-preview-enhanced-*/crossnote/dependencies/mermaid/mermaid.min.js")))
MERMAID_FONT = "Segoe UI, Arial, sans-serif"
# 16 px of diagram text comes out at about 9.5 pt on the page.
MERMAID_PX_TO_PT = 0.6
MERMAID_CONFIG = {
    "startOnLoad": False,
    # Mermaid's own default theme, the one the VS Code preview uses, so the md and the Word file have the same colours.
    "theme": "default",
    "fontFamily": MERMAID_FONT,
    "themeVariables": {"fontFamily": MERMAID_FONT, "fontSize": "16px"},
    "sequence": {
        "useMaxWidth": False,
        "mirrorActors": False,
        "actorMargin": 40,
        "width": 140,
        "height": 44,
        "messageMargin": 34,
        "noteMargin": 10,
    },
    # A white halo keeps a label readable where it crosses a lifeline.
    "themeCSS": ".messageText{paint-order:stroke;stroke:#fff;stroke-width:7px;stroke-linejoin:round}",
}
ERROR_PIXEL = (255, 0, 255)

AFTER_PBDR = (
    "w:shd w:tabs w:suppressAutoHyphens w:kinsoku w:wordWrap w:overflowPunct w:topLinePunct "
    "w:autoSpaceDE w:autoSpaceDN w:bidi w:adjustRightInd w:snapToGrid w:spacing w:ind "
    "w:contextualSpacing w:mirrorIndents w:suppressOverlap w:jc w:textDirection w:textAlignment "
    "w:textboxTightWrap w:outlineLvl w:divId w:cnfStyle w:rPr w:sectPr w:pPrChange"
).split()
AFTER_OUTLINE = AFTER_PBDR[AFTER_PBDR.index("w:divId"):]
AFTER_RUN_SHD = "w:fitText w:vertAlign w:rtl w:cs w:em w:lang w:eastAsianLayout w:specVanish w:oMath".split()


def render_mermaid(code, png):
    """Screenshot the diagram in the page that laid it out.

    The text is measured and drawn with the same font only there. An SVG taken
    out of the page falls back to another font and its labels overflow.
    """
    page = png.with_suffix(".html")
    page.write_text(
        '<!doctype html><meta charset="utf-8"><body style="margin:20px;background:#fff">'
        f'<pre class="mermaid">{html.escape(code)}</pre>'
        f'<script src="{Path(MERMAID_JS[-1]).as_uri()}"></script>'
        "<script>const fail = e => { document.body.textContent = String(e); document.body.style.background = '#f0f' };"
        f"try {{ mermaid.initialize({json.dumps(MERMAID_CONFIG)}); mermaid.run().catch(fail) }} catch (e) {{ fail(e) }}</script>",
        encoding="utf-8",
    )
    subprocess.run(
        [CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", f"--user-data-dir={png.parent / 'chrome'}",
         "--force-device-scale-factor=2", "--window-size=1600,2400", "--virtual-time-budget=10000",
         f"--screenshot={png}", page.as_uri()],
        check=True, capture_output=True,
    )
    shot = Image.open(png).convert("RGB")
    if shot.getpixel((2, 2)) == ERROR_PIXEL:
        raise SystemExit(f"Mermaid block did not render:\n{code}")
    left, top, right, bottom = ImageChops.difference(shot, Image.new("RGB", shot.size, "white")).getbbox()
    shot.crop((left - 8, top - 8, right + 8, bottom + 8)).save(png)


def trimmed(path, tmp):
    """Cut the empty border of a diagram export, so its content takes the page width."""
    image = Image.open(path).convert("RGB")
    # The faint grid and the light fills of the page are background, not content.
    ink = ImageChops.difference(image, Image.new("RGB", image.size, "white")).convert("L").point(lambda v: 255 * (v > 60))
    left, top, right, bottom = ink.getbbox()
    out = tmp / path.name
    image.crop((max(left - 40, 0), max(top - 40, 0), min(right + 40, image.width), min(bottom + 40, image.height))).save(out)
    return out


def blocks(text):
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        if not line.strip():
            i += 1
        elif line.startswith("```"):
            end = next(j for j in range(i + 1, len(lines)) if lines[j].startswith("```"))
            yield line[3:].strip(), "\n".join(lines[i + 1:end])
            i = end + 1
        elif m := re.match(r"(#{1,4}) (.+)", line):
            yield "h", (len(m[1]), m[2])
            i += 1
        elif m := re.match(r"!\[(.*)\]\((.+)\)$", line):
            yield "img", (m[1], m[2])
            i += 1
        elif line[0] in "|-":
            end = next((j for j in range(i, len(lines)) if not lines[j].startswith(line[0])), len(lines))
            if line[0] == "|":
                rows = [[c.strip() for c in row.strip("|").split("|")] for row in lines[i:end]]
                yield "table", [rows[0]] + rows[2:]
            else:
                yield "ul", [item[2:] for item in lines[i:end]]
            i = end
        else:
            yield "p", line
            i += 1


def el(tag, **attrs):
    e = OxmlElement(tag)
    for k, v in attrs.items():
        e.set(qn("w:" + k), str(v))
    return e


def set_fonts(rpr, name):
    fonts = rpr.get_or_add_rFonts()
    fonts.attrib.clear()
    for a in ("ascii", "hAnsi", "cs", "eastAsia"):
        fonts.set(qn("w:" + a), name)


def font(run, name="Calibri", size=11, color=None, bold=None, italic=None):
    run.font.size, run.font.bold, run.font.italic = Pt(size), bold, italic
    if color:
        run.font.color.rgb = RGBColor.from_string(color)
    set_fonts(run._r.get_or_add_rPr(), name)
    return run


def rule(ppr, side, size, space):
    bdr = el("w:pBdr")
    bdr.append(el("w:" + side, val="single", sz=size, space=space, color=ACCENT))
    ppr.insert_element_before(bdr, *AFTER_PBDR)


def borders(tag, **sides):
    b = el(tag)
    for side, color in sides.items():
        b.append(el("w:" + side, val="single", sz=4, space=0, color=color))
    return b


def field(par, instr, placeholder, **fmt):
    for part in ("begin", "instr", "separate", "text", "end"):
        run = font(par.add_run(placeholder if part == "text" else ""), **fmt)
        if part == "instr":
            code = el("w:instrText")
            code.set(qn("xml:space"), "preserve")
            code.text = instr
            run._r.append(code)
        elif part != "text":
            run._r.append(el("w:fldChar", fldCharType=part))


def inline(par, text, code_fill=ROW_BLUE):
    """Plain text, **bold** and `code`. Code gets a monospace font on a filled background."""
    for part in re.split(r"(`[^`]+`|\*\*.+?\*\*)", text):
        if part.startswith("`"):
            run = font(par.add_run(part[1:-1]), "Consolas", 10)
            rpr = run._r.get_or_add_rPr()
            # The border in the fill colour pads the background around the text.
            rpr.insert_element_before(el("w:bdr", val="single", sz=4, space=0, color=code_fill), "w:shd", *AFTER_RUN_SHD)
            rpr.insert_element_before(el("w:shd", val="clear", color="auto", fill=code_fill), *AFTER_RUN_SHD)
        elif part.startswith("**"):
            par.add_run(part[2:-2]).bold = True
        elif part:
            par.add_run(part)


def restyle(style, name, size, color="000000", bold=False, before=0, after=0):
    for tag in ("w:pPr", "w:rPr"):
        old = style.element.find(qn(tag))
        if old is not None:
            style.element.remove(old)
    style.font.size, style.font.bold = Pt(size), bold
    style.font.color.rgb = RGBColor.from_string(color)
    set_fonts(style.element.get_or_add_rPr(), name)
    style.paragraph_format.space_before, style.paragraph_format.space_after = Twips(before), Twips(after)
    return style.paragraph_format


def setup_styles(doc):
    restyle(doc.styles["Normal"], "Calibri", 11, after=160).line_spacing = 1.25
    for level, (size, before, after) in enumerate([(18, 480, 240), (14, 360, 160), (12, 240, 0)]):
        style = doc.styles[f"Heading {level + 1}"]
        fmt = restyle(style, "Calibri Light", size, NAVY, True, before, after)
        fmt.keep_with_next = fmt.keep_together = True
        ppr = style.element.get_or_add_pPr()
        ppr.insert_element_before(el("w:outlineLvl", val=level), *AFTER_OUTLINE)
        if level == 0:
            rule(ppr, "bottom", 8, 4)
    for level, (size, bold, indent, before) in enumerate([(10.5, True, 0, 80), (10, False, 220, 0), (9.5, False, 440, 0)]):
        style = doc.styles.add_style(f"toc {level + 1}", WD_STYLE_TYPE.PARAGRAPH)
        # Word must take it for its own built-in style, or it adds a second set and uses that one.
        style.element.attrib.pop(qn("w:customStyle"), None)
        style.element.set(qn("w:styleId"), f"TOC{level + 1}")
        style.base_style = doc.styles["Normal"]
        fmt = restyle(style, "Calibri", size, bold=bold, before=before, after=20)
        fmt.left_indent, fmt.line_spacing = Twips(indent), 1.05
        fmt.tab_stops.add_tab_stop(Twips(CONTENT_DXA), WD_TAB_ALIGNMENT.RIGHT, WD_TAB_LEADER.DOTS)

    # Bullets: accent blue marker, 360 left and 240 hanging.
    style = doc.styles["List Bullet"]
    fmt = style.paragraph_format
    fmt.left_indent, fmt.first_line_indent, fmt.space_after = Twips(360), Twips(-240), Twips(60)
    numbering = doc.part.numbering_part.element
    abstract = numbering.num_having_numId(style.element.pPr.numPr.numId.val).abstractNumId.val
    level = numbering.xpath(f'w:abstractNum[@w:abstractNumId="{abstract}"]/w:lvl[@w:ilvl="0"]')[0]
    level.find(qn("w:lvlText")).set(qn("w:val"), "\u2022")
    for tag in ("w:pPr", "w:rPr"):
        old = level.find(qn(tag))
        if old is not None:
            level.remove(old)
    ppr, rpr = el("w:pPr"), el("w:rPr")
    ppr.append(el("w:ind", left=360, hanging=240))
    rpr.append(el("w:rFonts", ascii="Calibri", hAnsi="Calibri", cs="Calibri"))
    rpr.append(el("w:color", val=ACCENT))
    level.extend([ppr, rpr])


def header_footer(doc, title):
    section = doc.sections[0]
    section.page_width, section.page_height = Twips(11906), Twips(16838)
    for side in ("left_margin", "right_margin", "top_margin", "bottom_margin"):
        setattr(section, side, Twips(1440))
    section.header_distance = section.footer_distance = Twips(708)
    small = dict(size=9, color=LIGHT_GRAY)

    head = section.header.paragraphs[0]
    head.style = doc.styles["Normal"]
    head.paragraph_format.space_after = 0
    head.paragraph_format.tab_stops.add_tab_stop(Twips(CONTENT_DXA), WD_TAB_ALIGNMENT.RIGHT)
    font(head.add_run(f"{title}\t{COMPANY}"), **small)
    rule(head._p.get_or_add_pPr(), "bottom", 6, 4)

    foot = section.footer.paragraphs[0]
    foot.style = doc.styles["Normal"]
    foot.alignment = WD_ALIGN_PARAGRAPH.CENTER
    foot.paragraph_format.space_after = 0
    font(foot.add_run("Page "), **small)
    field(foot, "PAGE", "1", **small)
    font(foot.add_run(" of "), **small)
    field(foot, "NUMPAGES", "1", **small)
    rule(foot._p.get_or_add_pPr(), "top", 6, 4)


def title_block(doc, title, subtitle):
    par = doc.add_paragraph()
    par.paragraph_format.space_after = Twips(80)
    font(par.add_run(title), "Calibri Light", 22, NAVY)
    par = doc.add_paragraph()
    par.paragraph_format.space_after = Twips(240)
    font(par.add_run(subtitle), "Calibri Light", 14, GRAY, italic=True)
    rule(par._p.get_or_add_pPr(), "bottom", 12, 8)

    # Styled like a Heading 1, but not one: it stays out of its own list.
    par = doc.add_paragraph()
    par.paragraph_format.space_before, par.paragraph_format.space_after = Twips(120), Twips(160)
    font(par.add_run("Contents"), "Calibri Light", 18, NAVY, bold=True)
    rule(par._p.get_or_add_pPr(), "bottom", 8, 4)
    field(doc.add_paragraph(), r'TOC \o "1-3" \h \z \u', "Run build.py with Word installed to fill this list.")


def column_widths(rows):
    """Each column fits its longest word, the rest goes where the text is."""
    cols = list(zip(*[[cell.replace("`", "") for cell in row] for row in rows]))
    need = [max(len(word) for cell in col for word in cell.split()) * 115 + 340 for col in cols]
    mass = [sum(map(len, col)) for col in cols]
    spare = CONTENT_DXA - sum(need)
    widths = [int(n + spare * m / sum(mass)) for n, m in zip(need, mass)]
    widths[-1] += CONTENT_DXA - sum(widths)
    return widths


def add_table(doc, rows):
    widths = column_widths(rows)
    table = doc.add_table(rows=len(rows), cols=len(rows[0]))
    props = table._tbl.tblPr
    for child in list(props):
        props.remove(child)
    margins = el("w:tblCellMar")
    for side, width in (("top", 100), ("left", 140), ("bottom", 100), ("right", 140)):
        margins.append(el("w:" + side, w=width, type="dxa"))
    props.extend([
        el("w:tblW", w=CONTENT_DXA, type="dxa"),
        borders("w:tblBorders", **dict.fromkeys(("top", "left", "bottom", "right", "insideH", "insideV"), SEPARATOR)),
        el("w:tblLayout", type="fixed"),
        margins,
    ])
    for col, width in zip(table._tbl.tblGrid.findall(qn("w:gridCol")), widths):
        col.set(qn("w:w"), str(width))

    last = len(rows[0]) - 1
    for r, (row, texts) in enumerate(zip(table.rows, rows)):
        row_props = row._tr.get_or_add_trPr()
        row_props.append(el("w:cantSplit"))
        if r == 0:
            row_props.append(el("w:tblHeader"))
        fill = NAVY if r == 0 else ROW_BLUE if r % 2 else None
        for c, (cell, text) in enumerate(zip(row.cells, texts)):
            cell.width = Twips(widths[c])
            cell_props = cell._tc.get_or_add_tcPr()
            # Header cells are split by white lines, which read as gaps in the navy block.
            inner = WHITE if r == 0 else SEPARATOR
            cell_props.append(borders(
                "w:tcBorders", top=SEPARATOR, left=SEPARATOR if c == 0 else inner,
                bottom=SEPARATOR, right=SEPARATOR if c == last else inner,
            ))
            if fill:
                cell_props.append(el("w:shd", val="clear", color="auto", fill=fill))
            cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
            par = cell.paragraphs[0]
            par.paragraph_format.space_after = 0
            if r == 0:
                font(par.add_run(text), color=WHITE, bold=True)
            else:
                # Code keeps a visible background on a striped row too.
                inline(par, text, code_fill=WHITE if fill else ROW_BLUE)


def add_picture(doc, path, alt, width_pt=CONTENT_PT):
    with Image.open(path) as image:
        ratio = image.height / image.width
    doc.add_picture(str(path), width=Pt(min(width_pt, CONTENT_PT, MAX_PICTURE_PT / ratio)))
    par = doc.paragraphs[-1]
    par.alignment = WD_ALIGN_PARAGRAPH.CENTER
    par.paragraph_format.line_spacing = 1.0
    par._p.xpath(".//wp:docPr")[0].set("descr", alt)
    return par


def build(tmp):
    doc = Document()
    # Mode 15 keeps Word out of compatibility mode and lines the tables up with the margins.
    doc.settings.element.xpath('w:compat/w:compatSetting[@w:name="compatibilityMode"]')[0].set(qn("w:val"), "15")
    setup_styles(doc)
    parts = list(blocks(SRC.read_text(encoding="utf-8")))
    (_, (_, title)), (_, subtitle), *parts = parts
    header_footer(doc, title)
    title_block(doc, title, subtitle)
    props = doc.core_properties
    props.title, props.author, props.last_modified_by, props.comments = title, COMPANY, COMPANY, ""

    chapter = section = diagrams = 0
    last = None
    after_table = False
    for kind, body in parts:
        if kind == "h":
            level, text = body
            if level == 2:
                chapter, section = chapter + 1, 0
                text = f"{chapter}. {text}"
            elif level == 3:
                section += 1
                text = f"{chapter}.{section} {text}"
            elif text[0].isdigit():
                text = "Step " + text
            par = doc.add_heading(text, level - 1)
            if (level, chapter) == (2, 1):
                par.paragraph_format.page_break_before = True
        elif kind == "p":
            par = doc.add_paragraph()
            inline(par, body)
        elif kind == "ul":
            for item in body:
                par = doc.add_paragraph(style="List Bullet")
                inline(par, item)
        elif kind == "table":
            last.paragraph_format.keep_with_next = True
            add_table(doc, body)
            after_table = True
            continue
        else:
            last.paragraph_format.keep_with_next = True
            if kind == "img":
                alt, path = body
                par = add_picture(doc, trimmed(HERE / path, tmp), alt)
            elif kind == "mermaid":
                diagrams += 1
                png = tmp / f"mermaid-{diagrams}.png"
                render_mermaid(body, png)
                with Image.open(png) as image:
                    width = image.width / 2 * MERMAID_PX_TO_PT
                par = add_picture(doc, png, "Sequence diagram. " + last.text, width)
            else:
                raise SystemExit(f"Unsupported block: {kind}")
        if after_table and kind != "h":
            par.paragraph_format.space_before = Twips(200)
        after_table = False
        last = par
    if after_table:
        # Word puts a paragraph after a closing table. Left at body size it can spill onto a blank page.
        par = doc.add_paragraph()
        par.paragraph_format.space_after, par.paragraph_format.line_spacing = 0, Pt(1)
    doc.save(OUT)


def fill_contents():
    """Word writes the contents list, so the page numbers are the real ones."""
    import win32com.client

    word = win32com.client.DispatchEx("Word.Application")
    try:
        word.Visible, word.DisplayAlerts = False, 0
        doc = word.Documents.Open(str(OUT), AddToRecentFiles=False)
        doc.TablesOfContents(1).Update()
        pages = doc.ComputeStatistics(2)
        doc.Save()
        doc.Close(False)
    finally:
        word.Quit()
    return pages


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        build(Path(tmp))
    print(f"{OUT.name}: {fill_contents()} pages")
