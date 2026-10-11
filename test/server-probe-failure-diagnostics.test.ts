import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import {functionCode,parseTypeScriptSource} from './support/source-contract.js';

const url=new URL('../src/server.ts',import.meta.url);
const source=functionCode(parseTypeScriptSource(url,readFileSync(url,'utf8')),'failProbeAttempt');
for(const terminal of [false,true]) test(`probe failure diagnostic identifies ${terminal?'exhaustion':'retry'} and retains effects`,()=>{
  const events:string[]=[];
  let diagnostic:any;
  const fail=vm.runInNewContext('(function(target,reason,nowMs)'+source.slice(source.indexOf('{'))+')',{
    bootProbeRuntime:{
      failAttempt:(target:string,reason:string,nowMs:number)=>{
        assert.equal(target,'mic');assert.equal(reason,'playback acknowledgement timed out');assert.equal(nowMs,123);
        events.push('fail');return terminal?{message:'failed'}:null;
      },
      status:()=>({attempts:{mic:terminal?3:1,backing:0},maxAttempts:3}),
    },
    console:{log:(tag:string,payload:string)=>{assert.equal(tag,'[probe-attempt-failed]');diagnostic=JSON.parse(payload);events.push('log');}},
    timingRuntime:{restoreCandidateKindToAuthority:()=>events.push('restore')},
    calibration:{failPreservingPrimed:(message:string)=>{assert.equal(message,'failed');events.push('terminal');}},
    broadcastJson:()=>events.push('broadcast'),timingCalibrationStatusPayload:()=>({}),
  });
  fail('mic','playback acknowledgement timed out',123);
  assert.deepEqual(diagnostic,{target:'mic',reason:'playback acknowledgement timed out',attempt:terminal?3:1,maxAttempts:3,terminal});
  assert.deepEqual(events,terminal?['fail','log','restore','terminal']:['fail','log','broadcast']);
});
