import pickle, time, numpy as np, warnings, sx
from astropy.wcs import WCS
from scipy.ndimage import map_coordinates
warnings.simplefilter('ignore')
B=lambda *bits: sum(1<<b for b in bits)
NAMES={0:'TRANSIENT',1:'OVERFLOW',2:'SUR_ERROR',6:'NONFUNC',7:'DICHROIC',9:'MISSING_DATA',10:'HOT',11:'COLD',12:'FULLSAMPLE',14:'PHANMISS',15:'NONLINEAR',17:'PERSIST',19:'OUTLIER',20:'CROSSTALK',21:'SOURCE',22:'GHOST',23:'GHOST_FPA',24:'GHOST_EXT',25:'STREAK',26:'BLOOM',27:'SNOWBALL',28:'HALO',30:'OFFDET'}
MASK_BAD=B(0,2,6,7,9,10,11,14,15,17,20,22,23,24,25,26,27,28,30)   # SSDC mosaic rejection list (Expl. Supp.) + off-detector
MASK_MIN=B(0,2,6,9,10,11,30)
MASK_ALL=MASK_BAD|B(1,19)
SCALE=6.15
def grid(n,scale=SCALE):
    g=(np.arange(n)-(n-1)/2)*scale/3600.; xi,eta=np.meshgrid(-g,g)   # east left, north up; xi east +
    return xi,eta
def tan_inv(xi,eta,ra0,dec0):
    xi=np.radians(xi);eta=np.radians(eta);d0=np.radians(dec0)
    den=np.cos(d0)-eta*np.sin(d0)
    ra=ra0+np.degrees(np.arctan2(xi,den)); dec=np.degrees(np.arctan2(np.sin(d0)+eta*np.cos(d0),np.hypot(xi,den)))
    return ra,dec
def prep(o,mask=MASK_BAD,bg='zodi'):
    img=o['IMAGE'].astype(float).copy()
    f=o['FLAGS']
    if bg=='zodi' and 'ZODI' in o: img-=o['ZODI']
    bad=(f&mask)!=0
    img[bad]=np.nan
    sky=np.isfinite(img)&((f&(1<<21))==0)
    med=np.nanmedian(img[sky]) if sky.sum()>50 else np.nanmedian(img)
    return img-med, med
def reproj(o,img,ra0,dec0,n,order=1,scale=SCALE):
    xi,eta=grid(n,scale); ra,dec=tan_inv(xi,eta,ra0,dec0)
    w=WCS(o['hdr']); x,y=w.all_world2pix(ra,dec,0)
    return map_coordinates(img,[y-o['y0'],x-o['x0']],order=order,cval=np.nan,mode='constant')
def combine(c,how='median',clip=3.0):
    if how=='median': return np.nanmedian(c,0)
    m=np.nanmedian(c,0); s=1.4826*np.nanmedian(np.abs(c-m),0)
    cc=np.where(np.abs(c-m)<=clip*np.maximum(s,1e-9),c,np.nan); return np.nanmean(cc,0)
def visits(objs,gap=20):
    m=np.sort(np.array([o['mjd'] for o in objs])); cuts=[m[0]-1]+[ (m[i]+m[i+1])/2 for i in range(len(m)-1) if m[i+1]-m[i]>gap]+[m[-1]+1]
    return [(cuts[i],cuts[i+1]) for i in range(len(cuts)-1)]
def stack(objs,posfn,n,mask=MASK_BAD,bg='zodi',how='median',order=1,scale=SCALE):
    c=[]
    for o in objs:
        img,_=prep(o,mask,bg); ra0,dec0=posfn(o['mjd']); c.append(reproj(o,img,ra0,dec0,n,order,scale))
    c=np.array(c); return combine(c,how),c
def stretch(a,lo=30,hi=99.7,kind='asinh',soft=None):
    v0=np.nanpercentile(a,lo); v1=np.nanpercentile(a,hi); x=np.clip((a-v0)/(v1-v0),0,1)
    if kind=='linear': return x
    if kind=='sqrt': return np.sqrt(x)
    s=soft or 0.05
    return np.arcsinh(x/s)/np.arcsinh(1/s)
def mjd2date(m):
    from astropy.time import Time; return Time(m,format='mjd').iso[:10]
