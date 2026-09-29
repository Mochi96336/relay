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
const native=(await readFile(path.join(root,'native.ndjson'),'utf8'))
  .split('\n').filter(Boolean).map(line=>JSON.parse(line));
const RATE=48_000;
const tceil=(source,rate)=>Math.ceil(source*RATE/rate);
const verified=[];
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
const report={
  conclusion:'Phase A trace contract passed: gaps are segmented and never merged, source coordinate mapping is explicit, native filter delay is quarantined in metrics. Production adapter NOT VALIDATED.',
  control:'Real unmodified AudioSession including Mic and Backing',
  candidate:'Independent native Speex library consuming exactly the same PCM files',
  packetizationExactBaselineSamples:baseline.packetizationExactSamples,
  packetizationBitExactNative:true,
  scenarios:verified,
  unresolved:[
    'The per-group post-filter stream is not yet bound to AudioSession absolute output sample authority.',
    'Trailing delayed SRC output is not recovered/attributed at a source gap; reported unfilled target count must not be hidden.',
    'No actual Take candidate mix, source-gap declicking, realistic estimator uncertainty, or ARM profiling has passed.',
  ],
};
await writeFile(path.join(root,'comparison.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
