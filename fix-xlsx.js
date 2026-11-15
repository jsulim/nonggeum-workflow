const fs=require('fs');const p='server.js';let s=fs.readFileSync(p,'utf8');
let old="v=xmlText((c[2].match(/<v[^>]*>([\\s\\S]*?)<\\/v>/)||[])[1]);";
let neu="v=xmlText((c[2].match(/<v[^>]*>([\\s\\S]*?)<\\/v>/)||[])[1]||(c[2].match(/<is[^>]*>([\\s\\S]*?)<\\/is>/)||[])[1]);";
if(!s.includes(old))throw Error('parser target missing');fs.writeFileSync(p,s.replace(old,neu),'utf8');console.log('inline strings supported');
