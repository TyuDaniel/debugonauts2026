"""Throwaway SPHEREx L2 byte-range cutout library (spike)."""
import asyncio, time, io, csv, warnings, logging, urllib.request, urllib.parse
import numpy as np, aiohttp
from astropy.io import fits
from astropy.wcs import WCS
warnings.simplefilter('ignore'); logging.getLogger('astropy').setLevel(logging.ERROR)
from astropy.io.fits.hdu.compressed._codecs import Rice1

S3 = "https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/"
N = 2040
NPIXB = N * N * 4            # 16646400, multiple of 2880
IMG_HDR_GUESS = 23040        # IMAGE header bytes (verified per file)
FLG_HDR_GUESS = 17280
VAR_HDR_GUESS = 11520
ZOD_HDR_GUESS = 11520
RICE = Rice1(blocksize=32, bytepix=4, tilesize=N)


def discover(ra, dec, collections=("spherex_dr1", "spherex_qr3"), radius=0.0003):
    q = "&".join("COLLECTION=" + c for c in collections)
    url = f"https://irsa.ipac.caltech.edu/SIA?{q}&POS=circle+{ra}+{dec}+{radius}&RESPONSEFORMAT=CSV"
    t = time.time()
    txt = urllib.request.urlopen(url, timeout=120).read().decode()
    rows = list(csv.DictReader(io.StringIO(txt)))
    return rows, time.time() - t


def hdrlen(buf, off):
    n = 0
    while off + n < len(buf):
        blk = buf[off + n:off + n + 2880]; n += 2880
        for i in range(0, len(blk), 80):
            if blk[i:i + 8] == b'END     ':
                return n
    return None


class Stats:
    def __init__(self):
        self.nreq = 0; self.bytes = 0; self.retries = 0; self.fail = 0; self.codes = {}; self.spec_miss = 0
        self.lat = []

    def as_dict(self):
        l = np.array(self.lat) if self.lat else np.array([0.])
        return dict(nreq=self.nreq, MB=round(self.bytes / 1e6, 1), retries=self.retries, fail=self.fail,
                    codes=self.codes, spec_miss=self.spec_miss, lat_med=round(float(np.median(l)), 3),
                    lat_p95=round(float(np.percentile(l, 95)), 3))


async def rng(sess, sem, st, key, a, b):
    """bytes a..b inclusive; a=None -> suffix of b bytes"""
    h = {'Range': f'bytes={a}-{b}' if a is not None else f'bytes=-{b}'}
    for k in range(4):
        async with sem:
            t = time.time()
            try:
                async with sess.get(S3 + key, headers=h) as r:
                    st.codes[r.status] = st.codes.get(r.status, 0) + 1
                    if r.status in (200, 206):
                        d = await r.read()
                        st.nreq += 1; st.bytes += len(d); st.lat.append(time.time() - t)
                        return d
                    err = r.status
            except Exception as e:
                err = type(e).__name__
                st.codes[err] = st.codes.get(err, 0) + 1
        st.retries += 1
        await asyncio.sleep(0.3 * 2 ** k)
    st.fail += 1
    raise RuntimeError(f'failed {key} {err}')


def wave_at(tail, x, y):
    """x,y 0-based full-frame pixel (scalars or arrays) -> wavelength, bandwidth (um)"""
    t = fits.BinTableHDU.fromstring(tail)
    X = t.data['X'][0].astype(float); Y = t.data['Y'][0].astype(float)
    V = t.data['VALUES'][0].reshape(len(Y), len(X), 2)
    from scipy.interpolate import RegularGridInterpolator
    out = []
    for k in (0, 1):
        f = RegularGridInterpolator((Y, X), V[:, :, k], bounds_error=False, fill_value=None)
        out.append(f(np.stack([np.atleast_1d(y) + 1.0, np.atleast_1d(x) + 1.0], -1)))
    return out[0], out[1]


