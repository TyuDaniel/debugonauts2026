#!/usr/bin/env python3
"""Bake showcase fields into frontend/public/baked/ from a running SkyDive backend.
Written with AI coding assistance (Claude Code).

    backend/.venv/bin/python scripts/bake.py scripts/targets.json --api http://127.0.0.1:8000 [--only key]

Layout written (docs/API.md, "Baked fields"):
    index.json
    {key}/{n_px}/exposures.json   same shape as /api/exposures (+ "capped", "total")
    {key}/{n_px}/cutouts.bin      one SKYB with every loaded exposure
    {key}/{n_px}/history.bin  {key}/{n_px}/overlay.json  {key}/neossat.json  {key}/sso.json
The history / overlay / neossat / sso routes are optional: a missing or failing one is
skipped with a warning and any previously baked file is left in place.
"""
import argparse
import json
import struct
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
PIXSCALE = 6.15
BATCH = 32


def skyb_encode(header: dict, payload: bytes) -> bytes:
    hj = json.dumps(header, separators=(",", ":")).encode()
    return b"SKYB" + struct.pack("<I", len(hj)) + hj + b"\0" * ((-(8 + len(hj))) % 4) + payload


def skyb_decode(buf: bytes):
    if buf[:4] != b"SKYB":
        raise ValueError("not a SKYB container")
    (h,) = struct.unpack("<I", buf[4:8])
    return json.loads(buf[8:8 + h]), buf[(8 + h + 3) // 4 * 4:]


def warn(msg: str):
    print(f"  WARNING: {msg}", file=sys.stderr, flush=True)


def write(path: Path, data: bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    tmp.replace(path)
    print(f"  wrote {path.relative_to(ROOT) if path.is_relative_to(ROOT) else path}  {len(data) / 1e6:.2f} MB", flush=True)


def cap_exposures(listing: dict, cap: int) -> dict:
    """Thin a deep field to about `cap` exposures spread over every visit and wavelength.

    Each visit keeps the same share, sampled evenly along wavelength, so the time sampling
    (the point of a deep field) and all six detectors survive the cap.
    """
    exps = sorted(listing["exposures"], key=lambda e: e["mjd"])
    total = len(exps)
    if total > cap:
        by_visit: dict[int, list] = {}
        for e in exps:
            by_visit.setdefault(e.get("visit"), []).append(e)
        per = max(1, cap // len(by_visit))
        kept = []
        for group in by_visit.values():
            group.sort(key=lambda e: (e.get("wave_um") or 0.0))
            if len(group) <= per:
                kept += group
            else:
                step = len(group) / per
                kept += [group[int((i + 0.5) * step)] for i in range(per)]
        kept.sort(key=lambda e: e["mjd"])
    else:
        kept = exps
    count: dict[int, list] = {}
    for e in kept:
        count.setdefault(e.get("visit"), []).append(e["mjd"])
    visits = []
    for v in listing.get("visits", []):
        if v["id"] in count:
            m = count[v["id"]]
            visits.append({**v, "mjd_start": min(m), "mjd_end": max(m), "n": len(m)})
    return {**listing, "exposures": kept, "visits": visits, "capped": total > cap, "total": total}


def fetch_cutouts(client: httpx.Client, api: str, ra: float, dec: float, n_px: int, ids: list[str], workers: int):
    """All batches -> one merged SKYB (items in the order of `ids`)."""
    chunks = [ids[i:i + BATCH] for i in range(0, len(ids), BATCH)]

    def one(chunk):
        last = None
        for attempt in range(3):
            try:
                r = client.post(f"{api}/api/cutouts", json={"ra": ra, "dec": dec, "n_px": n_px, "ids": chunk})
                r.raise_for_status()
                return skyb_decode(r.content)
            except Exception as e:  # retry the whole batch; finished cutouts are cached server-side
                last = e
                time.sleep(1 + attempt)
        raise RuntimeError(f"cutout batch failed: {last}")

    t0 = time.time()
    with ThreadPoolExecutor(workers) as pool:
        parts = list(pool.map(one, chunks))
    items, payload, names, head0 = [], [], {}, None
    per = n_px * n_px * 8
    for chunk, (head, pay) in zip(chunks, parts):
        head0 = head0 or head
        ok = [it for it in head["items"] if it.get("ok")]
        if [it["id"] for it in head["items"]] != chunk or len(pay) != per * len(ok):
            raise RuntimeError("cutout batch does not match the request")
        names.update(head.get("flag_names", {}))
        items += head["items"]
        payload.append(pay)
    failed = [it for it in items if not it.get("ok")]
    for it in failed[:5]:
        warn(f"exposure {it['id']}: {it.get('error')}")
    header = {k: v for k, v in (head0 or {}).items() if k not in ("items", "flag_names")}
    header.update({"ra": ra, "dec": dec, "n_px": n_px, "pixscale_arcsec": PIXSCALE,
                   "flag_names": dict(sorted(names.items(), key=lambda kv: int(kv[0]))), "items": items})
    print(f"  cutouts: {len(items) - len(failed)}/{len(items)} ok in {time.time() - t0:.1f} s", flush=True)
    return skyb_encode(header, b"".join(payload)), items


def optional(client: httpx.Client, what: str, url: str, params: dict, dest: Path, binary: bool = False):
    try:
        r = client.get(url, params=params)
        if r.status_code != 200:
            raise RuntimeError(f"HTTP {r.status_code} {r.text[:120]!r}")
        if binary:
            skyb_decode(r.content)
            data = r.content
        else:
            data = json.dumps(r.json(), separators=(",", ":")).encode()
        write(dest, data)
        return True
    except Exception as e:
        warn(f"{what} skipped ({e})")
        return False


def bake_target(client, api: str, t: dict, n_px: int, out: Path, cap: int, workers: int) -> bool:
    ra, dec, key = t["ra"], t["dec"], t["key"]
    print(f"{key}  n_px={n_px}  ra={ra} dec={dec}", flush=True)
    d = out / key / str(n_px)
    r = client.get(f"{api}/api/exposures", params={"ra": ra, "dec": dec})
    r.raise_for_status()
    listing = cap_exposures(r.json(), cap)
    if not listing["exposures"]:
        warn("no exposures cover this position; field not baked")
        return False
    print(f"  exposures: {len(listing['exposures'])} of {listing['total']}"
          f"{' (capped, spread over all visits)' if listing['capped'] else ''}, {len(listing['visits'])} visits", flush=True)
    blob, items = fetch_cutouts(client, api, ra, dec, n_px, [e["id"] for e in listing["exposures"]], workers)
    # the cutout header is authoritative for wavelength and time
    by_id = {it["id"]: it for it in items if it.get("ok")}
    for e in listing["exposures"]:
        it = by_id.get(e["id"])
        if it:
            for k in ("mjd", "wave_um", "bw_um"):
                if it.get(k) is not None:
                    e[k] = it[k]
    write(d / "cutouts.bin", blob)
    write(d / "exposures.json", json.dumps(listing, separators=(",", ":")).encode())
    arcsec = round(n_px * PIXSCALE, 3)
    pos = {"ra": ra, "dec": dec}
    optional(client, "history", f"{api}/api/history", {**pos, "arcsec": arcsec}, d / "history.bin", binary=True)
    optional(client, "overlay", f"{api}/api/overlay", {**pos, "arcsec": arcsec}, d / "overlay.json")
    optional(client, "neossat", f"{api}/api/neossat", pos, out / key / "neossat.json")
    mjds = sorted({round(e["mjd"], 2) for e in listing["exposures"]})
    step = max(1, len(mjds) // 12)
    optional(client, "sso", f"{api}/api/sso",
             {**pos, "arcsec": arcsec, "mjds": ",".join(f"{m:.4f}" for m in mjds[::step][:12])}, out / key / "sso.json")
    return True


def update_index(out: Path, targets: list[dict], baked: dict[str, list[int]]):
    """Merge into index.json so `--only` keeps the other fields; order follows targets.json."""
    path = out / "index.json"
    old = {}
    if path.exists():
        try:
            old = {f["key"]: f for f in json.loads(path.read_text()).get("fields", [])}
        except Exception:
            warn("existing index.json unreadable; rebuilding it")
    fields = []
    for t in targets:
        sizes = set(baked.get(t["key"], []))
        prev = old.pop(t["key"], None)
        if prev and abs(prev.get("ra", 1e9) - t["ra"]) < 1e-6 and abs(prev.get("dec", 1e9) - t["dec"]) < 1e-6:
            sizes |= {n for n in prev.get("n_px", []) if (out / t["key"] / str(n) / "cutouts.bin").exists()}
        if not sizes:
            continue
        fields.append({"key": t["key"], "name": t["name"], "ra": t["ra"], "dec": t["dec"], "n_px": sorted(sizes),
                       "blurb": t.get("blurb", ""), "note": t.get("note", "")})
    fields += list(old.values())          # fields baked from another targets file
    write(path, json.dumps({"fields": fields}, indent=1, ensure_ascii=False).encode())


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("targets")
    ap.add_argument("--api", default="http://127.0.0.1:8000")
    ap.add_argument("--only", action="append", help="bake only this key (repeatable)")
    ap.add_argument("--n-px", type=int, action="append", help="override the sizes in the targets file")
    ap.add_argument("--out", default=str(ROOT / "frontend" / "public" / "baked"))
    ap.add_argument("--cap", type=int, default=600, help="exposures to keep per field")
    ap.add_argument("--workers", type=int, default=2, help="cutout batches in flight")
    a = ap.parse_args()

    spec = json.loads(Path(a.targets).read_text())
    targets = spec["targets"]
    sizes = a.n_px or spec.get("n_px") or [64]
    if a.only:
        unknown = set(a.only) - {t["key"] for t in targets}
        if unknown:
            sys.exit(f"unknown key(s): {', '.join(sorted(unknown))}")
    out = Path(a.out)
    api = a.api.rstrip("/")
    baked: dict[str, list[int]] = {}
    failures = 0
    with httpx.Client(timeout=httpx.Timeout(600, connect=10)) as client:
        try:
            client.get(f"{api}/api/health").raise_for_status()
        except Exception as e:
            sys.exit(f"backend not reachable at {api}: {e}")
        for t in targets:
            if a.only and t["key"] not in a.only:
                continue
            for n_px in t.get("n_px", sizes) if not a.n_px else sizes:
                try:
                    if bake_target(client, api, t, n_px, out, a.cap, a.workers):
                        baked.setdefault(t["key"], []).append(n_px)
                except Exception as e:
                    failures += 1
                    warn(f"{t['key']} n_px={n_px} failed: {e}")
    update_index(out, targets, baked)
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
