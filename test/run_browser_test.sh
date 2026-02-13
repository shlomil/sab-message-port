#!/bin/sh
cd "$(dirname "$0")/.."
node -e "
const http = require('http');
const fs = require('fs');
const path = require('path');
const types = {'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript'};
http.createServer((req,res) => {
  const f = path.join('.', req.url === '/' ? '/test/test.html' : req.url);
  res.setHeader('Cross-Origin-Opener-Policy','same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy','require-corp');
  res.setHeader('Content-Type', types[path.extname(f)]||'text/plain');
  fs.createReadStream(f).on('error', () => { res.statusCode=404; res.end('Not found'); }).pipe(res);
}).listen(8000, () => console.log('http://localhost:8000/test/test.html'));
"
