"""Prepare the Windows OCR host and register it for the current Firefox user."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import struct
import subprocess
import sys
import urllib.request
import venv

ROOT = Path(__file__).resolve().parent
REV = "5e7ff7a3692252dd21f42d8c7fd07b9905a1b114"
BASE = f"https://huggingface.co/SWHL/RapidOCR/resolve/{REV}/PP-OCRv3"
MODELS = {
    "det": "3439588c030faea393a54515f51e983d8e155b19a2e8aba7891934c1cf0de526",
    "rec": "897a3ededb38fee0dae2c1ccee38241f37df202c9509e3abca02e9217c5ee615",
}
HOST = "local.subtitle_blur"


def prepare_models(directory):
    directory.mkdir(parents=True, exist_ok=True)
    for kind, expected in MODELS.items():
        model = directory / f"ch_PP-OCRv3_{kind}_infer.onnx"
        if model.exists() and hashlib.sha256(model.read_bytes()).hexdigest() == expected:
            continue
        with urllib.request.urlopen(f"{BASE}/{model.name}", timeout=120) as response:
            data = response.read()
        if hashlib.sha256(data).hexdigest() != expected:
            raise ValueError(f"Model checksum mismatch: {model.name}")
        temporary = model.with_suffix(".part")
        temporary.write_bytes(data)
        temporary.replace(model)


def verify_host(executable, python):
    # Exercise the same framed stdin/stdout exchange that Firefox uses.
    jpeg = subprocess.check_output([python, "-c",
        "import io,sys; from PIL import Image; b=io.BytesIO(); "
        "Image.new('RGB',(128,64)).save(b,'JPEG'); sys.stdout.buffer.write(b.getvalue())"])
    request = json.dumps({"id": 1, "image": base64.b64encode(jpeg).decode()}).encode()
    reply = subprocess.check_output([executable], input=struct.pack("<I", len(request)) + request,
                                    timeout=45)
    length, = struct.unpack("<I", reply[:4])
    result = json.loads(reply[4:])
    if length != len(reply) - 4 or result.get("id") != 1 or result.get("boxes") != [] or result.get("english") != []:
        raise RuntimeError("Native OCR self-test failed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prepare-only", action="store_true", help="test without changing Firefox registration")
    args = parser.parse_args()
    if sys.platform != "win32" or sys.version_info < (3, 11):
        parser.exit(1, "Windows with Python 3.11+ is required.\n")
    import winreg
    env = ROOT / ".venv"
    python = env / "Scripts" / "python.exe"
    if not python.exists():
        venv.create(env, with_pip=True)
    subprocess.run([python, "-m", "pip", "install", str(ROOT / "host")], check=True)
    prepare_models(env / "share" / "subtitle-frost" / "models")
    executable = python.with_name("subtitle-frost-host.exe")
    verify_host(executable, python)
    if args.prepare_only:
        print("OCR host self-test passed.")
        return
    manifest = env / "native-host.json"
    manifest.write_text(json.dumps({
        "name": HOST, "description": "Subtitle Frost local OCR", "type": "stdio",
        "path": str(executable), "allowed_extensions": ["local-subtitle-blur@local.invalid"],
    }), encoding="utf-8")
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, rf"Software\Mozilla\NativeMessagingHosts\{HOST}") as key:
        winreg.SetValueEx(key, "", 0, winreg.REG_SZ, str(manifest))
    print("OCR ready. Load firefox/manifest.json in Firefox.")


if __name__ == "__main__":
    main()
