.syntax unified
.thumb
.cpu cortex-m33
.text
.global _start
_start:
 ldab r2,[r3]
 ldah r2,[r3]
 lda r2,[r3]
 stlb r2,[r3]
 stlh r2,[r3]
 stl r2,[r3]
 ldaexb r2,[r3]
 ldaexh r2,[r3]
 ldaex r2,[r3]
 stlexb r1,r2,[r3]
 stlexh r1,r2,[r3]
 stlex r1,r2,[r3]
 clrex
