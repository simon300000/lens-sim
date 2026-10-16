"""Outline Illustrator's subset CFF fonts; requires fonttools (build time only)."""
import base64
import io
import re
import sys
import xml.etree.ElementTree as ET
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

source = sys.stdin.read()
fonts = {}
for name, encoded in re.findall(r"@font-face\{font-family:'([^']+)';src:url\(\"data:;base64,([\s\S]*?)\"\)\}", source):
    fonts[name] = TTFont(io.BytesIO(base64.b64decode(re.sub(r'\\\s*', '', encoded))))
entities = dict(re.findall(r'<!ENTITY\s+(\w+)\s+"([^"]+)"\s*>', source))
source = re.sub(r'<!DOCTYPE[\s\S]*?\]>', '', source)
source = re.sub(r'&([\w]+);', lambda m: entities.get(m[1], m[0]), source)
root = ET.fromstring(source)
ns = '{http://www.w3.org/2000/svg}'
glyph_count = 0
for parent in root.iter():
    for text in list(parent):
        if text.tag != ns + 'text':
            continue
        group = ET.Element(ns + 'g', {'transform': text.get('transform', '')})
        for span in text:
            font = fonts[span.get('font-family').strip("'")]
            top = font['CFF '].cff.topDictIndex[0]
            glyphs = top.CharStrings
            cmap = font.getBestCmap()
            scale = float(span.get('font-size')) * top.FontMatrix[0]
            x, y = float(span.get('x', 0)), float(span.get('y', 0))
            pen = SVGPathPen(glyphs)
            for char in span.text or '':
                glyph = glyphs[cmap[ord(char)]]
                glyph.draw(TransformPen(pen, (scale, 0, 0, -scale, x, y)))
                x += glyph.width * scale
                glyph_count += 1
            ET.SubElement(group, ns + 'path', {'d': pen.getCommands(), 'fill': span.get('fill', '#000000')})
        parent.insert(list(parent).index(text), group)
        parent.remove(text)
# SVGLoader switches on unprefixed element names.
for node in root.iter():
    node.tag = node.tag.rsplit('}', 1)[-1]
root.set('data-outlined-glyphs', str(glyph_count))
sys.stdout.write(ET.tostring(root, encoding='unicode'))
