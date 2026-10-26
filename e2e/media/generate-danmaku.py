#!/usr/bin/env python3
"""Danmaku fixture for e2e/danmaku.spec.ts (SPEC §13.2): B站 XML for the 30 s numbered ladder
(frames/hls-ladder). One comment every 0.5 s, text "#<n> <time>"; every 7th a top comment, every
11th a bottom one, every 13th reverse (B站 modes 1 / 5 / 4 / 6), colours cycling. Two advanced (7)
and one code (8) comment are skipped by the parser.
  python3 e2e/media/generate-danmaku.py > e2e/media/danmaku/ladder.xml"""
COLORS = [0xFFFFFF, 0xFE0302, 0xFFFF00, 0x00CD00, 0x4266BE, 0xCC0273]
print('<?xml version="1.0" encoding="UTF-8"?><i><chatserver>chat.bilibili.com</chatserver><chatid>0</chatid>')
for n in range(60):
    t = n * 0.5
    mode = 5 if n % 7 == 3 else 4 if n % 11 == 5 else 6 if n % 13 == 9 else 1
    print(f'<d p="{t:.3f},{mode},25,{COLORS[n % len(COLORS)]},1700000000,0,abcdef{n:02d},{1000 + n}">#{n} {t:.1f}s</d>')
print('<d p="5,7,25,16777215,1700000000,0,adv,2000">[0,0,"1-1",4,"advanced",0,0,0,0,1000,0,true,"SimHei",1]</d>')
print('<d p="6,7,25,16777215,1700000000,0,adv,2001">[10,10,"1-1",4,"advanced 2"]</d>')
print('<d p="7,8,25,16777215,1700000000,0,code,2002">var c=$.createCanvas({});</d>')
print('</i>')
