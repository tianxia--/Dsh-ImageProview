const fs=require('fs'),zlib=require('zlib');
function crcTable(){const t=[];for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;t[n]=c>>>0}return t}
const T=crcTable();
function crc32(buf){let c=0xFFFFFFFF;for(const b of buf)c=T[(c^b)&0xFF]^(c>>>8);return (c^0xFFFFFFFF)>>>0}
function chunk(type,data){const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const t=Buffer.from(type,'ascii');const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(Buffer.concat([t,data])));return Buffer.concat([len,t,data,crc])}
const W=360,H=200;
const raw=Buffer.alloc((W*3+1)*H);
for(let y=0;y<H;y++){
  raw[y*(W*3+1)]=0;
  for(let x=0;x<W;x++){
    const o=y*(W*3+1)+1+x*3;
    const band=Math.floor(y/(H/3));
    let r=32,g=38,b=48;
    if(band===0){r=0x1e;g=0x88;b=0xe5}
    else if(band===1){r=0x43;g=0xa0;b=0x47}
    else {r=0xfb;g=0x8c;b=0x00}
    // white diagonal + border so it is instantly recognizable as "the test image"
    if(Math.abs((x*H/W)-y)<8) {r=g=b=0xff}
    if(x<3||y<3||x>=W-3||y>=H-3){r=g=b=0xff}
    raw[o]=r;raw[o+1]=g;raw[o+2]=b;
  }
}
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(W,0);ihdr.writeUInt32BE(H,4);ihdr[8]=8;ihdr[9]=2;
const png=Buffer.concat([Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
fs.writeFileSync(process.argv[2],png);
console.log('wrote',process.argv[2],png.length,'bytes',W+'x'+H);
