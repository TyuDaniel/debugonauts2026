import pickle,numpy as np,stk,sx,matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
objs=pickle.load(open('w0855_64.pkl','rb')); n=41; c0=(n-1)/2
OM=(6.15/206265)**2*1e12   # uJy per MJy/sr per pixel
def phot(m,x=c0,y=c0,r=1.7):
    yy,xx=np.indices(m.shape); rr=np.hypot(xx-x,yy-y); ann=(rr>3.5)&(rr<6.5); ap=rr<=r
    return np.nansum(m[ap]-np.nanmedian(m[ann]))*OM
def snr(m):
    f=phot(m); rng=np.random.default_rng(2); fs=[]
    for k in range(600):
        x,y=rng.uniform(7,n-8,2)
        if np.hypot(x-c0,y-c0)<5: continue
        fs.append(phot(m,x,y))
    fs=np.array(fs); sig=1.4826*np.median(np.abs(fs-np.median(fs)))
    pk=m[int(c0),int(c0)]; pix=1.4826*np.nanmedian(np.abs(m-np.nanmedian(m)))
    return f,sig,f/sig,pk/pix
stale=lambda mjd:(133.786245,-7.244372)          # catalogued (epoch 2014.3) position, no proper motion
wise=lambda mjd:(133.795125,-7.245139)           # WISE designation position (2010)
mid=sx.w0855_pos(np.median([o['mjd'] for o in objs])); fixed=lambda mjd:mid
print('predicted position at median epoch:',mid, ' first/last:',sx.w0855_pos(min(o['mjd'] for o in objs)),sx.w0855_pos(max(o['mjd'] for o in objs)))
sels={'D5+D6':[o for o in objs if o['det'] in (5,6)],'D6':[o for o in objs if o['det']==6],'D5':[o for o in objs if o['det']==5],'wl>=4.55':[o for o in objs if o['wl']>=4.55],'wl4.1-4.75':[o for o in objs if 4.1<=o['wl']<4.75],'wl 4.55-5.0 clipmean':[o for o in objs if o['wl']>=4.55],'D1-D4':[o for o in objs if o['det']<=4]}
res={}
for nm,s in sels.items():
    for pn,pf in [('comoving',sx.w0855_pos),('sky-fixed@pred',fixed),('catalog-2014',stale)]:
        m,c=stk.stack(s,pf,n,how='median')
        if 'clip' in nm: m=stk.combine(c,'clipmean')
        f,sig,sn,pk=snr(m); res[nm,pn]=m
        print('%-22s %-15s n=%3d  ap flux %6.0f uJy  +-%4.0f (random apertures)  SNR %5.1f   peak/pixMAD %5.1f'%(nm,pn,len(s),f,sig,sn,pk))
# single exposure SNR in D6
ss=[]
for o in sels['wl>=4.55']:
    m,_=stk.stack([o],sx.w0855_pos,n); ss.append(snr(m)[2])
ss=np.array(ss); print('single-exposure SNR wl>=4.55: median %.1f, 16-84%% %.1f..%.1f, frac>3 %.2f n=%d'%(np.median(ss),*np.percentile(ss,[16,84]),(ss>3).mean(),len(ss)))
# per visit comoving D6 (blinkable?)
for a,b in stk.visits(objs):
    s=[o for o in sels['wl>=4.55'] if a<o['mjd']<b]
    if len(s)>2:
        m,_=stk.stack(s,sx.w0855_pos,n); print('visit',stk.mjd2date(s[0]['mjd']),'n=%d'%len(s),'SNR %.1f flux %.0f'%(snr(m)[2],snr(m)[0]), 'pos',sx.w0855_pos(np.mean([o['mjd'] for o in s])))
def show(ax,m,title,ref=None):
    v0=np.nanpercentile(ref if ref is not None else m,30); v1=np.nanpercentile(ref if ref is not None else m,99.7)
    x=np.clip((m-v0)/(v1-v0),0,1); ax.imshow(np.arcsinh(x/0.05)/np.arcsinh(20),origin='lower',cmap='gray',vmin=0,vmax=1,interpolation='nearest')
    ax.plot([c0-5,c0-2.5],[c0,c0],'c-',lw=1); ax.plot([c0+2.5,c0+5],[c0,c0],'c-',lw=1); ax.plot([c0,c0],[c0-5,c0-2.5],'c-',lw=1); ax.plot([c0,c0],[c0+2.5,c0+5],'c-',lw=1)
    ax.set_title(title,fontsize=9); ax.set_xticks([]); ax.set_yticks([])
for nm,tag in [('wl4.1-4.75','best'),('D5+D6','d56')]:
    ref=res[nm,'comoving']
    for pn,fn,t in [('catalog-2014','before','BEFORE: stacked at catalogued 2014 position (no motion)'),('comoving','after','AFTER: stacked at proper-motion-corrected position')]:
        fig,ax=plt.subplots(1,1,figsize=(4.6,4.8)); show(ax,res[nm,pn],'W0855 %s n=%d\n%s'%(nm,len(sels[nm]),t),ref); fig.tight_layout(); fig.savefig('w0855_reveal_%s_%s.png'%(tag,fn),dpi=110); plt.close(fig)
fig,ax=plt.subplots(2,4,figsize=(15,8))
show(ax[0,0],res['wl4.1-4.75','catalog-2014'],'4.1-4.75um, catalogued 2014 pos (BEFORE)',res['wl4.1-4.75','comoving'])
show(ax[0,1],res['wl4.1-4.75','sky-fixed@pred'],'4.1-4.75um, sky-fixed at predicted pos')
show(ax[0,2],res['wl4.1-4.75','comoving'],'4.1-4.75um, co-moving (AFTER)')
show(ax[0,3],res['D1-D4','comoving'],'D1-D4 (0.75-3.8um) co-moving: Gaia G=16.3 star 7" NW')
show(ax[1,0],res['D5+D6','catalog-2014'],'D5+D6 catalogued 2014 pos',res['D5+D6','comoving'])
show(ax[1,1],res['D5+D6','comoving'],'D5+D6 co-moving')
show(ax[1,2],res['D6','comoving'],'D6 co-moving')
show(ax[1,3],res['D5','comoving'],'D5 (3.8-4.4um) co-moving')
fig.tight_layout(); fig.savefig('w0855_reveal_panel.png',dpi=85)