async def fetch_file(sess, sem, st, key, posfn, half, want=('IMAGE', 'FLAGS', 'VARIANCE', 'ZODI'),
                     tail=True, speculative=True):
    """posfn(mjd)->(ra,dec). half: cutout is 2*half square. Returns dict or None if target off-frame."""
    flg_off_guess = 2880 + IMG_HDR_GUESS + NPIXB
    need_flag_idx = any(w in want for w in ('FLAGS', 'VARIANCE', 'ZODI'))
    tasks = [rng(sess, sem, st, key, 0, 2880 + IMG_HDR_GUESS + 2880 - 1)]
    if tail: tasks.append(rng(sess, sem, st, key, None, 5760))
    if need_flag_idx and speculative:
        tasks.append(rng(sess, sem, st, key, flg_off_guess, flg_off_guess + FLG_HDR_GUESS + N * 8 + 2880 - 1))
    r1 = await asyncio.gather(*tasks)
    head = r1[0]; tl = r1[1] if tail else None
    p = hdrlen(head, 0); ih = hdrlen(head, p)
    if ih is None:  # header longer than guess
        head = await rng(sess, sem, st, key, 0, 86399); p = hdrlen(head, 0); ih = hdrlen(head, p)
    hdr = fits.Header.fromstring(head[p:p + ih].decode())
    w = WCS(hdr)
    mjd = hdr['MJD-AVG']
    ra, dec = posfn(mjd)
    x, y = [float(v) for v in w.all_world2pix(ra, dec, 0)]
    xi, yi = int(np.floor(x)) + 1 - half, int(np.floor(y)) + 1 - half   # cutout origin (0-based full frame)
    if not (0 <= x < N and 0 <= y < N):
        return None
    y0, y1 = max(yi, 0), min(yi + 2 * half, N); x0, x1 = max(xi, 0), min(xi + 2 * half, N)
    img_data = p + ih
    flg_off = img_data + NPIXB
    fb = None
    if need_flag_idx:
        if speculative and flg_off == flg_off_guess: fb = r1[-1]
        else:
            st.spec_miss += speculative
            fb = await rng(sess, sem, st, key, flg_off, flg_off + FLG_HDR_GUESS + N * 8 + 2880 - 1)
        fh = hdrlen(fb, 0)
        fhdr = fits.Header.fromstring(fb[:fh].decode())
        assert fhdr['ZCMPTYPE'] == 'RICE_1' and fhdr['ZTILE1'] == N and fhdr['ZTILE2'] == 1 and fhdr['NAXIS1'] == 8, 'flags layout'
        idx = np.frombuffer(fb[fh:fh + N * 8], dtype='>i4').reshape(N, 2)  # (nbytes, heap offset)
        flg_data = flg_off + fh
        heap = flg_data + fhdr.get('THEAP', N * 8)
        tot = N * 8 + fhdr['PCOUNT']
        var_off = flg_data + ((tot + 2879) // 2880) * 2880
        var_data = var_off + VAR_HDR_GUESS
        zod_data = var_data + NPIXB + ZOD_HDR_GUESS

    def rowrange(d0):
        return rng(sess, sem, st, key, d0 + y0 * N * 4, d0 + y1 * N * 4 - 1)
    names = []; tasks = []
    for nm in want:
        if nm == 'IMAGE': tasks.append(rowrange(img_data))
        elif nm == 'VARIANCE': tasks.append(rowrange(var_data))
        elif nm == 'ZODI': tasks.append(rowrange(zod_data))
        elif nm == 'FLAGS':
            a = heap + int(idx[y0, 1]); b = heap + int(idx[y1 - 1, 1]) + int(idx[y1 - 1, 0]) - 1
            tasks.append(rng(sess, sem, st, key, a, b))
        names.append(nm)
    r2 = await asyncio.gather(*tasks)
    out = dict(key=key, mjd=mjd, det=int(hdr.get('DETECTOR', 0)), x=x, y=y, x0=xi, y0=yi, half=half, hdr=hdr,
               tail=tl, raw=dict(zip(names, r2)), clip=(y0, y1, x0, x1),
               flagidx=(idx[y0:y1].copy() if need_flag_idx else None),
               offs=dict(var_off=var_off, zod_off=var_data + NPIXB, epsf_off=zod_data + NPIXB) if need_flag_idx else None)
    return out


def decode(o):
    """raw bytes -> arrays (2h x 2h, NaN / 0 padded). Separate so CPU cost can be timed."""
    y0, y1, x0, x1 = o['clip']; h = o['half']; yi, xi = o['y0'], o['x0']
    res = {}
    for nm, raw in o['raw'].items():
        if nm == 'FLAGS':
            a = np.zeros((2 * h, 2 * h), dtype=np.int32) | (1 << 30)   # bit 30 = off-detector
            base = int(o['flagidx'][0, 1])
            for j in range(y1 - y0):
                nb, off = int(o['flagidx'][j, 0]), int(o['flagidx'][j, 1]) - base
                row = np.frombuffer(RICE.decode(np.frombuffer(raw[off:off + nb], dtype=np.uint8)), dtype='i4') if nb else np.zeros(N, 'i4')
                a[y0 - yi + j, x0 - xi:x1 - xi] = row[x0:x1]
        else:
            a = np.full((2 * h, 2 * h), np.nan, dtype=np.float32)
            a[y0 - yi:y1 - yi, x0 - xi:x1 - xi] = np.frombuffer(raw, dtype='>f4').reshape(y1 - y0, N)[:, x0:x1]
        res[nm] = a
    if o.get('tail') is not None:
        wl, bw = wave_at(o['tail'], o['x'], o['y'])
        res['wl'] = float(wl[0]); res['bw'] = float(bw[0])
    return res


def key_of(row):
    u = row.get('access_url') or row.get('uri')
    return u.split('ibe/data/spherex/')[-1]


async def fetch_all(keys, posfn, half, conc, **kw):
    st = Stats(); sem = asyncio.Semaphore(conc)
    conn = aiohttp.TCPConnector(limit=conc, ttl_dns_cache=300)
    t0 = time.time()
    async with aiohttp.ClientSession(connector=conn, timeout=aiohttp.ClientTimeout(total=60)) as sess:
        res = await asyncio.gather(*[fetch_file(sess, sem, st, k, posfn, half, **kw) for k in keys], return_exceptions=True)
    wall = time.time() - t0
    errs = [r for r in res if isinstance(r, Exception)]
    ok = [r for r in res if r is not None and not isinstance(r, Exception)]
    return ok, errs, st, wall


def w0855_pos(mjd):
    t = 2000 + (mjd - 51544.5) / 365.25; dt = t - 2014.3
    dec = -7.244372 + 0.673 * dt / 3600
    ra = 133.786245 + (-8.124 * dt / 3600) / np.cos(np.radians(dec))
    return ra, dec
