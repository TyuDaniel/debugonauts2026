import pickle,numpy as np,stk,sx
exec(open('reveal.py').read().split("stale=lambda")[0])
def cen(m):
    yy,xx=np.indices(m.shape); w=(np.hypot(xx-c0,yy-c0)<=2.2); v=np.clip(m-np.nanmedian(m),0,None)*w; v=np.nan_to_num(v); return ((v*xx).sum()/v.sum()-c0)*6.15,((v*yy).sum()/v.sum()-c0)*6.15
bins=[(0.7,1.1),(1.1,1.65),(1.65,2.45),(2.45,3.1),(3.1,3.85),(3.85,4.1),(4.1,4.3),(4.3,4.45),(4.45,4.6),(4.6,4.75),(4.75,4.9),(4.9,5.05)]
print('wl bin      n  flux_uJy  err  centroid offset (x=+W.. arcsec east-left grid cols, y north)')
for lo,hi in bins:
    s=[o for o in objs if lo<=o['wl']<hi]
    if len(s)<3: print(lo,hi,len(s)); continue
    m,_=stk.stack(s,sx.w0855_pos,n); f,sig,sn,pk=snr(m); cx,cy=cen(m)
    print('%.2f-%.2f %3d %6.0f %4.0f  SNR %5.1f  cen dx=%+.1f" (cols; +=west) dy=%+.1f" (north)'%(lo,hi,len(s),f,sig,sn,cx,cy))
