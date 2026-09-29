/**
 * #493: Offline ONLY. Feed actual AudioSession and write the exact same
 * positioned PCM event stream for the independent native Speex sidecar.
 * No changes to the live server or to AudioSession.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AudioSession } from '../../src/audio-session.js';

const RATE=48_000, OUT=process.argv[2];
if (!OUT) throw Error('usage: node --import tsx scripts/experiments/speex-positioned-fixtures.ts OUTPUT');
type Source='mic'|'backing';
type Event={source:Source;gen:number;rate:number;first:number;length:number;atMs:number;ppm:number};
type Scenario={id:string;source:Source;rows:Event[];trueGapSamples?:number};

function frames(source:Source,gen:number,rate:number,ms:number[],baseMs=0):Event[]{
  let first=0;
  return ms.map(duration=>{
    const length=Math.round(duration*rate/1000);
    const row={source,gen,rate,first,length,atMs:baseMs+(first+length)*1000/rate,ppm:0};
    first+=length;return row;
  });
}
function gap(source:Source,id:string):Scenario{
  const first=frames(source,23,44_100,[20,20,20]);
  const second=frames(source,23,44_100,[20,20,20]).map(e=>({
    ...e,first:e.first+4851,atMs:(e.first+4851+e.length)*1000/44_100,
  }));
  return {id,source,rows:[...first,...second],trueGapSamples:2400};
}
const patterns=[10,20,30,10,20,30,20,10];
const scenarios:Scenario[]=[
  {id:'mic-packet-150a',source:'mic',rows:frames('mic',7,44100,patterns)},
  {id:'mic-packet-150b',source:'mic',rows:frames('mic',7,44100,[30,30,30,30,30])},
  {id:'backing-packet-150',source:'backing',rows:frames('backing',7,44100,patterns)},
  gap('mic','mic-gap-50ms'),gap('backing','backing-gap-50ms'),
  {id:'mic-generation-restart',source:'mic',rows:[
    ...frames('mic',40,44100,[20,20,20]),
    ...frames('mic',41,44100,[20,20,20],1000),
  ]},
  {id:'mic-reused-gen-rate',source:'mic',rows:[
    ...frames('mic',42,48000,[20,20,20]),
    ...frames('mic',42,44100,[20,20,20],1000),
  ]},
  {id:'mic-ppm-steps',source:'mic',rows:Array.from({length:180},(_,i):Event=>({
    source:'mic',gen:70,rate:48000,first:i*960,length:960,atMs:(i+1)*20,
    ppm:i<45?0:i<90?200:i<135?-200:0,
  }))},
];
function pcmFor(e:Event):Buffer{
  const b=Buffer.alloc(e.length*2), sign=e.gen%2?1:-1;
  for(let i=0;i<e.length;i++){
    const t=(e.first+i)/e.rate;
    const value=sign*(8000*Math.sin(2*Math.PI*220*t)+2500*Math.sin(2*Math.PI*1980*t));
    b.writeInt16LE(Math.round(value),i*2);
  }
  return b;
}
await mkdir(path.join(OUT,'pcm'),{recursive:true});
const trace:string[]=[];
const summaries:unknown[]=[];
const samplesByCase=new Map<string,Int16Array>();
for(const scenario of scenarios){
  const session=new AudioSession({
    sampleRate:RATE,frameMs:20,prebufferMs:0,backingGain:1,retentionMs:10_000,
    backingRetentionMs:10_000,
  });
  session.setMicGainDb(0);
  if(scenario.source==='mic')session.setMicExpected(true);
  else session.setBackingExpected(true);
  session.start(0);
  const epoch=session.generation;
  let prev:Event|null=null,frontier=0;
  let gapInfo:null|{trueSamples:number;observedSamples:number;evidenceSamples:number;deferredTapDebt:number}=null;
  const observations=[];
  for(let i=0;i<scenario.rows.length;i++){
    const e=scenario.rows[i]!;
    const rel='pcm/'+scenario.id+'-'+String(i).padStart(3,'0')+'.pcm';
    const pcm=pcmFor(e);
    await writeFile(path.join(OUT,rel),pcm);
    trace.push([scenario.id,e.source,e.gen,e.rate,e.first,e.length,e.ppm,rel].join('\t'));
    const kind=prev===null?'initial':
      e.gen!==prev.gen?'generation':
      e.rate!==prev.rate?'rate':
      e.first!==prev.first+prev.length?'gap':'continuous';
    if(e.source==='mic')session.setMicClockTrimPpm(e.ppm);
    const res=e.source==='mic'
      ?session.ingestMic({generation:e.gen,firstSampleIndex:e.first,pcm},e.rate,e.atMs)
      :session.ingestBacking({generation:e.gen,firstSampleIndex:e.first,pcm},e.rate,e.atMs);
    assert.equal(res.captureRestarted,kind==='generation'||kind==='rate',
      scenario.id+' event '+i+' wrong restart: '+kind);
    assert.equal(session.generation,epoch,'source restart cannot reset the mix epoch');
    if(kind==='gap'){
      const trueSamples=Math.ceil(e.first*RATE/e.rate)-
        Math.ceil((prev!.first+prev!.length)*RATE/e.rate);
      const observedSamples=res.start-frontier;
      assert.equal(trueSamples,2400,'exact 50ms fixture expected');
      // The cubic path may defer one or two taps before a real gap. Report
      // interpolation debt separately from the 2,400 genuinely lost samples.
      assert.ok(observedSamples>=trueSamples&&observedSamples<=trueSamples+3,
        scenario.id+': source gap '+trueSamples+' observed '+observedSamples);
      const evidence=e.source==='mic'
        ?session.readMicEvidence(frontier,observedSamples)
        :session.readBackingEvidence(frontier,observedSamples);
      assert.equal(evidence.gapSamples,observedSamples,
        'no phantom valid PCM or hidden Take gap');
      gapInfo={
        trueSamples,observedSamples,evidenceSamples:evidence.gapSamples,
        deferredTapDebt:observedSamples-trueSamples,
      };
    }
    frontier=e.source==='mic'?session.micTotalSamples:session.backingTotalSamples;
    observations.push({
      event:i,kind,gen:e.gen,rate:e.rate,sourceFirst:e.first,length:e.length,
      ppm:e.ppm,sessionStart:res.start,acceptedSamples:res.samples.length,
      frontier,captureRestarted:res.captureRestarted,
      micTrimSamples:session.micClockTrimSamples,
    });
    prev=e;
  }
  if(scenario.trueGapSamples)assert.equal(gapInfo?.trueSamples,scenario.trueGapSamples);
  if(scenario.id.startsWith('mic-packet-150'))samplesByCase.set(scenario.id,session.readMic(0,frontier));
  if(scenario.id==='mic-ppm-steps'){
    assert.ok(observations.some(x=>x.micTrimSamples>=5),'positive correction not observed');
    assert.ok(observations.some(x=>x.micTrimSamples<=-1),'negative correction not observed');
  }
  summaries.push({
    id:scenario.id,source:scenario.source,epochPreserved:session.generation===epoch,
    restarts:observations.filter(x=>x.captureRestarted).length,
    gap:gapInfo,
    healthGapMs:scenario.source==='mic'?session.health().micGapMs:session.health().backingGapMs,
    frontier,observations,
  });
}
const a=samplesByCase.get('mic-packet-150a')!,b=samplesByCase.get('mic-packet-150b')!;
assert.equal(a.length,b.length,'variable packet sizing changed sample count');
for(let i=0;i<a.length;i++)assert.equal(a[i],b[i],
  'variable packet sizing changed baseline source sample '+i);
await writeFile(path.join(OUT,'events.tsv'),trace.join('\n')+'\n');
await writeFile(path.join(OUT,'baseline.json'),JSON.stringify({
  reference:'actual production AudioSession; no Speex in the server',
  outputRate:RATE,packetizationExactSamples:a.length,scenarios:summaries,
},null,2)+'\n');
console.log(JSON.stringify({
  packetizationExactSamples:a.length,
  scenarios:summaries.map((v:any)=>({
    id:v.id,source:v.source,events:v.observations.length,
    restarts:v.restarts,gap:v.gap,healthGapMs:v.healthGapMs,frontier:v.frontier,
  })),
},null,2));
