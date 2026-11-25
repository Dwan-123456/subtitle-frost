"""Chinese PP-OCR detector + recognizer for horizontal bilingual movie captions."""
import sys
import re
import time
from collections import deque
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

MODELS = Path(sys.prefix) / "share" / "subtitle-frost" / "models"
HAN = re.compile(r"[\u3400-\u9fff\uf900-\ufaff]")
DET_GAIN = np.array([1/0.229, 1/0.224, 1/0.225], dtype=np.float32) / 255
DET_BIAS = np.array([0.485/0.229, 0.456/0.224, 0.406/0.225], dtype=np.float32)

def load_model(kind):
    options = ort.SessionOptions()
    options.intra_op_num_threads = 3
    options.inter_op_num_threads = 1
    options.add_session_config_entry("session.intra_op.allow_spinning", "0")
    options.add_session_config_entry("session.inter_op.allow_spinning", "0")
    model = next(MODELS.glob(f"*_{kind}_infer.onnx"))
    return ort.InferenceSession(str(model), options, providers=["CPUExecutionProvider"])

def infer(session, array):
    data = np.ascontiguousarray(array.transpose(2, 0, 1)[None], dtype=np.float32)
    return session.run(None, {session.get_inputs()[0].name: data})[0]

def runs(mask):
    edges = np.flatnonzero(np.diff(np.r_[False, mask, False].astype(np.int8)))
    return zip(edges[::2], edges[1::2])

class ChineseLines:
    def __init__(self):
        self.detector = load_model("det")
        self.reader = load_model("rec")
        chars = self.reader.get_modelmeta().custom_metadata_map["character"]
        self.characters = [""] + chars.splitlines() + [" "]
        self.recent_lines = deque(maxlen=12)

    def language(self, crop):
        now = time.monotonic()
        shape = crop.width / crop.height
        thumb = np.asarray(crop.convert("L").resize((64, 16)), dtype=np.int16)
        for seen, aspect, previous, decision in reversed(self.recent_lines):
            if now - seen > 0.3:
                break
            if abs(shape - aspect) < 0.06 and np.max(np.abs(thumb - previous)) <= 5:
                return decision
        width = min(1440, max(16, round(48 * crop.width / crop.height)))
        rgb = np.asarray(crop.resize((width, 48), Image.Resampling.BILINEAR))
        scores = infer(self.reader, rgb[:, :, ::-1].astype(np.float32) / 127.5 - 1)[0]
        ids = scores.argmax(axis=1)
        keep = (ids != 0) & (ids != np.r_[-1, ids[:-1]])
        text = "".join(self.characters[i] for i in ids[keep])
        han = bool(HAN.search(text))
        latin = bool(re.search(r"[A-Za-z]{2,}", text))
        if not keep.any() or scores.max(axis=1)[keep].mean() < 0.80:
            language = "unknown"
        elif latin:
            language = "mixed" if han else "en"
        else:
            language = "zh" if han else "unknown"
        self.recent_lines.append((now, shape, thumb, language))
        return language

    def boxes(self, img):
        return self.regions(img)["zh"]

    def regions(self, img):
        w, h = img.size
        size = tuple(max(32, round(n / 32) * 32) for n in img.size)
        rgb = np.asarray(img.resize(size, Image.Resampling.BILINEAR), dtype=np.float32)
        normalized = rgb[:, :, ::-1] * DET_GAIN
        normalized -= DET_BIAS
        pixels = infer(self.detector, normalized)[0, 0] > 0.35
        sy, sx = h / pixels.shape[0], w / pixels.shape[1]
        regions = {"zh": [], "en": []}
        for y0, y1 in runs(pixels.sum(axis=1) >= 3):
            if y1 - y0 < 3:
                continue
            columns = np.flatnonzero(pixels[y0:y1].any(axis=0))
            for span in np.split(columns, np.where(np.diff(columns) > (y1-y0)*1.5)[0]+1):
                if span.size < 3:
                    continue
                pad = max(2, round((y1-y0)*0.35))
                box = [max(0, int((span[0]-pad)*sx)), max(0, int((y0-pad)*sy)),
                       min(w, int((span[-1]+1+pad)*sx)), min(h, int((y1+pad)*sy))]
                language = self.language(img.crop(box))
                if language != "unknown":
                    extra = max(1, round((box[3] - box[1]) * 0.24))
                    box = [max(0, box[0]-extra), max(0, box[1]-extra),
                           min(w, box[2]+extra), min(h, box[3]+extra)]
                    regions["zh" if language == "zh" else "en"].append(box)
        return regions
