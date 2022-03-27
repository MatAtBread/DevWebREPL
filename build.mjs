import html from 'minify/lib/html.js';
import js from 'minify/lib/js.js';
import fs from 'fs';
import { gzip } from 'zlib';
import { promisify } from 'util';

const devreplJs = fs.readFileSync('./build/devrepl.js').toString('utf-8');
const miniJs = await js(devreplJs);
const devReplHtml = fs.readFileSync('./devrepl.html').toString('utf-8').replace(/<script.*\/script>/,'<script>'+miniJs+'</script>');
const miniHtml = await html(devReplHtml);
fs.writeFileSync('./build/devrepl-min.html',miniHtml,{encoding: 'utf-8'})

const shrunk = await promisify(gzip)(Buffer.from(miniHtml));
fs.writeFileSync('./build/devrepl-min.html.gz',shrunk)

console.log("Minify:",{
    devreplJs: devreplJs.length,
    devReplHtml: devReplHtml.length,
    totalIn: devreplJs.length + devReplHtml.length,
    minifJs: miniJs.length,
    miniHtml: miniHtml.length,
    shrunk: shrunk.length,
    ratio: shrunk.length / (devreplJs.length + devReplHtml.length)
})