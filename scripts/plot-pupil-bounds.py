"""Render the sampled numerical pupil data; requires Pillow."""
import json,base64,math
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont
r=json.loads(Path('artifacts/pupil-default-preview-data.json').read_text())
W,H=1720,1320;im=Image.new('RGB',(W,H),'#f5f7fb');d=ImageDraw.Draw(im)
font=ImageFont.load_default(size=16);small=ImageFont.load_default(size=14);title=ImageFont.load_default(size=25)
orange='#f3b43f';cyan='#24d9ef';blue='#8196aa';ink='#1b2939';N=r['gridSize'];size=270
center=lambda text,x,y,f=font,color=ink:d.text((x,y),text,fill=color,font=f,anchor='mt')
center(f"7Artisans 135mm  f/{r['fNumber']:.2f}  |  native sensor gap = {r['gapMm']:.3f} mm",W/2,16,title)
center('Orange: previous fixed128   |   Cyan: NEW moving-center128   |   RGB support: 650 / 550 / 450 nm',W/2,53)
center('Proposal probes: 380 / 587.6 / 780 nm   |   Global mixture retained: 5%',W/2,78,small)
for k,p in enumerate(r['panels']):
 x0=72+k*333
 for row in range(3):
  y0=145+row*380
  if row==0:cx=cy=0.;extent=r['referenceRadiusMm']*2*1.06
  else:panel=p['common' if row==1 else 'zoom'];cx,cy,extent=[panel[t] for t in ['cx','cy','extent']]
  def X(x):return x0+size/2+(x-cx)*size/extent
  def Y(y):return y0+size/2-(y-cy)*size/extent
  label=['Reference disc (scale)','Fixed128 vs moving128','Moving128 close-up'][row]
  center(f"h = {p['heightMm']:.2f} mm",x0+size/2,y0-47)
  center(label,x0+size/2,y0-24,small)
  d.rectangle((x0,y0,x0+size,y0+size),fill='#080d13')
  if row==0:
   # The top row shows scale, projecting the SAME traced samples as row 2;
   # it does not pretend to prove empty support over the entire black disc.
   radius=r['referenceRadiusMm']
   for a in range(0,360,5):
    pts=[(X(radius*math.cos(math.radians(t))),Y(radius*math.sin(math.radians(t)))) for t in range(a,a+3)]
    d.line(pts,fill=blue,width=1)
   q=p['common'];raw=base64.b64decode(q['rgb'])
   for j in range(N):
    for i in range(N):
     color=tuple(raw[(j*N+i)*3:(j*N+i)*3+3])
     if any(color):
      px=q['cx']+((i+.5)/N-.5)*q['extent'];py=q['cy']+(.5-(j+.5)/N)*q['extent'];d.point((round(X(px)),round(Y(py))),fill=color)
  else:
   panel=p['common' if row==1 else 'zoom'];a=Image.frombytes('RGB',(N,N),base64.b64decode(panel['rgb']));im.paste(a.resize((size,size),Image.Resampling.BILINEAR),(x0,y0))
  boxes=[(p['moving'],cyan)] if row in [0,2] else [(p['fixed'],orange),(p['moving'],cyan)]
  for b,col in boxes:d.rectangle((X(b[0]),Y(b[3]),X(b[1]),Y(b[2])),outline=col,width=2)
  for f in [0,.5,1]:
   xx=x0+f*size;yy=y0+f*size;vx=cx+(f-.5)*extent;vy=cy+(.5-f)*extent
   d.line((xx,y0+size,xx,y0+size+4),fill=ink);center(f'{vx:.1f}' if row==0 else f'{vx:.2f}',xx,y0+size+7,small)
   if k==0:d.text((x0-8,yy),f'{vy:.1f}' if row==0 else f'{vy:.2f}',fill=ink,font=small,anchor='rm')
  center('x (mm)',x0+size/2,y0+size+27,small)
  if k==0:
   lab=Image.new('RGBA',(60,22));ImageDraw.Draw(lab).text((0,0),'y (mm)',fill=ink,font=small);lab=lab.rotate(90,expand=True);im.paste(lab,(3,int(y0+size/2-lab.height/2)),lab)
center('Full physical f64 tracing; finite sampled support is not a coverage proof. Top row is reference-plane scale only.',W/2,1285,small)
Path('artifacts').mkdir(exist_ok=True);im.save('artifacts/pupil-default-moving128-preview.png')
print('artifacts/pupil-default-moving128-preview.png')
