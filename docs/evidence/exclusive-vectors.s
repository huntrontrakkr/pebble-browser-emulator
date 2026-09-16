.syntax unified
.thumb
.text
.global vectors
.thumb_func
vectors:
ldrex r1,[r0]
strex r3,r2,[r0]
ldrexb r1,[r0]
strexb r3,r2,[r0]
ldrexh r1,[r0]
strexh r3,r2,[r0]
ldaex r1,[r0]
stlex r3,r2,[r0]
ldaexb r1,[r0]
stlexb r3,r2,[r0]
ldaexh r1,[r0]
stlexh r3,r2,[r0]
lda r1,[r0]
stl r2,[r0]
ldab r1,[r0]
stlb r2,[r0]
ldah r1,[r0]
stlh r2,[r0]
clrex
mrs r4,psp
msr psp,r4
