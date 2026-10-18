from PIL import Image, ImageDraw, ImageFilter
import math, os
root=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
out=os.path.join(root,'build')
os.makedirs(out,exist_ok=True)
# NSIS MUI header image: 150 x 57 px (header bitmap dimensions).
im=Image.new('RGB',(150,57),(23,21,30)); d=ImageDraw.Draw(im)
# Small glowing OrbitChat planet and orbit on the left.
glow=Image.new('RGBA',im.size,(0,0,0,0)); gd=ImageDraw.Draw(glow)
gd.ellipse((9,7,48,47),outline=(136,123,207,95),width=5); glow=glow.filter(ImageFilter.GaussianBlur(4)); im=Image.alpha_composite(im.convert('RGBA'),glow).convert('RGB');d=ImageDraw.Draw(im)
d.ellipse((11,8,47,44),outline=(177,166,235),width=2); d.ellipse((22,19,36,33),fill=(240,236,255)); d.ellipse((38,12,43,17),fill=(150,231,255))
d.arc((8,14,48,40),195,345,fill=(205,196,255),width=2)
# Subtle orbital star field.
for x,y,r,c in [(58,12,1,(126,116,167)),(78,39,1,(94,88,123)),(113,14,1,(121,110,159)),(138,42,1,(98,91,130))]: d.ellipse((x-r,y-r,x+r,y+r),fill=c)
im.save(os.path.join(out,'installer-header.bmp'))
# Full welcome-page illustration (backing image): tall plum space illustration.
W,H=164,314
canvas=Image.new('RGB',(W,H),(18,17,25)); px=canvas.load()
for y in range(H):
 for x in range(W):
  dx=(x-W*.35)/(W*.95); dy=(y-H*.28)/(H*.8); glow=max(0,1-math.sqrt(dx*dx+dy*dy))**2
  px[x,y]=(int(18+36*glow),int(17+29*glow),int(25+63*glow))
d=ImageDraw.Draw(canvas)
d.ellipse((20,75,144,199),outline=(96,81,155),width=2)
d.ellipse((29,84,135,190),outline=(165,151,230),width=3)
d.arc((10,100,153,174),195,345,fill=(212,202,255),width=3)
d.ellipse((65,129,99,163),fill=(226,219,255));d.ellipse((101,103,111,113),fill=(117,205,239))
for x,y in [(26,52),(126,57),(135,224),(33,252),(92,45),(22,215),(111,260)]:
 d.ellipse((x-1,y-1,x+1,y+1),fill=(176,166,215))
canvas.save(os.path.join(out,'installer-sidebar.bmp'))
