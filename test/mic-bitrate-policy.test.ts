import assert from 'node:assert/strict';
import test from 'node:test';
import {MicBitratePolicy} from '../public/mic-bitrate-policy.js';
import {readFileSync} from 'node:fs';
import {Decoder} from '@evan/opus';
import {createOpusEncoder} from '../public/mic-opus-worker.js';
const healthy = {generation:1,path:'websocket',eligible:true,congestedRejects:0,audioBacklogMs:20,queueAgeMs:0,mixPlayable:true};
function observe(p:MicBitratePolicy,t:number,fields={}) {return p.observe({...healthy,nowMs:t,...fields});}
function raised() {const p=new MicBitratePolicy();for(let t=0;t<=60000;t+=1000)observe(p,t);assert.equal(p.status().bitrate,128000);return p;}

test('starts at 128k, recovers one step per 30 healthy seconds and resets to high quality',()=>{
 const p=new MicBitratePolicy();assert.equal(p.status().bitrate,128000);
 for(let t=0;t<=9000;t+=1000)observe(p,t,{audioBacklogMs:600});
 assert.equal(p.status().bitrate,32000);
 for(let t=10000;t<39000;t+=1000)observe(p,t);
 assert.equal(p.status().bitrate,32000);observe(p,39000);assert.equal(p.status().bitrate,64000);
 for(let t=40000;t<=69000;t+=1000)observe(p,t);assert.equal(p.status().bitrate,128000);
 p.reset();assert.deepEqual(p.status(),{bitrate:128000,reason:'startup'});
});
test('a single spike does not lower rate; sustained media backlog lowers in bounded steps',()=>{
 const p=raised();observe(p,61000,{audioBacklogMs:600});observe(p,62000);
 assert.equal(p.status().bitrate,128000);
 for(let t=63000;t<=65000;t+=1000)observe(p,t,{audioBacklogMs:600});
 assert.equal(p.status().bitrate,64000);
 for(let t=66000;t<=70000;t+=1000)observe(p,t,{audioBacklogMs:600});
 assert.equal(p.status().bitrate,32000);
 assert.equal(p.status().reason,'media-backlog');
});
test('fresh local congestion lowers rate even when server feedback is missing',()=>{
 const p=raised();for(let t=61000;t<=65000;t+=1000)observe(p,t,{audioBacklogMs:null,congestedRejects:t/1000});
 assert.equal(p.status().bitrate,64000);assert.equal(p.status().reason,'congestion');
});
test('unknown feedback, capture failure and historical drop totals cannot trigger recovery',()=>{
 for(const fields of [{audioBacklogMs:null},{mixPlayable:null},{eligible:false}]){
  const p=new MicBitratePolicy();for(let t=0;t<=70000;t+=1000)observe(p,t,fields);
  assert.equal(p.status().bitrate,128000);
 }
 const p=raised();for(let t=61000;t<=70000;t+=1000)observe(p,t,{congestedRejects:0,eligible:false,audioBacklogMs:5000});
 assert.equal(p.status().bitrate,128000);
});
test('source generation, media path and long polling gap restart observation windows',()=>{
 for(const boundary of [{generation:2},{path:'webtransport'},{}]){
  const p=new MicBitratePolicy();for(let t=0;t<=2000;t+=1000)observe(p,t,{audioBacklogMs:600});
  observe(p,Object.keys(boundary).length ? 3000 : 4000,{audioBacklogMs:600,...boundary});
  assert.equal(p.status().bitrate,128000);
 }
});
test('real Opus rate changes retain codec delay and continuous decoding',()=>{
 const encoder=createOpusEncoder(readFileSync(new URL('../node_modules/@evan/opus/wasm/opus.wasm',import.meta.url)));
 const decoder=new Decoder({sample_rate:48000,channels:1});const delay=encoder.delaySamples;let index=0;const decoded:Buffer[]=[];
 for(const rate of [32000,64000,128000,64000,32000]){
  encoder.setBitrate(rate);
  for(let frame=0;frame<4;frame++){
   const pcm=Int16Array.from({length:960},()=>Math.round(5000*Math.sin(index++*2*Math.PI*440/48000)));
   const packet=encoder.encode(pcm.buffer);assert.equal(packet.length,rate/8/50);
   const output=Buffer.from(decoder.decode(packet));assert.equal(output.byteLength,1920);decoded.push(output);
  }
  assert.equal(encoder.delaySamples,delay);
 }
 const audio=Buffer.concat(decoded);let dot=0,aa=0,bb=0;
 for(let i=960;i<audio.length/2;i++){const a=5000*Math.sin((i-delay)*2*Math.PI*440/48000),b=audio.readInt16LE(i*2);dot+=a*b;aa+=a*a;bb+=b*b;}
 assert.ok(dot/Math.sqrt(aa*bb)>0.95,'rate changes preserve waveform phase and sample coordinates');
});
test('a premixed song floor stops congestion at 64k',()=>{
 const p=new MicBitratePolicy();p.floor=64000;
 for(let t=0;t<=20000;t+=1000)observe(p,t,{audioBacklogMs:600});
 assert.equal(p.status().bitrate,64000);
});
