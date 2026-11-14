import asyncio, json, sx
rows,t=sx.discover(133.7588,-7.2418); keys=[sx.key_of(r) for r in rows]
ALL=('IMAGE','FLAGS','VARIANCE','ZODI')
def run(label,half,conc,want=ALL,tail=True):
    ok,errs,st,wall=asyncio.run(sx.fetch_all(keys,sx.w0855_pos,half,conc,want=want,tail=tail))
    d=st.as_dict(); print('%-18s px=%3d conc=%3d wall=%5.1fs MB=%6.1f nreq=%4d retries=%d fail=%d errs=%d MB/s=%.1f lat_med=%.2f p95=%.2f %s'%(label,2*half,conc,wall,d['MB'],d['nreq'],d['retries'],d['fail'],len(errs),d['MB']/wall,d['lat_med'],d['lat_p95'],d['codes']),flush=True)
for rep in (1,2):
    for c in (12,32,64):
        run('full',32,c)
    for c in (12,32,64):
        run('IMG+FLAGS nowave',32,c,want=('IMAGE','FLAGS'),tail=False)
run('IMG+FLAGS nowave',32,128,want=('IMAGE','FLAGS'),tail=False)
run('IMG+FLAGS nowave',64,64,want=('IMAGE','FLAGS'),tail=False)
run('IMG+FLAGS nowave',8,64,want=('IMAGE','FLAGS'),tail=False)
