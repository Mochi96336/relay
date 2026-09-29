/**
 * Compare actual AudioSession trace with isolated native Speex sidecar, using
 * identical PCM bytes and positioned event boundaries. Intentionally does
 * NOT equate an emitted native sample with a proven Take sample: native
 * filter delay must be explicitly quarantined and end debt reported.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root=process.argv[2];
if(!root)throw Error('usage: node scripts/experiments/check-speex-positioned.mjs OUTDIR');
const baseline=JSON.parse(await readFile(path.join(root,'baseline.json'),'utf8'));
const nativeName=process.argv[3]??'native.ndjson';
const reportName=process.argv[4]??'comparison.json';
if(!/^native(?:-q[358])?\.ndjson$/.test(nativeName)||!/^comparison(?:-q[358])?\.json$/.test(reportName))
  throw Error('invalid evidence filename');
const native=(await readFile(path.join(root,nativeName),'utf8'))
  .split('\n').filter(Boolean).map(line=>JSON.parse(line));
const RATE=48_000;
const tceil=(source,rate)=>Math.ceil(source*RATE/rate);
const verified=[];
const qualitySet=new Set(native.map(g=>g.quality));
assert.equal(qualitySet.size,1,'a single report must use one SRC quality');
for(const scenario of baseline.scenarios){
  const groups=native.filter(g=>g.scenario===scenario.id);
  const boundaryRows=scenario.observations.filter(x=>x.kind!=='continuous');
  assert.equal(groups.length,boundaryRows.length,
    scenario.id+': changed stream segmentation; never bridge real gaps/restarts');
  let wholeSampleCount=0;
  for(let i=0;i<groups.length;i++){
    const group=groups[i],row=boundaryRows[i];
    const nextBoundary=i+1<boundaryRows.length?boundaryRows[i+1].event:scenario.observations.length;
    const tail=scenario.observations[nextBoundary-1];
    assert.equal(group.source,scenario.source);
    assert.equal(group.firstSource,row.sourceFirst);
    assert.equal(group.endSource,tail.sourceFirst+tail.length);
    assert.equal(group.generation,row.gen);
    assert.equal(group.rate,row.rate);
    assert.equal(group.nominalFirstTarget,tceil(group.firstSource,group.rate));
    assert.equal(group.nominalEndTarget,tceil(group.endSource,group.rate));
    assert.equal(group.sourceSamples,group.endSource-group.firstSource);
    assert.ok(group.filterLatencySamples>=0&&group.filterLatencySamples<=1000,
      'filter latency must be explicitly known');
    assert.equal(group.startupQuarantined,
      Math.min(group.emittedSamples,group.filterLatencySamples));
    assert.equal(group.postLatencySamples,
      Math.max(0,group.emittedSamples-group.filterLatencySamples));
    const expectedKind=i===0?'first':row.kind;
    if(expectedKind==='first')assert.ok(['initial','new-scenario'].includes(group.reason));
    else assert.equal(group.reason,expectedKind);
    if(expectedKind==='gap'){
      assert.equal(group.trueGapTargetSamples,2400,
        'true source hole MUST remain 2400 distinct target positions');
      assert.equal(group.trueGapSourceSamples,2205);
      assert.equal(scenario.gap.trueSamples,2400);
      assert.equal(scenario.gap.evidenceSamples,scenario.gap.observedSamples,
        'actual AudioSession Take evidence must preserve gap');
    } else {
      assert.equal(group.trueGapSourceSamples,0,
        'candidate cannot fabricate an inter-generation source hole');
      assert.equal(group.trueGapTargetSamples,0);
    }
    if(group.ppmChanges===0){
      assert.ok(group.unfilledTargetEstimate>=-4 &&
        group.unfilledTargetEstimate<=group.filterLatencySamples+5,
        'native fixed-rate output/sample-count debt escapes reported delay');
    }else{
      assert.ok(Math.abs(group.emittedSamples-group.idealDynamicOutput)<
        group.filterLatencySamples+16,
        'variable ratio emitted sample count diverged beyond bounded SRC history');
    }
    wholeSampleCount+=group.emittedSamples;
  }
  assert.equal(scenario.epochPreserved,true,'real AudioSession mix epoch changed');
  verified.push({
    scenario:scenario.id,source:scenario.source,groups:groups.length,
    trueGapSamples:scenario.gap?.trueSamples??0,
    additionalDeferredCubicTaps:scenario.gap?.deferredTapDebt??0,
    nativeEmittedSamples:wholeSampleCount,
    knownFilterLatencySamples:groups.map(x=>x.filterLatencySamples),
    nativeUnfilledTargetEstimate:groups.map(x=>x.unfilledTargetEstimate),
  });
}
const groupFor=id=>native.filter(x=>x.scenario===id);
const p=groupFor('mic-packet-150a'),q=groupFor('mic-packet-150b');
assert.equal(p.length,1);assert.equal(q.length,1);
assert.equal(p[0].emittedSamples,q[0].emittedSamples,
  'stateful native packetization changes duration');
assert.equal(p[0].pcmHash,q[0].pcmHash,
  'stateful native packetization changes PCM at the same source timeline');
assert.ok(baseline.packetizationExactSamples>1000,
  'actual AudioSession control did not exercise interpacket cubic interpolation');
assert.ok(groupFor('mic-ppm-steps')[0].ppmChanges===3,
  'variable ppm must use rate updates WITHOUT resetting native SRC state');
// Both implementations read the exact same source PCM, but their
// stateful resampling and source-mapping execution layers differ. Here we
// separately score the *position* of stable voiced output at fixed 44.1k.
// This is a phase sanity check, NOT a comprehensive music quality verdict.
const pcmFrom=async rel=>{
  const bytes=await readFile(path.join(root,rel));
  assert.equal(bytes.length%2,0);
  return Int16Array.from({length:bytes.length/2},(_,i)=>bytes.readInt16LE(i*2));
};
const wav=pcm=>{
  const b=Buffer.alloc(44+pcm.length*2);
  b.write('RIFF',0);b.writeUInt32LE(b.length-8,4);
  b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);
  b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);
  b.writeUInt32LE(48000,24);b.writeUInt32LE(96000,28);
  b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);
  b.write('data',36);b.writeUInt32LE(pcm.length*2,40);
  for(let i=0;i<pcm.length;i++)b.writeInt16LE(pcm[i],44+i*2);
  return b;
};
const steadyBase=await pcmFrom('baseline-mic-packet-150a.pcm');
const steadyCandidate=await pcmFrom(p[0].pcmPath);
assert.equal(steadyCandidate.length,p[0].postLatencySamples,
  'native candidate audio length differs from delay-quarantined accounting');
// get_output_latency() returns an INTEGER group delay. It does not
// promise a phase-perfect source/sample origin for all fractional ratios.
// Quantify the residual fractional offset rather than silently declaring
// the filter output to be authoritative Take PCM.
function phaseFit(samples, group) {
  const stop=samples.length-250;
  assert.ok(stop>400,'group is too short to identify steady voiced phase');
  const signed=group.generation%2?1:-1;
  const errorAt=shift=>{
    let squared=0,n=0;
    for(let i=250;i<stop;i++){
      const t=(group.nominalFirstTarget+i+shift)/48000;
      const reference=signed*(8000*Math.sin(2*Math.PI*220*t)
        +2500*Math.sin(2*Math.PI*1980*t));
      squared+=(samples[i]-reference)**2;
      n++;
    }
    return Math.sqrt(squared/n);
  };
  const noShiftRms=errorAt(0);
  let best={fractionalSamples:0,rms:noShiftRms};
  for(let step=-200;step<=200;step++){
    const fractionalSamples=step/200;
    const rms=errorAt(fractionalSamples);
    if(rms<best.rms)best={fractionalSamples,rms};
  }
  assert.ok(best.rms<15,
    'even after offline fractional phase fitting, Speex is not consistent with positioned source time');
  return {comparedSamples:stop-250,integerDelayOnlyRms:noShiftRms,
    bestOfflineFractionalPhaseSamples:best.fractionalSamples,
    bestOfflinePhaseFitRms:best.rms};
}
const baseGroup=p[0];
const baselineFit=phaseFit(steadyBase,baseGroup);
const nativeFit=phaseFit(steadyCandidate,baseGroup);
const phaseSteadyTone={
  comparedSamples:Math.min(baselineFit.comparedSamples,nativeFit.comparedSamples),
  baselineCubicRms:baselineFit.integerDelayOnlyRms,
  nativeIntegerDelayRms:nativeFit.integerDelayOnlyRms,
  nativeBestOfflineFractionalOffsetSamples:nativeFit.bestOfflineFractionalPhaseSamples,
  nativeBestOfflineFitRms:nativeFit.bestOfflinePhaseFitRms,
  integrationBlockedUntilExactPhaseMapping:true,
};
const gapGroups=groupFor('mic-gap-50ms');
const gapBaseline=await pcmFrom('baseline-mic-gap-50ms.pcm');
const lastGapTarget=Math.max(gapBaseline.length,...gapGroups.map(g=>g.nominalEndTarget));
const gapCandidate=new Int16Array(lastGapTarget);
const gapPhaseFitting=[];
for(const g of gapGroups){
  const segment=await pcmFrom(g.pcmPath);
  assert.equal(segment.length,g.postLatencySamples);
  assert.ok(g.nominalFirstTarget+segment.length<=g.nominalEndTarget+4,
    'sidecar output crossed a segment boundary or fabricated the gap');
  gapCandidate.set(segment,g.nominalFirstTarget);
  gapPhaseFitting.push(phaseFit(segment,g));
}
assert.ok(Math.abs(gapPhaseFitting[0].bestOfflineFractionalPhaseSamples
  -gapPhaseFitting[1].bestOfflineFractionalPhaseSamples)<0.04,
  'a true packet gap changed the sidecar fractional phase beyond independent reset consistency');
const quality=[...qualitySet][0];
await writeFile(path.join(root,'candidate-mic-gap-q'+quality+'.wav'),wav(gapCandidate));
await writeFile(path.join(root,'baseline-mic-gap.wav'),wav(gapBaseline));
const report={
  conclusion:'Phase A trace contract passed: gaps are segmented and never merged, source coordinate mapping is explicit, native filter delay is quarantined in metrics. Production adapter NOT VALIDATED.',
  control:'Real unmodified AudioSession including Mic and Backing',
  candidate:'Independent native Speex library consuming exactly the same PCM files',
  packetizationExactBaselineSamples:baseline.packetizationExactSamples,
  packetizationBitExactNative:true,quality,
  phaseSteadyTone,gapPhaseFitting,
  syntheticGapPreview:'Zeros in candidate WAV include both true gap and deliberately quarantined unknown filter tail; this is not a candidate Take mix.',
  scenarios:verified,
  unresolved:[
    'Integer filter latency alone leaves a quality/ratio-dependent fractional sample phase; offline tone fitting is diagnostic and CANNOT act as a live correction.',
    'The per-group post-filter stream is not yet bound to AudioSession absolute output sample authority.',
    'Trailing delayed SRC output is not recovered/attributed at a source gap; reported unfilled target count must not be hidden.',
    'No actual Take candidate mix, source-gap declicking, realistic estimator uncertainty, or ARM profiling has passed.',
  ],
};
await writeFile(path.join(root,reportName),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
