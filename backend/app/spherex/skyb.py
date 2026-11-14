"""SKYB binary frame container (docs/API.md). Written with AI coding assistance (Claude Code).

bytes 0..3  "SKYB" | uint32 LE header length H | H bytes UTF-8 JSON | zero pad to a multiple of 4 | payload
"""
import json
import struct

MAGIC = b"SKYB"


def encode(header: dict, arrays=()) -> bytes:
    """header: JSON-serialisable dict. arrays: bytes-like or numpy arrays, concatenated in order."""
    hj = json.dumps(header, separators=(",", ":"), allow_nan=False).encode("utf-8")
    parts = [MAGIC, struct.pack("<I", len(hj)), hj, b"\0" * ((-(8 + len(hj))) % 4)]
    for a in arrays:
        if hasattr(a, "dtype"):
            if a.dtype.byteorder == ">":
                a = a.astype(a.dtype.newbyteorder("<"))
            a = a.tobytes()
        parts.append(bytes(a) if not isinstance(a, bytes) else a)
    return b"".join(parts)


def decode(buf) -> tuple[dict, memoryview]:
    """Returns (header, payload view). Raises ValueError on a malformed container."""
    mv = memoryview(buf)
    if len(mv) < 8 or bytes(mv[:4]) != MAGIC:
        raise ValueError("not a SKYB container")
    (h,) = struct.unpack("<I", mv[4:8])
    if 8 + h > len(mv):
        raise ValueError("truncated SKYB header")
    header = json.loads(bytes(mv[8:8 + h]).decode("utf-8"))
    start = (8 + h + 3) // 4 * 4
    return header, mv[start:]
