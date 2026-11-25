"""Firefox native messaging host; stdin/stdout carry only length-prefixed JSON."""
import base64
import io
import json
import struct
import sys
import ctypes
import os
import time

from live_ocr import ChineseLines, Image

def working_set_mb():
    class Counters(ctypes.Structure):
        _fields_ = [("cb", ctypes.c_uint32), ("faults", ctypes.c_uint32),
                    ("peak", ctypes.c_size_t), ("current", ctypes.c_size_t),
                    ("remaining", ctypes.c_size_t * 6)]
    memory = Counters()
    memory.cb = ctypes.sizeof(memory)
    ok = ctypes.windll.psapi.GetProcessMemoryInfo(ctypes.c_void_p(-1), ctypes.byref(memory), memory.cb)
    return round(memory.current / 1048576, 1) if ok else None


def main():
    engine = ChineseLines()
    wall, cpu = time.perf_counter(), time.process_time()
    usage, memory = None, working_set_mb()
    source, sink = sys.stdin.buffer, sys.stdout.buffer
    while True:
        prefix = source.read(4)
        if len(prefix) != 4:
            return
        length, = struct.unpack("<I", prefix)
        if not 0 < length <= 1200000:
            return
        raw = source.read(length)
        if len(raw) != length:
            return
        request = json.loads(raw)
        reply = {"id": request["id"]}
        try:
            start = time.perf_counter()
            frame = base64.b64decode(request["image"], validate=True)
            with Image.open(io.BytesIO(frame)) as image:
                if image.format != "JPEG" or image.width > 960 or image.height > 360:
                    raise ValueError("输入区域无效")
                regions = engine.regions(image.convert("RGB"))
                reply["boxes"] = regions["zh"]
                reply["english"] = regions["en"]
            now = time.perf_counter()
            if now - wall >= 1:
                ticks = time.process_time()
                usage = round(100 * (ticks-cpu) / ((now-wall) * (os.cpu_count() or 1)), 2)
                memory = working_set_mb()
                wall, cpu = now, ticks
            reply["perf"] = {"ms": round((now-start)*1000, 2), "cpu":usage,"mb":memory}
        except Exception as error:
            reply["error"] = str(error)
        body = json.dumps(reply).encode()
        sink.write(struct.pack("<I", len(body)) + body)
        sink.flush()
