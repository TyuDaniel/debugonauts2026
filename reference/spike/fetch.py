import asyncio,sys,time,pickle,sx
name,ra,dec,half=sys.argv[1],float(sys.argv[2]),float(sys.argv[3]),int(sys.argv[4])
colls=sys.argv[5].split(',') if len(sys.argv)>5 else ("spherex_dr1","spherex_qr3")
rows,t=sx.discover(ra,dec,colls); print('SIA %d rows %.1fs'%(len(rows),t))
from collections import Counter; print(Counter(r['obs_collection'] for r in rows))
# de-duplicate same exposure in dr1 and qr3 (prefer dr1)
seen={}
for r in rows:
    k=(r['obs_id'],r['energy_bandpassname'])
    if k not in seen or r['obs_collection']=='spherex_dr1': seen[k]=r
rows=list(seen.values()); print('after de-dup',len(rows))
keys=[sx.key_of(r) for r in rows]
ok,errs,st,wall=asyncio.run(sx.fetch_all(keys,lambda mjd:(ra,dec),half,48))
print('fetched %d ok, %d errs, %.1fs'%(len(ok),len(errs),wall),st.as_dict())
if errs: print(repr(errs[0]))
out=[]
for o in ok:
    dd=sx.decode(o); dd.update(key=o['key'],mjd=o['mjd'],det=o['det'],x=o['x'],y=o['y'],x0=o['x0'],y0=o['y0'],hdr=o['hdr'],tail=o['tail']); out.append(dd)
pickle.dump(out,open(name+'.pkl','wb'))
